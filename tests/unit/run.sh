#!/usr/bin/env bash
# Unit test runner for GnomeFootball. Runs every tests/unit/*.test.js under gjs
# and reports a summary; exits non-zero if any file fails.
#
# The tested modules are GJS/Gio-free or use injected doubles, so no GNOME Shell
# is needed. Shell-coupled code (poller, notifier, calendar-panel) is covered by
# tests/e2e/run.sh instead.

set -u
cd "$(dirname "$0")/../.." || exit 1

pass=0
fail=0
failed_files=()

for t in tests/unit/*.test.js; do
    if out=$(gjs -m "$t" 2>&1) && echo "$out" | grep -q "all tests passed"; then
        n=$(echo "$out" | grep -cE '^[[:space:]]+ok ')
        printf '  %-32s %3s asserts  OK\n' "$(basename "$t")" "$n"
        pass=$((pass + 1))
    else
        printf '  %-32s FAIL\n' "$(basename "$t")"
        echo "$out" | grep -E 'FAIL|ERROR' | sed 's/^/      /'
        failed_files+=("$t")
        fail=$((fail + 1))
    fi
done

echo
echo "Files: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
