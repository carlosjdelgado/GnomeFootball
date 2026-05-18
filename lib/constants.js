// Static catalog of soccer league slugs grouped by country / federation.
// Team rosters per league are discovered at runtime via the upstream /teams
// endpoint and cached on disk; only the league slugs themselves live here.

export const API_BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

export const USER_AGENT = 'GnomeFootball/1.0 (+https://github.com/carlosjdelgado/GnomeFootball)';

// 7 days in seconds — how long the league/team catalog is considered fresh.
export const CATALOG_TTL_SECONDS = 7 * 24 * 60 * 60;

// Country / federation groups for the preferences UI.
// `id` is used in translation keys (catalog_country_<id>).
export const COUNTRY_GROUPS = [
    {
        id: 'spain',
        defaultName: 'Spain',
        leagues: [
            { slug: 'esp.1',            defaultName: 'LaLiga' },
            { slug: 'esp.2',            defaultName: 'LaLiga 2' },
            { slug: 'esp.copa_del_rey', defaultName: 'Copa del Rey' },
            { slug: 'esp.super_cup',    defaultName: 'Supercopa de España' },
        ],
    },
    {
        id: 'england',
        defaultName: 'England',
        leagues: [
            { slug: 'eng.1',          defaultName: 'Premier League' },
            { slug: 'eng.2',          defaultName: 'Championship' },
            { slug: 'eng.3',          defaultName: 'League One' },
            { slug: 'eng.4',          defaultName: 'League Two' },
            { slug: 'eng.fa',         defaultName: 'FA Cup' },
            { slug: 'eng.league_cup', defaultName: 'EFL Cup' },
            { slug: 'eng.charity',    defaultName: 'FA Community Shield' },
        ],
    },
    {
        id: 'italy',
        defaultName: 'Italy',
        leagues: [
            { slug: 'ita.1',            defaultName: 'Serie A' },
            { slug: 'ita.2',            defaultName: 'Serie B' },
            { slug: 'ita.coppa_italia', defaultName: 'Coppa Italia' },
            { slug: 'ita.super_cup',    defaultName: 'Supercoppa Italiana' },
        ],
    },
    {
        id: 'france',
        defaultName: 'France',
        leagues: [
            { slug: 'fra.1',               defaultName: 'Ligue 1' },
            { slug: 'fra.2',               defaultName: 'Ligue 2' },
            { slug: 'fra.coupe_de_france', defaultName: 'Coupe de France' },
            { slug: 'fra.super_cup',       defaultName: 'Trophée des Champions' },
        ],
    },
    {
        id: 'portugal',
        defaultName: 'Portugal',
        leagues: [
            { slug: 'por.1',             defaultName: 'Primeira Liga' },
            { slug: 'por.taca.portugal', defaultName: 'Taça de Portugal' },
        ],
    },
    {
        id: 'germany',
        defaultName: 'Germany',
        leagues: [
            { slug: 'ger.1',         defaultName: 'Bundesliga' },
            { slug: 'ger.2',         defaultName: '2. Bundesliga' },
            { slug: 'ger.dfb_pokal', defaultName: 'DFB-Pokal' },
            { slug: 'ger.super_cup', defaultName: 'DFL-Supercup' },
        ],
    },
    {
        id: 'brazil',
        defaultName: 'Brazil',
        leagues: [
            { slug: 'bra.1',              defaultName: 'Brasileirão Série A' },
            { slug: 'bra.2',              defaultName: 'Brasileirão Série B' },
            { slug: 'bra.copa_do_brazil', defaultName: 'Copa do Brasil' },
        ],
    },
    {
        id: 'argentina',
        defaultName: 'Argentina',
        leagues: [
            { slug: 'arg.1',    defaultName: 'Liga Profesional' },
            { slug: 'arg.copa', defaultName: 'Copa Argentina' },
        ],
    },
    {
        id: 'usa',
        defaultName: 'United States',
        leagues: [
            { slug: 'usa.1',    defaultName: 'Major League Soccer' },
            { slug: 'usa.open', defaultName: 'US Open Cup' },
        ],
    },
    {
        id: 'uefa',
        defaultName: 'UEFA',
        leagues: [
            { slug: 'uefa.champions',   defaultName: 'UEFA Champions League' },
            { slug: 'uefa.europa',      defaultName: 'UEFA Europa League' },
            { slug: 'uefa.europa.conf', defaultName: 'UEFA Conference League' },
        ],
    },
    {
        id: 'conmebol',
        defaultName: 'CONMEBOL',
        leagues: [
            { slug: 'conmebol.libertadores', defaultName: 'CONMEBOL Libertadores' },
            { slug: 'conmebol.sudamericana', defaultName: 'CONMEBOL Sudamericana' },
            { slug: 'conmebol.recopa',       defaultName: 'Recopa Sudamericana' },
        ],
    },
    {
        id: 'concacaf',
        defaultName: 'CONCACAF',
        leagues: [
            { slug: 'concacaf.champions',   defaultName: 'CONCACAF Champions Cup' },
            // Leagues Cup runs in a short summer window; hide it out of season.
            { slug: 'concacaf.leagues.cup', defaultName: 'Leagues Cup', conditional: true },
        ],
    },
    {
        id: 'fifa',
        defaultName: 'FIFA',
        // World Cup and Club World Cup are hidden in the UI unless the
        // upstream API returns active events.
        leagues: [
            { slug: 'fifa.world', defaultName: 'FIFA World Cup',        conditional: true },
            { slug: 'fifa.cwc',   defaultName: 'FIFA Club World Cup',   conditional: true },
        ],
    },
];

