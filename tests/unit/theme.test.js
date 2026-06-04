// Unit tests for lib/theme.js — run with: gjs -m tests/unit/theme.test.js
// Only pickLogo's variant-independent paths are asserted: which of default/dark
// it returns depends on the live color scheme, so those cases check membership.

import { pickLogo } from '../../lib/theme.js';

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

print('pickLogo');
{
    // Nothing to pick → empty string.
    eq('empty-array', pickLogo([]), '');
    eq('null', pickLogo(null), '');
    eq('not-an-array', pickLogo('nope'), '');

    // A single entry is returned whatever the theme (no matching variant → first).
    eq('single-entry', pickLogo([{ rel: ['default'], href: 'only.png' }]), 'only.png');

    // An entry without a rel array still falls back to the first href.
    eq('no-rel', pickLogo([{ href: 'first.png' }]), 'first.png');

    // With both variants present, the result is one of them (which one depends on
    // the live color scheme, so assert membership rather than a fixed value).
    const both = pickLogo([
        { rel: ['default'], href: 'light.png' },
        { rel: ['dark'], href: 'dark.png' },
    ]);
    check('both-variants-returns-one', ['light.png', 'dark.png'].includes(both));
}

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
