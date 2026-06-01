// Diffs the current upstream scoreboard/summary payload against the previously
// stored liveState snapshot, emitting one logical event per match transition.
//
// Returns:
//   { events: [ {type, eventId, ...payload} ], nextState: <updated snapshot> }

import { EVENT_TYPE, MATCH_STATE } from './constants.js';
import { pickLogo } from './theme.js';

function safeString(v) {
    return v == null ? '' : String(v);
}

function classifyPlayType(play) {
    // play.type.text is the most reliable field. Examples seen:
    //  - "Goal", "Penalty Goal", "Penalty - Scored"
    //  - "Yellow Card", "Red Card", "Yellow-Red Card", "Second Yellow Card"
    //  - "Substitution"
    const text = safeString(play?.type?.text).toLowerCase();
    if (!text)
        return null;

    if (text === 'substitution')
        return EVENT_TYPE.SUBSTITUTION;

    if (text.includes('red card') || text.includes('yellow-red'))
        return EVENT_TYPE.RED_CARD;
    if (text.includes('second yellow'))
        return EVENT_TYPE.RED_CARD;
    if (text.includes('yellow card'))
        return EVENT_TYPE.YELLOW_CARD;

    if (play?.scoringPlay === true || text.includes('goal'))
        return EVENT_TYPE.GOAL;

    return null;
}

function substitutionParticipants(play) {
    const participants = Array.isArray(play?.participants) ? play.participants : [];
    return {
        playerIn:  participants[0]?.athlete?.displayName ?? '',
        playerOut: participants[1]?.athlete?.displayName ?? '',
    };
}

function playerNameFromPlay(play) {
    const athletes = play?.athletesInvolved;
    if (Array.isArray(athletes) && athletes.length > 0) {
        return athletes[0].displayName ?? athletes[0].fullName ?? athletes[0].shortName ?? '';
    }
    return play?.participants?.[0]?.athlete?.displayName ?? '';
}

function teamFromPlay(play, competitors) {
    const teamId = play?.team?.id ?? play?.team?.$ref;
    if (!teamId)
        return null;
    const idStr = String(teamId).split('/').pop();
    return competitors.find(c => c.id === idStr) ?? null;
}

function minuteFromPlay(play) {
    return play?.clock?.displayValue ?? play?.clock?.value ?? '';
}

// The /summary endpoint returns significant moments in `keyEvents`, not `plays`
// (which is empty for soccer). Older or other-sport payloads may use `plays`,
// so accept both, with keyEvents preferred.
function extractPlays(summary) {
    if (Array.isArray(summary?.keyEvents) && summary.keyEvents.length > 0)
        return summary.keyEvents;
    if (Array.isArray(summary?.plays) && summary.plays.length > 0)
        return summary.plays;
    return [];
}

function extractCompetitors(scoreboardEvent) {
    const competition = scoreboardEvent?.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    return competitors.map(c => ({
        id: String(c.id),
        homeAway: c.homeAway,
        name: c.team?.displayName ?? c.team?.shortDisplayName ?? '',
        abbreviation: c.team?.abbreviation ?? '',
        logo: pickLogo(c.team?.logos) || c.team?.logo || '',
        score: Number(c.score ?? 0),
    }));
}

function homeAway(competitors) {
    const home = competitors.find(c => c.homeAway === 'home') ?? competitors[0];
    const away = competitors.find(c => c.homeAway === 'away') ?? competitors[1];
    return { home, away };
}

// Build a stable identifier for a play, since upstream play IDs are sometimes missing.
function playKey(play) {
    return safeString(play?.id) ||
        `${safeString(play?.clock?.value)}|${safeString(play?.type?.id)}|${safeString(play?.team?.id)}|${playerNameFromPlay(play)}`;
}

