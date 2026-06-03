// Shared, read-only normalisation of an upstream scoreboard event into a light
// "match view" object used by the calendar panel (Feature 1) and its date-aware
// data layer. Kept free of any GNOME/GJS imports so it can be unit-tested with
// plain node.
//
// This intentionally mirrors the competitor extraction in event-detector.js
// rather than importing from it: the detector is sensitive code (a change there
// can cause notification spam), so the panel keeps its own pure copy. It also
// keeps free of any GJS imports (theme.js pulls in Gio) so it stays unit-testable
// under plain node — the dark/light logo choice comes in as an `isDark` argument.

import { SUBSCRIPTION_MODE } from './constants.js';

function safeString(v) {
    return v == null ? '' : String(v);
}

// Whether a scoreboard event belongs to a subscription: ALL mode matches every
// event in the league; TEAMS mode matches only events involving a selected team.
// Pure (no GJS); shared by the poller (notifications + snapshot) and the panel's
// date layer so the panel shows exactly what the user would be notified about.
export function matchPassesSubscription(scoreboardEvent, subscription) {
    if (!subscription)
        return false;
    if (subscription.mode === SUBSCRIPTION_MODE.ALL)
        return true;
    if (subscription.mode === SUBSCRIPTION_MODE.TEAMS) {
        const teamIds = new Set(subscription.teams ?? []);
        if (teamIds.size === 0)
            return false;
        const competitors = scoreboardEvent.competitions?.[0]?.competitors ?? [];
        return competitors.some(c => teamIds.has(String(c.id)));
    }
    return false;
}

// Pure logo-variant picker (the Gio-free half of theme.pickLogo): given ESPN's
// logos array and whether the shell is in dark mode, return the best href.
function pickLogoVariant(logos, isDark) {
    if (!Array.isArray(logos) || logos.length === 0)
        return '';
    const wanted = isDark ? 'dark' : 'default';
    const match = logos.find(l => Array.isArray(l?.rel) && l.rel.includes(wanted));
    return match?.href ?? logos[0]?.href ?? '';
}

function extractCompetitors(scoreboardEvent, isDark) {
    const competition = scoreboardEvent?.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    return competitors.map(c => ({
        id: String(c.id),
        homeAway: c.homeAway,
        name: c.team?.displayName ?? c.team?.shortDisplayName ?? '',
        abbreviation: c.team?.abbreviation ?? '',
        logo: pickLogoVariant(c.team?.logos, isDark) || c.team?.logo || '',
        score: Number(c.score ?? 0),
    }));
}

function homeAway(competitors) {
    const home = competitors.find(c => c.homeAway === 'home') ?? competitors[0];
    const away = competitors.find(c => c.homeAway === 'away') ?? competitors[1];
    return { home, away };
}

// Local calendar-day key (YYYYMMDD) for a millisecond timestamp, in the user's
// LOCAL timezone — not UTC. ESPN's scoreboard date parameter is UTC, so the
// panel's date layer fetches a day±1 range and filters by this key to land on
// the correct local day. Uses only standard Date getters (local time), so it
// behaves identically under GJS and node.
export function localDateKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// Normalise a single scoreboard event into the panel's match view. `league`
// carries slug/name/logo already resolved by the caller (poller or date layer).
// `isDark` selects the team logo variant (caller passes theme.isDarkTheme()).
export function toMatchView(scoreboardEvent, league = {}, isDark = false) {
    const status = scoreboardEvent?.status ?? {};
    const statusType = status.type ?? {};
    const competitors = extractCompetitors(scoreboardEvent, isDark);
    const { home, away } = homeAway(competitors);
    const kickoffMs = Date.parse(safeString(scoreboardEvent?.date));

    return {
        eventId: String(scoreboardEvent?.id ?? ''),
        leagueSlug: league.slug ?? scoreboardEvent?.leagueSlug ?? '',
        leagueName: league.name ?? scoreboardEvent?.leagueName ?? '',
        leagueLogo: league.logo ?? scoreboardEvent?.leagueLogo ?? '',
        home,
        away,
        homeScore: home?.score ?? 0,
        awayScore: away?.score ?? 0,
        state: safeString(statusType.state).toLowerCase(),
        statusDetail: safeString(statusType.shortDetail || statusType.detail),
        kickoffMs: isNaN(kickoffMs) ? null : kickoffMs,
    };
}

// Sort order for a day's matches: live first, then by kickoff time, then by id
// for stability. (Roadmap leaves the exact order open; this is the starting
// choice.)
export function compareMatchViews(a, b) {
    const liveRank = m => (m.state === 'in' ? 0 : 1);
    const byLive = liveRank(a) - liveRank(b);
    if (byLive !== 0)
        return byLive;
    const ak = a.kickoffMs ?? Infinity;
    const bk = b.kickoffMs ?? Infinity;
    if (ak !== bk)
        return ak - bk;
    return a.eventId.localeCompare(b.eventId);
}
