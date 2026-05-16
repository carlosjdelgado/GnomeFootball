// Diffs the current ESPN scoreboard/summary payload against the previously
// stored liveState snapshot, emitting one logical event per match transition.
//
// Returns:
//   { events: [ {type, eventId, ...payload} ], nextState: <updated snapshot> }

import { EVENT_TYPE, MATCH_STATE } from './constants.js';

function safeString(v) {
    return v == null ? '' : String(v);
}

function classifyPlayType(play) {
    // ESPN play.type.text is the most reliable field. Examples seen:
    //  - "Goal", "Penalty Goal", "Penalty - Scored"
    //  - "Yellow Card", "Red Card", "Yellow-Red Card", "Second Yellow Card"
    const text = safeString(play?.type?.text).toLowerCase();
    if (!text)
        return null;

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

function extractCompetitors(scoreboardEvent) {
    const competition = scoreboardEvent?.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    return competitors.map(c => ({
        id: String(c.id),
        homeAway: c.homeAway,
        name: c.team?.displayName ?? c.team?.shortDisplayName ?? '',
        abbreviation: c.team?.abbreviation ?? '',
        logo: c.team?.logo ?? c.team?.logos?.[0]?.href ?? '',
        score: Number(c.score ?? 0),
    }));
}

function homeAway(competitors) {
    const home = competitors.find(c => c.homeAway === 'home') ?? competitors[0];
    const away = competitors.find(c => c.homeAway === 'away') ?? competitors[1];
    return { home, away };
}

// Build a stable identifier for a play, since ESPN play IDs are sometimes missing.
function playKey(play) {
    return safeString(play?.id) ||
        `${safeString(play?.clock?.value)}|${safeString(play?.type?.id)}|${safeString(play?.team?.id)}|${playerNameFromPlay(play)}`;
}

export function detectEvents({ scoreboardEvent, summary, previousState, enabledEvents }) {
    const events = [];
    const eventId = String(scoreboardEvent.id);
    const status = scoreboardEvent.status ?? {};
    const statusType = status.type ?? {};
    const state = safeString(statusType.state).toLowerCase();
    const period = Number(status.period ?? 0);

    const competitors = extractCompetitors(scoreboardEvent);
    const { home, away } = homeAway(competitors);
    const leagueName = scoreboardEvent.leagueName ?? '';

    const prev = previousState ?? {
        state: null,
        period: 0,
        seenPlayIds: [],
        shootoutAnnounced: false,
        extraTimeAnnounced: false,
        halfTimeAnnounced: false,
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

    // --- Match state transitions -------------------------------------------

    if (state === MATCH_STATE.IN && prev.state !== MATCH_STATE.IN && enabledEvents[EVENT_TYPE.MATCH_START]) {
        events.push({ type: EVENT_TYPE.MATCH_START, ...baseEventPayload });
    }

    if (state === MATCH_STATE.POST && prev.state !== MATCH_STATE.POST && enabledEvents[EVENT_TYPE.MATCH_END]) {
        events.push({ type: EVENT_TYPE.MATCH_END, ...baseEventPayload });
    }

    // Halftime: ESPN exposes statusType.id === '23' or detail containing 'Halftime'/'HT'.
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

    // --- Play-level events (goals + cards) ---------------------------------

    const plays = summary?.plays ?? summary?.commentary ?? [];
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
        events.push({
            type: eventType,
            ...baseEventPayload,
            playMinute: minuteFromPlay(play),
            playerName: playerNameFromPlay(play),
            team,
        });
    }

    // --- Build next state ---------------------------------------------------

    const nextState = {
        state,
        period,
        homeScore: home?.score ?? 0,
        awayScore: away?.score ?? 0,
        seenPlayIds: Array.from(seenPlayIds),
        shootoutAnnounced: prev.shootoutAnnounced || isPenaltyShootout,
        extraTimeAnnounced: prev.extraTimeAnnounced || (period >= 3 && state === MATCH_STATE.IN),
        halfTimeAnnounced: prev.halfTimeAnnounced || isHalftime,
        lastUpdated: Math.floor(Date.now() / 1000),
    };

    return { events, nextState };
}

// Strip finished matches from the live state map a few hours after final whistle.
export function pruneLiveState(liveState, maxAgeSeconds = 6 * 60 * 60) {
    const now = Math.floor(Date.now() / 1000);
    const cleaned = {};
    for (const [eventId, snap] of Object.entries(liveState)) {
        if (snap.state === MATCH_STATE.POST && (now - (snap.lastUpdated ?? 0)) > maxAgeSeconds)
            continue;
        cleaned[eventId] = snap;
    }
    return cleaned;
}
