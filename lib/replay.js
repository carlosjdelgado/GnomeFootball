// Replay mode for the ESPN HTTP client.
//
// When enabled, fetchScoreboard / fetchSummary in espn-api.js read JSON
// fixtures from disk instead of issuing real HTTP requests. This lets us
// drive the full poller + detector + notifier pipeline against a scripted
// sequence of snapshots — useful for development and integration testing
// without waiting for a live football match.
//
// Activation is controlled by the GSetting `replay-dir`. Empty string =
// disabled (normal network mode). Non-empty path = replay from that
// directory.
//
// Expected directory layout:
//
//   <replay-dir>/
//     <slug>/                          e.g. "test.1"
//       scoreboard-000.json
//       summary-000-<eventId>.json     (optional; omit for empty plays)
//       scoreboard-001.json
//       summary-001-<eventId>.json
//       ...
//
// Each call to fetchScoreboard(slug) advances a per-slug counter and
// returns the next snapshot. When the counter passes the last available
// snapshot it stays on the last one (matches "match finished, scoreboard
// no longer changes" semantics).
//
// fetchSummary(slug, eventId) returns the summary at the slug's current
// counter (does NOT advance it), so scoreboard + summary stay in sync
// within the same poller tick.
//
// Changing the `replay-dir` GSetting (including toggling off and on)
// resets all per-slug counters back to 0.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let _replayDir = '';
let _counters = new Map();
let _settings = null;
let _changeHandler = 0;

function readSettingDir() {
    if (!_settings)
        return '';
    try {
        return _settings.get_string('replay-dir') || '';
    } catch (_) {
        return '';
    }
}

function resetState(newDir) {
    _replayDir = newDir;
    _counters = new Map();
    if (newDir)
        console.log(`[GnomeFootball] replay mode ON: ${newDir}`);
    else
        console.log('[GnomeFootball] replay mode OFF');
}

export function initReplay(settings) {
    _settings = settings;
    resetState(readSettingDir());
    _changeHandler = settings.connect('changed::replay-dir', () => {
        resetState(readSettingDir());
    });
}

export function disposeReplay() {
    if (_settings && _changeHandler) {
        try { _settings.disconnect(_changeHandler); } catch (_) { /* ignore */ }
    }
    _changeHandler = 0;
    _settings = null;
    _replayDir = '';
    _counters = new Map();
}

export function isReplayActive() {
    return !!_replayDir;
}

function expandPath(p) {
    if (p.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), p.slice(2)]);
    return p;
}

function readJsonFile(path) {
    const file = Gio.File.new_for_path(path);
    const [ok, contents] = file.load_contents(null);
    if (!ok)
        throw new Error(`replay: failed to read ${path}`);
    const text = new TextDecoder('utf-8').decode(contents);
    return JSON.parse(text);
}

function fileExists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

function highestExistingIndex(slugDir) {
    // Walk 0..N until scoreboard-NNN.json is missing.
    let last = -1;
    for (let i = 0; i < 1000; i++) {
        const padded = String(i).padStart(3, '0');
        const path = GLib.build_filenamev([slugDir, `scoreboard-${padded}.json`]);
        if (fileExists(path))
            last = i;
        else
            break;
    }
    return last;
}

function fixtureScoreboardPath(slug, index) {
    const root = expandPath(_replayDir);
    const padded = String(index).padStart(3, '0');
    return GLib.build_filenamev([root, slug, `scoreboard-${padded}.json`]);
}

function fixtureSummaryPath(slug, index, eventId) {
    const root = expandPath(_replayDir);
    const padded = String(index).padStart(3, '0');
    return GLib.build_filenamev([root, slug, `summary-${padded}-${eventId}.json`]);
}

// Returns the next scoreboard fixture for `slug` and advances the per-slug
// counter. When the next index doesn't exist, returns the last available
// snapshot (counter stays clamped at the max).
export function replayScoreboard(slug) {
    const root = expandPath(_replayDir);
    const slugDir = GLib.build_filenamev([root, slug]);
    const maxIndex = highestExistingIndex(slugDir);
    if (maxIndex < 0)
        throw new Error(`replay: no fixtures for slug "${slug}" under ${slugDir}`);

    let idx = _counters.get(slug);
    if (idx === undefined)
        idx = 0;
    else
        idx = Math.min(idx + 1, maxIndex);
    _counters.set(slug, idx);

    const path = fixtureScoreboardPath(slug, idx);
    console.log(`[GnomeFootball] replay: ${slug} -> scoreboard-${String(idx).padStart(3, '0')}.json`);
    return readJsonFile(path);
}

// Returns the summary fixture for `slug` at the slug's current counter,
// or { plays: [] } when no matching file exists.
export function replaySummary(slug, eventId) {
    const idx = _counters.get(slug);
    if (idx === undefined)
        return { plays: [] };
    const path = fixtureSummaryPath(slug, idx, eventId);
    if (!fileExists(path))
        return { plays: [] };
    return readJsonFile(path);
}
