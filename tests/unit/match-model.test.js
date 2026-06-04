// Unit tests for lib/match-model.js — run with: gjs -m tests/unit/match-model.test.js
// match-model.js is GJS/Gio-free on purpose, so this needs no shell environment.

import {
    toMatchView,
    localDateKey,
    compareMatchViews,
    compareWithinCompetition,
    groupMatchesByCompetition,
    matchPassesSubscription,
    matchViewPassesSubscription,
    teamAbbrev,
} from '../../lib/match-model.js';

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`  ok   ${name}`);
    } else {
        print(`  FAIL ${name}`);
        failures++;
    }
}
function eq(name, got, want) {
    check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
        JSON.stringify(got) === JSON.stringify(want));
}

// --- localDateKey: uses LOCAL time, not UTC ---------------------------------
print('localDateKey');
{
    // Build a Date from local components and confirm the key echoes them back,
    // regardless of the machine's timezone (the whole point: local, not UTC).
    const local = new Date(2026, 4, 9, 23, 30, 0); // 9 May 2026 23:30 local
    eq('local-evening', localDateKey(local.getTime()), '20260509');

    const earlyLocal = new Date(2026, 0, 1, 0, 5, 0); // 1 Jan 2026 00:05 local
    eq('local-new-year', localDateKey(earlyLocal.getTime()), '20260101');

    // Zero-padding of month and day.
    const padded = new Date(2026, 2, 3, 12, 0, 0); // 3 Mar 2026
    eq('zero-pad', localDateKey(padded.getTime()), '20260303');
}

// --- toMatchView normalisation ----------------------------------------------
print('toMatchView');
{
    const sbEvent = {
        id: 401234567,
        date: '2026-05-09T19:00Z',
        status: { type: { state: 'in', shortDetail: "62'", detail: '62nd minute' } },
        competitions: [{
            competitors: [
                { id: 1, homeAway: 'home', score: '2',
                  team: { displayName: 'Real Madrid', abbreviation: 'RMA',
                          logos: [{ rel: ['default'], href: 'rma-light.png' },
                                  { rel: ['dark'], href: 'rma-dark.png' }] } },
                { id: 2, homeAway: 'away', score: '1',
                  team: { displayName: 'Barcelona', abbreviation: 'BAR', logos: [] } },
            ],
        }],
    };
    const view = toMatchView(sbEvent, { slug: 'esp.1', name: 'LaLiga', logo: 'laliga.png' });

    eq('eventId-is-string', view.eventId, '401234567');
    eq('league-slug', view.leagueSlug, 'esp.1');
    eq('league-name', view.leagueName, 'LaLiga');
    eq('home-name', view.home.name, 'Real Madrid');
    eq('away-name', view.away.name, 'Barcelona');
    eq('home-score', view.homeScore, 2);
    eq('away-score', view.awayScore, 1);
    eq('state', view.state, 'in');
    eq('status-detail', view.statusDetail, "62'");
    eq('kickoff-parsed', view.kickoffMs, Date.parse('2026-05-09T19:00Z'));

    // Logo variant follows isDark.
    const light = toMatchView(sbEvent, { slug: 'esp.1' }, false);
    eq('logo-light', light.home.logo, 'rma-light.png');
    const dark = toMatchView(sbEvent, { slug: 'esp.1' }, true);
    eq('logo-dark', dark.home.logo, 'rma-dark.png');
}

// --- toMatchView resilience to missing data ---------------------------------
print('toMatchView (sparse)');
{
    const view = toMatchView({ id: 5, status: {}, competitions: [] }, {});
    eq('no-kickoff', view.kickoffMs, null);
    eq('empty-state', view.state, '');
    eq('zero-scores', [view.homeScore, view.awayScore], [0, 0]);
}

// --- compareMatchViews: live first, then by kickoff -------------------------
print('compareMatchViews');
{
    const mk = (id, state, kickoffMs) => ({ eventId: String(id), state, kickoffMs });
    const list = [
        mk(1, 'pre', 3000),
        mk(2, 'in', 5000),
        mk(3, 'post', 1000),
        mk(4, 'pre', 2000),
    ];
    const sorted = [...list].sort(compareMatchViews).map(m => m.eventId);
    // live (2) first; then by kickoff among the rest: 3 (1000), 4 (2000), 1 (3000)
    eq('order', sorted, ['2', '3', '4', '1']);
}

// --- compareWithinCompetition: live -> played -> upcoming, then kickoff ------
print('compareWithinCompetition');
{
    const mk = (id, state, kickoffMs) => ({ eventId: String(id), state, kickoffMs });
    const list = [
        mk(1, 'pre', 1000),   // upcoming, earliest kickoff
        mk(2, 'post', 9000),  // played
        mk(3, 'in', 8000),    // live, later kickoff
        mk(4, 'in', 7000),    // live, earlier kickoff
        mk(5, 'post', 2000),  // played, earlier kickoff
    ];
    const sorted = [...list].sort(compareWithinCompetition).map(m => m.eventId);
    // live by kickoff (4 then 3), then played by kickoff (5 then 2), then pre (1)
    eq('order', sorted, ['4', '3', '5', '2', '1']);
}

