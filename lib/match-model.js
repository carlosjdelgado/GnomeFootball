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

import { SUBSCRIPTION_MODE, findLeagueMeta } from './constants.js';

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

// Same subscription test as matchPassesSubscription, but over an already
// normalised matchView (leagueSlug + home/away ids) rather than a raw scoreboard
// event. Used by the panel's date layer to re-filter cached / snapshot views
// against the CURRENT subscriptions at read time, so a day cached while a league
// was subscribed never keeps showing it after the user unsubscribes.
export function matchViewPassesSubscription(view, subscription) {
    if (!subscription)
        return false;
    if (subscription.mode === SUBSCRIPTION_MODE.ALL)
        return true;
    if (subscription.mode === SUBSCRIPTION_MODE.TEAMS) {
        const teamIds = new Set(subscription.teams ?? []);
        if (teamIds.size === 0)
            return false;
        return teamIds.has(String(view.home?.id)) || teamIds.has(String(view.away?.id));
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

// Words that carry no identifying value when deriving an acronym from a club's
// full name (Spanish + common football affixes).
const ABBREV_STOPWORDS = new Set([
    'de', 'del', 'la', 'el', 'los', 'las', 'y',
    'fc', 'cf', 'cd', 'sc', 'ac', 'club', 'deportivo', 'deportes', 'social',
]);

// A short, column-friendly label for a team. ESPN's `abbreviation` is usually a
// compact 2-4 character acronym we can use verbatim — including digit/symbol
// forms that are the club's recognised shorthand (Bayer Leverkusen → "B04",
// Schalke 04 → "S04", Real Sociedad II → "RSO2", Universidad O&M → "O&M"). But
// it is inconsistent: some clubs come through as a long, spaced string (e.g.
// Universidad de Chile → "U. de Chile", or the bare club name "Manauara") that
// overflows the narrow DateMenu column and gets ellipsized. For those we derive
// a 3-letter acronym from the full display name: the initials of the significant
// words, padded from the LAST significant word (the distinctive one) when fewer
// than three — "Universidad de Chile" → "UCH", not the colliding "UCN". Pure (no
// GJS). The "clean" test is length + no whitespace (whitespace, not digits, is
// what signals a full name rather than an acronym).
export function teamAbbrev(team) {
    const abbr = safeString(team?.abbreviation).trim();
    // Compact acronym from ESPN (≤4 chars, no spaces) → use as-is.
    if (abbr && abbr.length <= 4 && !/\s/.test(abbr))
        return abbr.toUpperCase();

    const source = safeString(team?.name) || abbr;
    const words = source.split(/[^\p{L}]+/u).filter(Boolean);
    if (words.length === 0)
        return abbr.toUpperCase();
    let significant = words.filter(w => !ABBREV_STOPWORDS.has(w.toLowerCase()));
    if (significant.length === 0)
        significant = words;

    let acronym = significant.map(w => w[0]).join('').toUpperCase().slice(0, 3);
    if (acronym.length < 3) {
        const last = significant[significant.length - 1].toUpperCase();
        for (const ch of last.slice(1)) {
            if (acronym.length >= 3)
                break;
            acronym += ch;
        }
    }
    return acronym.slice(0, 3);
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

// State group for ordering matches WITHIN a competition: live matches first,
// then ones already played, then ones still to be played.
function matchStateRank(state) {
    if (state === 'in')
        return 0;   // in progress
    if (state === 'post')
        return 1;   // already played
    return 2;       // 'pre' (upcoming) or unknown
}

// Compare two matches that belong to the SAME competition: by state group
// (live → played → upcoming), then kickoff ascending, then id for stability.
export function compareWithinCompetition(a, b) {
    const byState = matchStateRank(a.state) - matchStateRank(b.state);
    if (byState !== 0)
        return byState;
    const ak = a.kickoffMs ?? Infinity;
    const bk = b.kickoffMs ?? Infinity;
    if (ak !== bk)
        return ak - bk;
    return a.eventId.localeCompare(b.eventId);
}

// Group a flat list of match views by competition and order both the groups
// and the matches inside them per the panel's display rules:
//   - competitions with at least one live match come first; the rest follow.
//     Each set is ordered alphabetically by the (commercial) competition name.
//   - within a competition: live → played → upcoming, each by kickoff ascending.
// The commercial name is taken from the static catalog (findLeagueMeta ->
// defaultName), falling back to the match's own leagueName, then the slug.
// Returns an ordered array of { slug, name, logo, hasLive, matches }.
export function groupMatchesByCompetition(matches) {
    const groups = new Map();
    for (const m of matches) {
        const slug = m.leagueSlug || '';
        let group = groups.get(slug);
        if (!group) {
            const meta = findLeagueMeta(slug);
            const name = meta?.league?.defaultName || m.leagueName || slug;
            group = { slug, name, logo: m.leagueLogo || '', hasLive: false, matches: [] };
            groups.set(slug, group);
        }
        group.matches.push(m);
        if (m.state === 'in')
            group.hasLive = true;
    }

    const ordered = [...groups.values()];
    for (const group of ordered)
        group.matches.sort(compareWithinCompetition);
    ordered.sort((a, b) => {
        if (a.hasLive !== b.hasLive)
            return a.hasLive ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return ordered;
}