export function detectEvents({ scoreboardEvent, summary, previousState, enabledEvents, reminderLeadMinutes = 0 }) {
    const events = [];
    const eventId = String(scoreboardEvent.id);
    const status = scoreboardEvent.status ?? {};
    const statusType = status.type ?? {};
    const state = safeString(statusType.state).toLowerCase();
    const period = Number(status.period ?? 0);

    const competitors = extractCompetitors(scoreboardEvent);
    const { home, away } = homeAway(competitors);
    const leagueName = scoreboardEvent.leagueName ?? '';

    // Cold-start baseline: first time we see this match AND it's already past
    // kickoff. Absorb the snapshot silently so we don't spam the user with
    // events that happened before the extension was watching. Subsequent ticks
    // emit only deltas. Match-start, half-time, etc. fire normally when the
    // extension catches the match in PRE state first.
    if (previousState == null && (state === MATCH_STATE.IN || state === MATCH_STATE.POST)) {
        const isHalftime =
            safeString(statusType.id) === '23' ||
            safeString(statusType.shortDetail).toUpperCase() === 'HT' ||
            (safeString(statusType.detail).toLowerCase().includes('half') &&
             safeString(statusType.description).toLowerCase().includes('half'));
        const isPenaltyShootout =
            period >= 5 ||
            safeString(statusType.description).toLowerCase().includes('shootout') ||
            safeString(statusType.detail).toLowerCase().includes('shootout');

        const plays = extractPlays(summary);
        const baselinePlayIds = [];
        for (const play of plays) {
            if (classifyPlayType(play))
                baselinePlayIds.push(playKey(play));
        }

        console.debug(`[GnomeFootball] cold-start baseline ${eventId} (state=${state}, period=${period}, plays=${baselinePlayIds.length}) — suppressing catch-up notifications`);

        return {
            events: [],
            nextState: {
                state,
                period,
                homeScore: home?.score ?? 0,
                awayScore: away?.score ?? 0,
                seenPlayIds: baselinePlayIds,
                // Intentionally empty: we never notified the user about these
                // baseline goals (cold-start suppression), so we won't notify
                // about their cancellation either. seenGoals only tracks goals
                // we actually surfaced.
                seenGoals: {},
                shootoutAnnounced: isPenaltyShootout,
                extraTimeAnnounced: period >= 3,
                halfTimeAnnounced: isHalftime || period >= 2 || state === MATCH_STATE.POST,
                // Match already kicked off (or finished): a pre-match reminder
                // is moot, so mark it announced to avoid any late firing.
                reminderAnnounced: true,
                lastUpdated: Math.floor(Date.now() / 1000),
            },
        };
    }

    const prev = previousState ?? {
        state: null,
        period: 0,
        seenPlayIds: [],
        seenGoals: {},
        shootoutAnnounced: false,
        extraTimeAnnounced: false,
        halfTimeAnnounced: false,
        reminderAnnounced: false,
    };
    const seenPlayIds = new Set(prev.seenPlayIds ?? []);

    const baseEventPayload = {
        eventId,
        leagueSlug: scoreboardEvent.leagueSlug,
        leagueName,
        leagueLogo: scoreboardEvent.leagueLogo ?? '',
        home,
        away,
        homeScore: home?.score ?? 0,
        awayScore: away?.score ?? 0,
    };

    // --- Pre-match reminder -------------------------------------------------

    // Fires once when a not-yet-started match enters the lead-time window. The
    // poller widens its PRE watch window to the lead time, so the first tick
    // that tracks the match already satisfies the threshold. Kickoff time is
    // carried in the payload (the notification shows the time, not "in N min",
    // since polling granularity makes the exact remaining minutes fuzzy).
    let reminderFired = false;
    if (state === MATCH_STATE.PRE &&
        enabledEvents[EVENT_TYPE.MATCH_REMINDER] &&
        !prev.reminderAnnounced) {
        const startMs = Date.parse(safeString(scoreboardEvent.date));
        if (!isNaN(startMs)) {
            const minutesUntilStart = (startMs - Date.now()) / 60000;
            if (minutesUntilStart <= reminderLeadMinutes && minutesUntilStart > -2) {
                events.push({ type: EVENT_TYPE.MATCH_REMINDER, ...baseEventPayload, kickoffMs: startMs });
                reminderFired = true;
            }
        }
    }

    // --- Match state transitions -------------------------------------------

    if (state === MATCH_STATE.IN && prev.state !== MATCH_STATE.IN && enabledEvents[EVENT_TYPE.MATCH_START]) {
        events.push({ type: EVENT_TYPE.MATCH_START, ...baseEventPayload });
    }

    if (state === MATCH_STATE.POST && prev.state !== MATCH_STATE.POST && enabledEvents[EVENT_TYPE.MATCH_END]) {
        events.push({ type: EVENT_TYPE.MATCH_END, ...baseEventPayload });
    }

    // Halftime: upstream exposes statusType.id === '23' or detail containing 'Halftime'/'HT'.
    const isHalftime =
        safeString(statusType.id) === '23' ||
        safeString(statusType.shortDetail).toUpperCase() === 'HT' ||
        safeString(statusType.detail).toLowerCase().includes('half') && safeString(statusType.description).toLowerCase().includes('half');

    if (isHalftime && !prev.halfTimeAnnounced && enabledEvents[EVENT_TYPE.HALF_TIME_END]) {
        events.push({ type: EVENT_TYPE.HALF_TIME_END, ...baseEventPayload });
    }

    if (period === 2 && (prev.period ?? 0) < 2 && state === MATCH_STATE.IN && enabledEvents[EVENT_TYPE.SECOND_HALF_START]) {
        events.push({ type: EVENT_TYPE.SECOND_HALF_START, ...baseEventPayload });
    }

    if (period >= 3 && period <= 4 && !prev.extraTimeAnnounced && state === MATCH_STATE.IN && enabledEvents[EVENT_TYPE.EXTRA_TIME]) {
        events.push({ type: EVENT_TYPE.EXTRA_TIME, ...baseEventPayload });
    }

    const isPenaltyShootout =
        period >= 5 ||
        safeString(statusType.description).toLowerCase().includes('shootout') ||
        safeString(statusType.detail).toLowerCase().includes('shootout');

    if (isPenaltyShootout && !prev.shootoutAnnounced && enabledEvents[EVENT_TYPE.PENALTIES]) {
        events.push({ type: EVENT_TYPE.PENALTIES, ...baseEventPayload, shootoutKickoff: true });
    }

    // --- Play-level events (goals, cards, substitutions) -------------------

    const plays = extractPlays(summary);

    // Build the set of play keys present in this tick's payload. Used below to
    // detect goals that have *vanished* (i.e. been retracted by VAR or other).
    const currentPlayKeys = new Set();
    for (const play of plays) {
        if (classifyPlayType(play))
            currentPlayKeys.add(playKey(play));
    }

    // Goal-disallowed detection: any goal we previously notified that is no
    // longer in the current keyEvents AND whose team's score has dropped is
    // treated as cancelled. Goals still present are carried forward; vanished
    // ones are not (so we don't keep re-firing on every tick).
    const prevSeenGoals = (prev.seenGoals && typeof prev.seenGoals === 'object') ? prev.seenGoals : {};
    const prevHomeScore = Number(prev.homeScore ?? 0);
    const prevAwayScore = Number(prev.awayScore ?? 0);
    const currentHomeScore = home?.score ?? 0;
    const currentAwayScore = away?.score ?? 0;
    const nextSeenGoals = {};

    for (const [goalKey, info] of Object.entries(prevSeenGoals)) {
        if (currentPlayKeys.has(goalKey)) {
            nextSeenGoals[goalKey] = info;
            continue;
        }
        const scoreDropped =
            (info.teamSide === 'home' && currentHomeScore < prevHomeScore) ||
            (info.teamSide === 'away' && currentAwayScore < prevAwayScore);
        // Gated by the GOAL toggle on purpose: cancellations are part of the
        // same logical stream as goals from the user's point of view.
        if (scoreDropped && enabledEvents[EVENT_TYPE.GOAL]) {
            events.push({
                type: EVENT_TYPE.GOAL_DISALLOWED,
                ...baseEventPayload,
                playMinute: info.minute,
                playerName: info.playerName,
                team: info.teamSide === 'home' ? home : away,
            });
        }
    }

    for (const play of plays) {
        const eventType = classifyPlayType(play);
        if (!eventType)
            continue;
        const key = playKey(play);
        if (seenPlayIds.has(key))
            continue;
        seenPlayIds.add(key);

        if (!enabledEvents[eventType])
            continue;

        const team = teamFromPlay(play, competitors) ?? home;
        const playMinute = minuteFromPlay(play);

        if (eventType === EVENT_TYPE.SUBSTITUTION) {
            const { playerIn, playerOut } = substitutionParticipants(play);
            events.push({
                type: EVENT_TYPE.SUBSTITUTION,
                ...baseEventPayload,
                playMinute,
                playerIn,
                playerOut,
                team,
            });
        } else {
            const playerName = playerNameFromPlay(play);
            events.push({
                type: eventType,
                ...baseEventPayload,
                playMinute,
                playerName,
                team,
            });

            if (eventType === EVENT_TYPE.GOAL) {
                const teamSide =
                    team?.homeAway === 'home' ? 'home' :
                    team?.homeAway === 'away' ? 'away' : null;
                if (teamSide) {
                    nextSeenGoals[key] = {
                        teamSide,
                        playerName,
                        minute: playMinute,
                    };
                }
            }
        }
    }

    // --- Build next state ---------------------------------------------------

    const nextState = {
        state,
        period,
        homeScore: home?.score ?? 0,
        awayScore: away?.score ?? 0,
        seenPlayIds: Array.from(seenPlayIds),
        seenGoals: nextSeenGoals,
        shootoutAnnounced: prev.shootoutAnnounced || isPenaltyShootout,
        extraTimeAnnounced: prev.extraTimeAnnounced || (period >= 3 && state === MATCH_STATE.IN),
        halfTimeAnnounced: prev.halfTimeAnnounced || isHalftime,
        reminderAnnounced: prev.reminderAnnounced || reminderFired,
        lastUpdated: Math.floor(Date.now() / 1000),
    };

    return { events, nextState };
}

// Drop entries that haven't been touched in a while. Catches both finished
// matches that fell out of the scoreboard and orphans left behind by removed
// subscriptions. A live match keeps its entry as long as some subscribed
// scoreboard still lists it (each pass refreshes lastUpdated).
export function pruneLiveState(liveState, maxAgeSeconds = 2 * 60 * 60) {
    const now = Math.floor(Date.now() / 1000);
    const cleaned = {};
    for (const [eventId, snap] of Object.entries(liveState)) {
        if ((now - (snap.lastUpdated ?? 0)) > maxAgeSeconds)
            continue;
        cleaned[eventId] = snap;
    }
    return cleaned;
}
