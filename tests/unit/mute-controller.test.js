// Unit tests for lib/mute-controller.js — run with: gjs -m tests/unit/mute-controller.test.js
//
// MuteController takes its storage (readJson/writeJson) as injectable options, so
// these tests run entirely in memory with no disk or shell environment.

import { MuteController } from '../../lib/mute-controller.js';

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

// In-memory storage double. Records the last persisted object so we can assert
// persistence happened.
function makeStorage(initial = {}) {
    const state = { data: { ...initial }, writes: 0 };
    return {
        state,
        readJson: async (_name, fallback = {}) => state.data ?? fallback,
        writeJson: async (_name, value) => {
            state.data = value;
            state.writes++;
            return true;
        },
    };
}

async function main() {
    // --- basic mute / unmute / toggle --------------------------------------
    print('mute / unmute / toggle');
    {
        const s = makeStorage();
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        check('initially-not-muted', mc.isMuted('100') === false);

        mc.mute('100');
        check('muted-after-mute', mc.isMuted('100') === true);

        mc.mute('100'); // idempotent
        eq('id-coerced-to-string', s.state.data, { '100': s.state.data['100'] });
        check('mute-persisted',
            s.state.data['100']?.muted === true &&
            typeof s.state.data['100']?.at === 'number');

        mc.unmute('100');
        check('not-muted-after-unmute', mc.isMuted('100') === false);

        mc.toggle('100');
        check('toggle-on', mc.isMuted('100') === true);
        mc.toggle('100');
        check('toggle-off', mc.isMuted('100') === false);

        // Numbers and strings address the same entry.
        mc.mute(42);
        check('numeric-id-matches-string', mc.isMuted('42') === true);
    }

    // --- areAllMuted --------------------------------------------------------
    print('areAllMuted');
    {
        const s = makeStorage();
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        check('empty-list-false', mc.areAllMuted([]) === false);
        mc.mute('1');
        check('partial-false', mc.areAllMuted(['1', '2']) === false);
        mc.mute('2');
        check('all-true', mc.areAllMuted(['1', '2']) === true);
    }

    // --- toggleAll (D15 bulk per-day mute) ----------------------------------
    print('toggleAll');
    {
        const s = makeStorage();
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        mc.toggleAll(['1', '2', '3'], true);
        check('all-muted', mc.areAllMuted(['1', '2', '3']) === true);
        mc.toggleAll(['1', '2', '3'], false);
        check('all-unmuted',
            !mc.isMuted('1') && !mc.isMuted('2') && !mc.isMuted('3'));

        // Mixed starting state: muting the set leaves every id muted.
        mc.mute('2');
        const writesBefore = s.state.writes;
        mc.toggleAll(['1', '2', '3'], true);
        check('mixed-then-all-muted', mc.areAllMuted(['1', '2', '3']) === true);
        check('toggleAll-persisted-once', s.state.writes === writesBefore + 1);

        // No-op toggleAll does not persist.
        const writesNow = s.state.writes;
        mc.toggleAll(['1', '2', '3'], true); // already all muted
        check('noop-toggleAll-no-write', s.state.writes === writesNow);
    }

    // --- afterTick: expire at full-time + age out ---------------------------
    print('afterTick');
    {
        const s = makeStorage();
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        mc.mute('alive');
        mc.mute('finished');
        mc.afterTick(['finished']);
        check('finished-expired', mc.isMuted('finished') === false);
        check('alive-kept', mc.isMuted('alive') === true);

        // No finished ids and nothing aged: no change, no write.
        const writes = s.state.writes;
        mc.afterTick([]);
        check('noop-afterTick-no-write', s.state.writes === writes);
    }

    // --- afterTick age-out: a stale entry is pruned even if not "finished" ---
    print('afterTick (age-out)');
    {
        const s = makeStorage();
        // maxAgeMs -1 makes any entry instantly stale (elapsed 0 > -1), so we can
        // exercise the age-out branch without sleeping or faking the clock.
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson, maxAgeMs: -1 });
        mc.mute('old');
        mc.afterTick([]);
        check('aged-out', mc.isMuted('old') === false);
    }

    // --- load: restores persisted mutes, drops expired ---------------------
    print('load');
    {
        const now = Date.now();
        const s = makeStorage({
            recent: now - 1000,           // within maxAge -> restored
            stale: now - (48 * 3600 * 1000), // older than 12h default -> dropped
        });
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        await mc.load();
        check('recent-restored', mc.isMuted('recent') === true);
        check('stale-dropped', mc.isMuted('stale') === false);
    }

    // --- subscribe: fires on change, unsubscribe stops it ------------------
    print('subscribe');
    {
        const s = makeStorage();
        const mc = new MuteController({ readJson: s.readJson, writeJson: s.writeJson });
        let calls = 0;
        const unsub = mc.subscribe(() => { calls++; });
        mc.mute('1');
        check('fired-on-mute', calls === 1);
        mc.unmute('1');
        check('fired-on-unmute', calls === 2);
        mc.mute('1'); mc.mute('1'); // second is no-op
        check('no-fire-on-noop', calls === 3);
        unsub();
        mc.unmute('1');
        check('no-fire-after-unsubscribe', calls === 3);
    }

    // --- mute-by-default: ambient default flips the base state -------------
    print('mute-by-default');
    {
        const s = makeStorage();
        let def = true;
        const mc = new MuteController({
            readJson: s.readJson, writeJson: s.writeJson,
            isDefaultMuted: () => def,
        });
        // With the default on, an untouched match is muted.
        check('default-muted', mc.isMuted('x') === true);
        check('areAllMuted-default', mc.areAllMuted(['x', 'y']) === true);

        // Un-muting stores an explicit override (a deviation from the default).
        mc.unmute('x');
        check('explicit-unmute', mc.isMuted('x') === false);
        eq('override-persisted-unmuted', s.state.data['x']?.muted, false);

        // Muting again drops the override (it now matches the default).
        const writes = s.state.writes;
        mc.mute('x');
        check('back-to-default-muted', mc.isMuted('x') === true);
        check('override-dropped', s.state.data['x'] === undefined);
        check('drop-persisted', s.state.writes === writes + 1);

        // toggle respects the default as the starting state.
        mc.toggle('z'); // muted (default) -> un-muted
        check('toggle-from-default', mc.isMuted('z') === false);
    }

    // --- flipping the default keeps explicit overrides intact --------------
    print('flip default preserves overrides');
    {
        const s = makeStorage();
        let def = false;
        const mc = new MuteController({
            readJson: s.readJson, writeJson: s.writeJson,
            isDefaultMuted: () => def,
        });
        mc.mute('kept'); // explicit mute under default-off
        check('muted-under-off', mc.isMuted('kept') === true);

        // Turn the default on. The explicit mute must remain a mute; an untouched
        // match now follows the new default (muted too).
        def = true;
        mc.notifyDefaultChanged();
        check('explicit-mute-survives-flip', mc.isMuted('kept') === true);
        check('untouched-follows-new-default', mc.isMuted('other') === true);

        // The now-redundant override (muted == default) is pruned.
        check('redundant-override-pruned', s.state.data['kept'] === undefined);

        // Un-muting under the new default works and survives a flip back.
        mc.unmute('kept');
        check('unmute-under-on', mc.isMuted('kept') === false);
        def = false;
        mc.notifyDefaultChanged();
        check('explicit-unmute-survives-flip', mc.isMuted('kept') === false);
    }

    print('');
    if (failures > 0) {
        print(`${failures} failure(s)`);
        imports.system.exit(1);
    } else {
        print('all tests passed');
    }
}

await main();
