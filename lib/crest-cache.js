// On-disk cache of team crests and league logos for notification icons.
//
// First call for a given key downloads the bytes via Soup and writes them to
// ~/.cache/gnomefootball/crests/<key>.png. Subsequent calls hit the disk only
// (and an in-memory map of resolved Gio.FileIcon objects).
//
// Concurrent calls for the same key share a single in-flight Promise so we
// don't issue duplicate downloads when several notifications fire at once.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { fetchBytes } from './sports-api.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_async');

const _iconByKey = new Map();
const _inFlight = new Map();
let _cacheDir = null;

function cacheDir() {
    if (_cacheDir)
        return _cacheDir;
    _cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnomefootball', 'crests']);
    GLib.mkdir_with_parents(_cacheDir, 0o755);
    return _cacheDir;
}

function cacheFile(key) {
    return Gio.File.new_for_path(GLib.build_filenamev([cacheDir(), `${key}.png`]));
}

// Route ESPN crest URLs through the combiner endpoint to fetch them at 150px
// instead of the 500px originals (~91% smaller, still covers 3x HiDPI).
const CREST_SIZE = 150;

function optimizeUrl(url) {
    return url.replace(
        /^https?:\/\/a\.espncdn\.com(\/i\/.*)$/,
        `https://a.espncdn.com/combiner/i?img=$1&h=${CREST_SIZE}&w=${CREST_SIZE}`
    );
}

async function downloadTo(file, url, cancellable) {
    const bytes = await fetchBytes(optimizeUrl(url), cancellable);
    await file.replace_contents_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        cancellable
    );
}

// Returns a Gio.FileIcon for the cached image, downloading it first if needed.
// Throws if `url` is empty or the download fails — callers should fall back to
// the next icon candidate.
export async function getIcon(key, url, cancellable = null) {
    if (!key || !url)
        throw new Error('crest-cache: missing key or url');

    const cached = _iconByKey.get(key);
    if (cached)
        return cached;

    const inflight = _inFlight.get(key);
    if (inflight)
        return inflight;

    const promise = (async () => {
        const file = cacheFile(key);
        if (!file.query_exists(cancellable))
            await downloadTo(file, url, cancellable);
        const icon = new Gio.FileIcon({ file });
        _iconByKey.set(key, icon);
        return icon;
    })().finally(() => {
        _inFlight.delete(key);
    });

    _inFlight.set(key, promise);
    return promise;
}

export function disposeCrestCache() {
    _iconByKey.clear();
    _inFlight.clear();
    _cacheDir = null;
}
