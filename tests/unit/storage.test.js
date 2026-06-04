// Unit tests for lib/storage.js — run with: gjs -m tests/unit/storage.test.js
// Exercises the real JSON read/write round-trip and the missing-file fallback,
// using a uniquely-named scratch file under the data dir that is deleted after.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { readJson, writeJson } from '../../lib/storage.js';

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

const SCRATCH = 'unit-test-scratch.json';

function scratchFile() {
    return Gio.File.new_for_path(
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnomefootball', SCRATCH]));
}

async function main() {
    // --- missing file → fallback --------------------------------------------
    print('readJson (missing)');
    {
        const fb = await readJson('definitely-not-a-real-file.json', { fallback: true });
        eq('returns-fallback', fb, { fallback: true });
    }

    // --- write then read round-trip -----------------------------------------
    print('writeJson + readJson round-trip');
    {
        const payload = { a: 1, b: ['x', 'y'], nested: { ok: true } };
        const wrote = await writeJson(SCRATCH, payload);
        check('write-ok', wrote === true);
        const back = await readJson(SCRATCH);
        eq('round-trip', back, payload);
    }

    // --- overwrite replaces previous content --------------------------------
    print('writeJson overwrite');
    {
        await writeJson(SCRATCH, { v: 2 });
        const back = await readJson(SCRATCH);
        eq('overwritten', back, { v: 2 });
    }
}

// storage.js uses real GIO async file I/O, which only completes while a GLib main
// loop is iterating — so drive one here rather than relying on bare microtasks.
const loop = GLib.MainLoop.new(null, false);
let exitCode = 0;

main().then(() => {
    print('');
    if (failures > 0) {
        print(`${failures} failure(s)`);
        exitCode = 1;
    } else {
        print('all tests passed');
    }
}).catch(e => {
    print(`ERROR ${e.message}\n${e.stack ?? ''}`);
    exitCode = 1;
}).finally(() => {
    try { scratchFile().delete(null); } catch (_) { /* already gone */ }
    loop.quit();
});

loop.run();
imports.system.exit(exitCode);
