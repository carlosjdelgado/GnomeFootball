// Unit tests for lib/match-data.js — run with: gjs -m tests/unit/match-data.test.js
// MatchDataProvider takes an injectable fetchScoreboard, so the caching and
// read-time filtering logic is exercised without any network. The theme helpers
// run for real but are deterministic here: the fixtures carry no logos.

import { MatchDataProvider } from '../../lib/match-data.js';
import { localDateKey } from '../../lib/match-model.js';

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

// A scoreboard event whose kickoff is `kickoffMs`, with no logos so the theme
// helpers resolve deterministically.
function sbEvent(id, homeId, awayId, kickoffMs, state = 'pre') {
    return {
        id,
        date: new Date(kickoffMs).toISOString(),
        status: { type: { state } },
        competitions: [{
            competitors: [
                { id: homeId, homeAway: 'home', score: '0',
                  team: { displayName: `T${homeId}`, abbreviation: `T${homeId}`, logos: [] } },
                { id: awayId, homeAway: 'away', score: '0',
                  team: { displayName: `T${awayId}`, abbreviation: `T${awayId}`, logos: [] } },
            ],
        }],
    };
}

// Mutable settings double: subscriptions can change between calls, just like the
// real GSettings the provider re-reads on every getMatchesForDate.
function mutableSettings(subs) {
    let current = subs;
    return {
        get_string: k => (k === 'subscriptions-json' ? JSON.stringify(current) : ''),
        _set: s => { current = s; },
    };
}

// Fetch double returning canned events per slug and counting calls per slug.
function fetcher(bySlug) {
    const calls = {};
    const fetchScoreboard = async slug => {
        calls[slug] = (calls[slug] ?? 0) + 1;
        return { leagues: [{ name: slug.toUpperCase(), logos: [] }], events: bySlug[slug] ?? [] };
    };
    return { fetchScoreboard, calls };
}

// A future LOCAL day at noon (DST-safe) — never "today", so it always takes the
// fetch/cache path rather than the poller snapshot.
const now = new Date();
const future = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 5, 12, 0, 0);
const futureMs = future.getTime();
const otherDayMs = futureMs + 86400000; // next day, must be filtered out of `future`

async function main() {
    // --- fetch + ALL-mode subscription filter; off-day events excluded --------
    print('getMatchesForDate (fetch + filter)');
    {
        const { fetchScoreboard, calls } = fetcher({
            'esp.1': [
                sbEvent(1, 10, 11, futureMs, 'pre'),
                sbEvent(2, 12, 13, futureMs, 'in'),
                sbEvent(3, 14, 15, otherDayMs, 'pre'), // different local day → dropped
            ],
        });
        const settings = mutableSettings({ 'esp.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        const res = await p.getMatchesForDate(future, {});
        eq('keeps-only-that-day', res.map(v => v.eventId).sort(), ['1', '2']);
        eq('all-on-esp.1', res.every(v => v.leagueSlug === 'esp.1'), true);
        eq('fetched-once', calls['esp.1'], 1);
        // live (state 'in') sorts before pre.
        eq('sorted-live-first', res[0].eventId, '2');
    }

    // --- per-league cache: a second visit does not re-fetch -------------------
    print('per-league caching');
    {
        const { fetchScoreboard, calls } = fetcher({ 'esp.1': [sbEvent(1, 10, 11, futureMs)] });
        const settings = mutableSettings({ 'esp.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        await p.getMatchesForDate(future, {});
        await p.getMatchesForDate(future, {});
        eq('cached-second-visit', calls['esp.1'], 1);
    }

    // --- empty leagues are not cached (self-healing) --------------------------
    print('non-empty-only caching');
    {
        const { fetchScoreboard, calls } = fetcher({
            'esp.1': [sbEvent(1, 10, 11, futureMs)],
            'eng.1': [], // no fixture this day
        });
        const settings = mutableSettings({ 'esp.1': { mode: 'all' }, 'eng.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        await p.getMatchesForDate(future, {});
        await p.getMatchesForDate(future, {});
        eq('non-empty-cached', calls['esp.1'], 1);  // cached
        eq('empty-refetched', calls['eng.1'], 2);   // re-fetched
    }

    // --- read-time re-filter: a narrowed subscription drops cached views ------
    // without re-fetching (the cache stores leagues unfiltered).
    print('read-time re-filter');
    {
        const { fetchScoreboard, calls } = fetcher({ 'esp.1': [sbEvent(1, 10, 11, futureMs)] });
        const settings = mutableSettings({ 'esp.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        const first = await p.getMatchesForDate(future, {});
        eq('initially-shown', first.length, 1);

        // Switch esp.1 to a team the cached match doesn't involve.
        settings._set({ 'esp.1': { mode: 'teams', teams: ['999'] } });
        const second = await p.getMatchesForDate(future, {});
        eq('filtered-out', second.length, 0);
        eq('no-refetch-on-filter', calls['esp.1'], 1);
    }

    // --- today path: served from todayProvider, still subscription-filtered ----
    print('today via todayProvider');
    {
        const { fetchScoreboard, calls } = fetcher({});
        const settings = mutableSettings({ 'esp.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        const todayMs = Date.now();
        const todayProvider = () => ([
            { eventId: 'A', leagueSlug: 'esp.1', home: { id: '1' }, away: { id: '2' },
              kickoffMs: todayMs, state: 'pre' },
            { eventId: 'B', leagueSlug: 'fra.1', home: { id: '3' }, away: { id: '4' },
              kickoffMs: todayMs, state: 'pre' }, // not subscribed → dropped
        ]);
        const res = await p.getMatchesForDate(new Date(todayMs), { todayProvider });
        eq('today-keeps-subscribed', res.map(v => v.eventId), ['A']);
        eq('today-no-fetch', Object.keys(calls).length, 0);
    }

    // --- hasImmediateData ------------------------------------------------------
    print('hasImmediateData');
    {
        const { fetchScoreboard } = fetcher({ 'esp.1': [sbEvent(1, 10, 11, futureMs)] });
        const settings = mutableSettings({ 'esp.1': { mode: 'all' } });
        const p = new MatchDataProvider(settings, { fetchScoreboard });

        check('today-immediate', p.hasImmediateData(new Date()) === true);
        check('uncached-future-not-immediate', p.hasImmediateData(future) === false);

        await p.getMatchesForDate(future, {}); // caches esp.1 for that day
        check('cached-future-immediate', p.hasImmediateData(future) === true);

        settings._set({});
        check('no-subscriptions-immediate', p.hasImmediateData(future) === true);
    }
}

main().then(() => {
    print('');
    if (failures > 0) {
        print(`${failures} failure(s)`);
        imports.system.exit(1);
    } else {
        print('all tests passed');
    }
}).catch(e => {
    print(`ERROR ${e.message}\n${e.stack ?? ''}`);
    imports.system.exit(1);
});