// --- groupMatchesByCompetition: live comps first, then alphabetical ----------
print('groupMatchesByCompetition');
{
    // leagueName here is the ESPN name; the grouping must override it with the
    // catalog's commercial defaultName (esp.1 -> "LaLiga", etc.).
    const mk = (id, slug, state, kickoffMs) => ({
        eventId: String(id), leagueSlug: slug, leagueName: `espn-${slug}`,
        leagueLogo: `${slug}.png`, state, kickoffMs,
    });
    const list = [
        mk(1, 'esp.1', 'pre', 3000),
        mk(2, 'esp.1', 'in', 5000),
        mk(3, 'esp.1', 'post', 1000),
        mk(4, 'ita.1', 'in', 2000),     // Serie A: has live
        mk(5, 'eng.1', 'post', 4000),   // Premier League: no live
        mk(6, 'eng.1', 'pre', 6000),
    ];
    const groups = groupMatchesByCompetition(list);

    // Live competitions first (alphabetical: LaLiga < Serie A), then the rest
    // (Premier League).
    eq('group-order', groups.map(g => g.name), ['LaLiga', 'Serie A', 'Premier League']);
    eq('commercial-name', groups[0].name, 'LaLiga'); // not "espn-esp.1"
    eq('hasLive-flags', groups.map(g => g.hasLive), [true, true, false]);
    eq('group-logo', groups[0].logo, 'esp.1.png');

    // Within LaLiga: live (2) -> played (3) -> upcoming (1).
    eq('within-laliga', groups[0].matches.map(m => m.eventId), ['2', '3', '1']);
    // Within Premier League: played (5) -> upcoming (6).
    eq('within-epl', groups[2].matches.map(m => m.eventId), ['5', '6']);
}

// --- matchPassesSubscription: same rules over a raw scoreboard event ---------
print('matchPassesSubscription');
{
    const event = { competitions: [{ competitors: [{ id: 1 }, { id: 2 }] }] };

    check('no-subscription', matchPassesSubscription(event, undefined) === false);
    check('all-mode', matchPassesSubscription(event, { mode: 'all' }) === true);
    // Team ids are coerced to strings before comparing.
    check('teams-match',
        matchPassesSubscription(event, { mode: 'teams', teams: ['2'] }) === true);
    check('teams-no-match',
        matchPassesSubscription(event, { mode: 'teams', teams: ['99'] }) === false);
    check('teams-empty',
        matchPassesSubscription(event, { mode: 'teams', teams: [] }) === false);
    // No competitors → nothing to match.
    check('no-competitors',
        matchPassesSubscription({ competitions: [] }, { mode: 'teams', teams: ['1'] }) === false);
}

// --- matchViewPassesSubscription: re-filter a view by current subscription ---
print('matchViewPassesSubscription');
{
    const view = { leagueSlug: 'esp.1', home: { id: '1' }, away: { id: '2' } };

    // No subscription for the league -> filtered out (the unsubscribe case).
    check('no-subscription', matchViewPassesSubscription(view, undefined) === false);

    // ALL mode keeps every match in the league.
    check('all-mode', matchViewPassesSubscription(view, { mode: 'all' }) === true);

    // TEAMS mode keeps a match only when one of its teams is selected.
    check('teams-home-match',
        matchViewPassesSubscription(view, { mode: 'teams', teams: ['1'] }) === true);
    check('teams-away-match',
        matchViewPassesSubscription(view, { mode: 'teams', teams: ['2'] }) === true);
    check('teams-no-match',
        matchViewPassesSubscription(view, { mode: 'teams', teams: ['99'] }) === false);
    check('teams-empty',
        matchViewPassesSubscription(view, { mode: 'teams', teams: [] }) === false);
}

// --- teamAbbrev: clean ESPN acronyms verbatim, derive 3 letters otherwise ---
print('teamAbbrev');
{
    // A compact ≤4-char acronym from ESPN is used as-is (upper-cased).
    eq('clean-3', teamAbbrev({ abbreviation: 'OHI', name: "O'Higgins" }), 'OHI');
    eq('clean-4', teamAbbrev({ abbreviation: 'CDUC', name: 'Universidad Católica' }), 'CDUC');
    eq('clean-lower', teamAbbrev({ abbreviation: 'UdeC', name: 'Universidad de Concepción' }), 'UDEC');
    eq('clean-accent', teamAbbrev({ abbreviation: 'ÑUB', name: 'Ñublense' }), 'ÑUB');

    // Digit/symbol acronyms are recognised shorthand — kept verbatim, NOT derived
    // from the name (these are short enough to fit and are how fans know them).
    eq('digits-b04', teamAbbrev({ abbreviation: 'B04', name: 'Bayer Leverkusen' }), 'B04');
    eq('digits-s04', teamAbbrev({ abbreviation: 'S04', name: 'Schalke 04' }), 'S04');
    eq('digits-rso2', teamAbbrev({ abbreviation: 'RSO2', name: 'Real Sociedad II' }), 'RSO2');
    eq('symbol-om', teamAbbrev({ abbreviation: 'O&M', name: 'Universidad O&M' }), 'O&M');

    // A bare club name dropped into `abbreviation` (no spaces but >4) → derived.
    eq('bare-name', teamAbbrev({ abbreviation: 'Manauara', name: 'Manauara' }), 'MAN');

    // The motivating case: ESPN's long, spaced abbreviation is replaced by a
    // 3-letter acronym derived from the display name. "de" is a stopword, and
    // the pad letter comes from the LAST significant word (Chile → H), so it is
    // "UCH", not the colliding "UCN".
    eq('chile-derived', teamAbbrev({ abbreviation: 'U. de Chile', name: 'Universidad de Chile' }), 'UCH');

    // Long abbreviation but a single significant word → pad from that word.
    eq('single-word-pad', teamAbbrev({ abbreviation: 'Cobresal FC', name: 'Cobresal' }), 'COB');

    // Three significant words → first initials, no padding needed.
    eq('three-words', teamAbbrev({ abbreviation: 'Paris Saint Germain', name: 'Paris Saint-Germain' }), 'PSG');

    // Falls back gracefully when there's nothing to work with.
    eq('empty', teamAbbrev({ abbreviation: '', name: '' }), '');
    eq('name-only', teamAbbrev({ name: 'Real Madrid' }), 'RMA');
}

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
