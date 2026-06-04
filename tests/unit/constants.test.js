// Unit tests for lib/constants.js — run with: gjs -m tests/unit/constants.test.js
// Pure catalog data + helpers; guards against typos/duplicates in the league list.

import {
    COUNTRY_GROUPS,
    ALL_LEAGUE_SLUGS,
    findLeagueMeta,
    SUBSCRIPTION_MODE,
    EVENT_TYPE,
} from '../../lib/constants.js';

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

// --- findLeagueMeta ---------------------------------------------------------
print('findLeagueMeta');
{
    const meta = findLeagueMeta('esp.1');
    eq('group-id', meta?.group?.id, 'spain');
    eq('league-name', meta?.league?.defaultName, 'LaLiga');
    eq('unknown-slug', findLeagueMeta('does.not.exist'), null);

    // Every catalogued slug must resolve, and to the same slug it was queried by.
    const allResolve = ALL_LEAGUE_SLUGS.every(s => findLeagueMeta(s)?.league?.slug === s);
    check('every-slug-resolves', allResolve);
}

// --- catalog integrity ------------------------------------------------------
print('catalog integrity');
{
    // ALL_LEAGUE_SLUGS is the flat list of every group's leagues.
    const flat = COUNTRY_GROUPS.flatMap(g => g.leagues.map(l => l.slug));
    eq('flat-count', ALL_LEAGUE_SLUGS.length, flat.length);

    // No duplicate slugs across the whole catalog.
    eq('no-duplicate-slugs', new Set(ALL_LEAGUE_SLUGS).size, ALL_LEAGUE_SLUGS.length);

    // Every league has a non-empty slug and defaultName; every group an id.
    const wellFormed = COUNTRY_GROUPS.every(g =>
        g.id && g.defaultName &&
        g.leagues.every(l => l.slug && l.defaultName));
    check('well-formed-entries', wellFormed);
}

// --- frozen enums -----------------------------------------------------------
print('frozen enums');
{
    check('subscription-mode-frozen', Object.isFrozen(SUBSCRIPTION_MODE));
    check('event-type-frozen', Object.isFrozen(EVENT_TYPE));
    // Event type identifiers are unique (they double as GSettings keys).
    const values = Object.values(EVENT_TYPE);
    eq('event-types-unique', new Set(values).size, values.length);
}

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
