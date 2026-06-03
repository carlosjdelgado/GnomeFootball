// Unit tests for lib/match-model.js — run with: gjs -m tests/unit/match-model.test.js
// match-model.js is GJS/Gio-free on purpose, so this needs no shell environment.

import { toMatchView, localDateKey, compareMatchViews } from '../../lib/match-model.js';

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

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
