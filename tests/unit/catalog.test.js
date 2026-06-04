// Unit tests for lib/catalog.js — run with: gjs -m tests/unit/catalog.test.js
// Covers the settings-backed cache layer (freshness TTL + read/write round-trip).
// The network-fetching half (refreshCatalog) needs a live API and is not tested.

import GLib from 'gi://GLib';

import { isCatalogFresh, readCatalog, writeCatalog } from '../../lib/catalog.js';
import { CATALOG_TTL_SECONDS } from '../../lib/constants.js';

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

// In-memory GSettings double covering only the keys catalog.js touches.
function fakeSettings(init = {}) {
    const store = { ...init };
    return {
        get_int64: k => store[k] ?? 0,
        set_int64: (k, v) => { store[k] = v; },
        get_string: k => store[k] ?? '',
        set_string: (k, v) => { store[k] = v; },
        _store: store,
    };
}

const nowS = Math.floor(GLib.get_real_time() / 1_000_000);

// --- isCatalogFresh ---------------------------------------------------------
print('isCatalogFresh');
{
    check('never-fetched-stale', isCatalogFresh(fakeSettings({ 'catalog-fetched-at': 0 })) === false);
    check('just-fetched-fresh', isCatalogFresh(fakeSettings({ 'catalog-fetched-at': nowS })) === true);
    check('expired-stale',
        isCatalogFresh(fakeSettings({ 'catalog-fetched-at': nowS - CATALOG_TTL_SECONDS - 100 })) === false);
}

// --- readCatalog ------------------------------------------------------------
print('readCatalog');
{
    const cat = { 'esp.1': { slug: 'esp.1', teams: [] } };
    eq('parses-json', readCatalog(fakeSettings({ 'catalog-cache-json': JSON.stringify(cat) })), cat);
    eq('empty-default', readCatalog(fakeSettings({})), {});
    eq('invalid-json-default', readCatalog(fakeSettings({ 'catalog-cache-json': '{not json' })), {});
}

// --- writeCatalog + round-trip ----------------------------------------------
print('writeCatalog');
{
    const settings = fakeSettings({});
    const cat = { 'eng.1': { slug: 'eng.1', teams: [{ id: '1', name: 'Arsenal' }] } };
    writeCatalog(settings, cat);

    eq('persisted-json', settings._store['catalog-cache-json'], JSON.stringify(cat));
    check('stamped-time', settings._store['catalog-fetched-at'] >= nowS);
    // What we wrote reads back unchanged.
    eq('round-trip', readCatalog(settings), cat);
    // And is fresh immediately after writing.
    check('fresh-after-write', isCatalogFresh(settings) === true);
}

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
