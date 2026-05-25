#!/usr/bin/env bash
# E2E test runner for GnomeFootball.
#
# Usage: ./tests/e2e/run.sh [scenario]
#   scenario: subdirectory under tests/e2e/scenarios/ (default: full-match)
#
# The script injects a fictional match into the running extension by writing
# fixture files under ~/.local/share/gnomefootball/fixtures/<slug>/. The
# extension's sports-api.js picks them up automatically (disk-first lookup)
# without any special mode being active. The fictional match coexists with
# real subscribed matches during the test.
#
# Requirements: gsettings, jq

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export GSETTINGS_SCHEMA_DIR="$REPO_ROOT/schemas"

SCENARIO="${1:-full-match}"
SCENARIO_DIR="$SCRIPT_DIR/scenarios/$SCENARIO"
META="$SCENARIO_DIR/meta.json"

SCHEMA="org.gnome.shell.extensions.gnomefootball"
FIXTURES_BASE="${XDG_DATA_HOME:-$HOME/.local/share}/gnomefootball/fixtures"
LIVE_STATE="${XDG_DATA_HOME:-$HOME/.local/share}/gnomefootball/live-state.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

# Read meta fields at startup so they are available in cleanup too.
SLUG=$(jq -r '.slug' "$META")
EVENT_ID=$(jq -r '.eventId' "$META")
SCENARIO_NAME=$(jq -r '.name' "$META")
STEP_COUNT=$(jq '.steps | length' "$META")
OVERRIDE_DIR="$FIXTURES_BASE/$SLUG"

cleanup() {
    echo ""
    echo -e "${YELLOW}Cleaning up test match...${NC}"
    rm -rf "$OVERRIDE_DIR"
    if gsettings get "$SCHEMA" subscriptions-json &>/dev/null; then
        local subs
        subs=$(gsettings get "$SCHEMA" subscriptions-json | sed "s/^'//;s/'$//")
        subs=$(echo "$subs" | jq -c "del(.\"$SLUG\")" 2>/dev/null || echo "$subs")
        gsettings set "$SCHEMA" subscriptions-json "$subs"
    fi
    if [[ -f "$LIVE_STATE" ]]; then
        local cleaned
        cleaned=$(jq -c "del(.\"$EVENT_ID\")" "$LIVE_STATE" 2>/dev/null) \
            && echo "$cleaned" > "$LIVE_STATE" || true
    fi
    echo -e "${GREEN}Done.${NC}"
}
trap cleanup EXIT INT TERM

check_deps() {
    for cmd in gsettings jq; do
        command -v "$cmd" &>/dev/null \
            || { echo -e "${RED}Error: '$cmd' not found.${NC}" >&2; exit 1; }
    done
    gsettings get "$SCHEMA" subscriptions-json &>/dev/null \
        || { echo -e "${RED}Error: GnomeFootball schema not available. Is the extension installed?${NC}" >&2; exit 1; }
    [[ -f "$META" ]] \
        || { echo -e "${RED}Error: scenario '$SCENARIO' not found in $SCENARIO_DIR${NC}" >&2; exit 1; }
}

setup() {
    mkdir -p "$OVERRIDE_DIR"
    local subs
    subs=$(gsettings get "$SCHEMA" subscriptions-json | sed "s/^'//;s/'$//")
    subs=$(echo "$subs" | jq -c ". + {\"$SLUG\": {\"mode\": \"all\"}}")
    gsettings set "$SCHEMA" subscriptions-json "$subs"
    if [[ -f "$LIVE_STATE" ]]; then
        local cleaned
        cleaned=$(jq -c "del(.\"$EVENT_ID\")" "$LIVE_STATE" 2>/dev/null) \
            && echo "$cleaned" > "$LIVE_STATE" || true
    fi
}

load_step() {
    local idx="$1"
    local scoreboard summary inject_date

    scoreboard=$(jq -r ".steps[$idx].scoreboard" "$META")
    summary=$(jq -r ".steps[$idx].summary // empty" "$META")
    inject_date=$(jq -r ".steps[$idx].injectDate // empty" "$META")

    if [[ -n "$inject_date" ]]; then
        local d
        d=$(date -u -d "$inject_date" '+%Y-%m-%dT%H:%M:%SZ')
        jq --arg d "$d" '.events[0].date = $d' \
            "$SCENARIO_DIR/$scoreboard" > "$OVERRIDE_DIR/scoreboard.json"
    else
        cp "$SCENARIO_DIR/$scoreboard" "$OVERRIDE_DIR/scoreboard.json"
    fi

    rm -f "$OVERRIDE_DIR/summary-${EVENT_ID}.json"
    if [[ -n "$summary" ]]; then
        cp "$SCENARIO_DIR/$summary" "$OVERRIDE_DIR/summary-${EVENT_ID}.json"
    fi
}

fire_tick() {
    gsettings set "$SCHEMA" force-check-trigger "$(date +%s)"
}

main() {
    check_deps

    echo ""
    echo -e "${BOLD}════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  GnomeFootball E2E — ${SCENARIO_NAME}${NC}"
    echo -e "${BOLD}════════════════════════════════════════════${NC}"
    echo ""
    echo "Setting up test match..."
    setup
    echo -e "  ${GREEN}✓${NC} $SLUG added to subscriptions"
    echo -e "  ${GREEN}✓${NC} fixtures directory: $OVERRIDE_DIR"
    echo ""

    for ((i = 0; i < STEP_COUNT; i++)); do
        local label expected step_num=$((i + 1))
        label=$(jq -r ".steps[$i].label" "$META")
        expected=$(jq -r ".steps[$i].expected" "$META")

        echo -e "${BLUE}[Step ${step_num}/${STEP_COUNT}]${NC} ${BOLD}${label}${NC}"
        echo -e "         Expected: ${YELLOW}${expected}${NC}"
        echo -n "         [Enter] fire tick  |  [q+Enter] quit ... "

        local input
        read -r input
        if [[ "$input" == "q" ]]; then
            echo "Quitting."
            exit 0
        fi

        load_step "$i"
        fire_tick
        sleep 2
        echo ""
    done

    echo -e "${GREEN}${BOLD}Test completed.${NC}"
}

main
