// On-disk JSON storage for state that is too large or volatile for GSettings.
// Currently used for liveState (per-event snapshots used by the event detector).
//
// Files live under $XDG_DATA_HOME/gnomefootball/ (typically ~/.local/share/gnomefootball).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const APP_DIR_NAME = 'gnomefootball';

let _dataDir = null;

function ensureDataDir() {
    if (_dataDir)
        return _dataDir;
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR_NAME]);
    GLib.mkdir_with_parents(path, 0o755);
    _dataDir = path;
    return path;
}

function fileFor(name) {
    return Gio.File.new_for_path(GLib.build_filenamev([ensureDataDir(), name]));
}

export async function readJson(name, fallback = {}) {
    try {
        const file = fileFor(name);
        const [contents] = await file.load_contents_async(null);
        const text = new TextDecoder('utf-8').decode(contents);
        if (!text.trim())
            return fallback;
        return JSON.parse(text);
    } catch (e) {
        if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            return fallback;
        console.warn(`[GnomeFootball] storage: failed to read ${name}: ${e.message}`);
        return fallback;
    }
}

export async function writeJson(name, value) {
    try {
        const file = fileFor(name);
        const data = new TextEncoder().encode(JSON.stringify(value));
        await file.replace_contents_async(
            data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        console.warn(`[GnomeFootball] storage: failed to write ${name}: ${e.message}`);
        return false;
    }
}

export const LIVE_STATE_FILE = 'live-state.json';

// Transient per-match mute state, separate from live-state.json so the poller's
// per-tick rewrite of that file can't clobber a mute toggled between ticks.
export const MUTED_MATCHES_FILE = 'muted-matches.json';
