// Pure normalisation of a scoreboard event into a light "match view", free of GJS
// imports so it can be unit-tested with plain node (the dark/light logo choice
// comes in as `isDark`). Mirrors event-detector.js's competitor extraction rather
// than importing it, since that module is kept isolated against notification spam.

import { SUBSCRIPTION_MODE, findLeagueMeta } from './constants.js';

function safeString(v) {
    return v == null ? '' : String(v);
}

// Whether a subscription covers a match given its team ids: ALL mode matches
// every event in the league; TEAMS mode only those involving a selected team.
function passesSubscription(subscription, teamIds) {
    if (!subscription)
        return false;
    if (subscription.mode === SUBSCRIPTION_MODE.ALL)
        return true;
    if (subscription.mode === SUBSCRIPTION_MODE.TEAMS) {
        const wanted = new Set(subscription.teams ?? []);
        return wanted.size > 0 && teamIds.some(id => wanted.has(String(id)));
    }
    return false;
}

// Over a raw scoreboard event (poller); and over a normalised matchView (data
// layer's read-time re-filtering of cached / snapshot views).
export function matchPassesSubscription(scoreboardEvent, subscription) {
    const competitors = scoreboardEvent.competitions?.[0]?.competitors ?? [];
    return passesSubscription(subscription, competitors.map(c => c.id));
}

export function matchViewPassesSubscription(view, subscription) {
    return passesSubscription(subscription, [view.home?.id, view.away?.id]);
}

// Gio-free half of theme.pickLogo: best logo href for the current theme.
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

// A short, column-friendly team label. ESPN's `abbreviation` is usually a compact
// acronym we use verbatim, but some clubs arrive as a long spaced string that
// overflows the column; for those we derive a 3-letter acronym from the display
// name: initials of the significant words, padded from the last when fewer than three.
export function teamAbbrev(team) {
    const abbr = safeString(team?.abbreviation).trim();
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

// Local calendar-day key (YYYYMMDD) for a millisecond timestamp, in LOCAL time.
// The data layer fetches a UTC day±1 range and filters by this key.
export function localDateKey(ms) {
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// Normalise a scoreboard event into the panel's match view. `league` carries
// slug/name/logo resolved by the caller; `isDark` selects the team logo variant.
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

// Shared tiebreak: by kickoff time, then by id for stability.
function byKickoffThenId(a, b) {
    const ak = a.kickoffMs ?? Infinity;
    const bk = b.kickoffMs ?? Infinity;
    return ak !== bk ? ak - bk : a.eventId.localeCompare(b.eventId);
}

// Sort order for a day's matches: live first, then by kickoff, then by id.
export function compareMatchViews(a, b) {
    const liveRank = m => (m.state === 'in' ? 0 : 1);
    return (liveRank(a) - liveRank(b)) || byKickoffThenId(a, b);
}

// State group for ordering within a competition: live → played → upcoming.
function matchStateRank(state) {
    if (state === 'in')
        return 0;
    if (state === 'post')
        return 1;
    return 2;
}

// Compare two matches in the SAME competition: by state group, then kickoff.
export function compareWithinCompetition(a, b) {
    return (matchStateRank(a.state) - matchStateRank(b.state)) || byKickoffThenId(a, b);
}

// Group match views by competition. Groups with a live match come first, then
// the rest, each set alphabetical by commercial name (catalog defaultName, else
// leagueName, else slug). Returns [{ slug, name, logo, hasLive, matches }].
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