export const ALL_LEAGUE_SLUGS = COUNTRY_GROUPS.flatMap(g => g.leagues.map(l => l.slug));

export function findLeagueMeta(slug) {
    for (const group of COUNTRY_GROUPS) {
        const league = group.leagues.find(l => l.slug === slug);
        if (league)
            return { group, league };
    }
    return null;
}

// Subscription modes.
export const SUBSCRIPTION_MODE = Object.freeze({
    ALL: 'all',
    TEAMS: 'teams',
});

// Event type identifiers used internally and as GSettings keys (prefixed with "event-").
export const EVENT_TYPE = Object.freeze({
    MATCH_START:        'match-start',
    GOAL:               'goal',
    GOAL_DISALLOWED:    'goal-disallowed',
    YELLOW_CARD:        'yellow-card',
    RED_CARD:           'red-card',
    SUBSTITUTION:       'substitution',
    HALF_TIME_END:      'half-time-end',
    SECOND_HALF_START:  'second-half-start',
    MATCH_END:          'match-end',
    EXTRA_TIME:         'extra-time',
    PENALTIES:          'penalties',
});

// User-toggleable event types, in display order. Bound to event-<key> GSettings
// and rendered as switches in prefs. GOAL_DISALLOWED is intentionally excluded
// — it shares the GOAL toggle (a goal and its later cancellation are one logical
// stream to the user).
export const ALL_EVENT_TYPES = Object.freeze([
    EVENT_TYPE.MATCH_START,
    EVENT_TYPE.GOAL,
    EVENT_TYPE.YELLOW_CARD,
    EVENT_TYPE.RED_CARD,
    EVENT_TYPE.SUBSTITUTION,
    EVENT_TYPE.HALF_TIME_END,
    EVENT_TYPE.SECOND_HALF_START,
    EVENT_TYPE.MATCH_END,
    EVENT_TYPE.EXTRA_TIME,
    EVENT_TYPE.PENALTIES,
]);

// status.type.state values returned by the upstream API.
export const MATCH_STATE = Object.freeze({
    PRE:  'pre',
    IN:   'in',
    POST: 'post',
});

// Pre-match window (minutes): matches starting within this window are
// included in the polling pass so we don't miss the kickoff notification.
export const PRE_MATCH_WATCH_WINDOW_MINUTES = 10;
