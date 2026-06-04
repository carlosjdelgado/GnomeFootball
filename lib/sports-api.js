// Thin async HTTP client around libsoup3 for the upstream soccer endpoints.
//
// Each fetch function checks for a local fixture file before hitting the
// network. If ~/.local/share/gnomefootball/fixtures/<slug>/scoreboard.json
// (or summary-<eventId>.json) exists, it is returned as-is. This lets the
// E2E test runner inject a fictional match without touching any other module.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { API_BASE_URL, USER_AGENT } from './constants.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const REQUEST_TIMEOUT_SECONDS = 15;
const MAX_ATTEMPTS = 3;

const FIXTURES_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnomefootball', 'fixtures',
]);

let _session = null;

function getSession() {
    if (_session)
        return _session;
    _session = new Soup.Session({
        user_agent: USER_AGENT,
        timeout: REQUEST_TIMEOUT_SECONDS,
    });
    return _session;
}

function sleepMs(ms, cancellable) {
    return new Promise((resolve, reject) => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        if (cancellable) {
            cancellable.connect(() => {
                GLib.Source.remove(id);
                reject(new Error('Cancelled'));
            });
        }
    });
}

async function fetchJson(url, cancellable = null) {
    const session = getSession();
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const message = Soup.Message.new('GET', url);
        message.request_headers.append('Accept', 'application/json');
        try {
            const bytes = await session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                cancellable
            );
            const status = message.get_status();
            if (status === Soup.Status.OK) {
                const text = new TextDecoder('utf-8').decode(bytes.get_data());
                return JSON.parse(text);
            }
            if (status >= 500 && status < 600) {
                lastError = new Error(`HTTP ${status} for ${url}`);
            } else {
                throw new Error(`HTTP ${status} for ${url}`);
            }
        } catch (e) {
            if (cancellable && cancellable.is_cancelled())
                throw e;
            lastError = e;
        }

        if (attempt < MAX_ATTEMPTS) {
            const backoffMs = 500 * Math.pow(2, attempt - 1);
            await sleepMs(backoffMs, cancellable);
        }
    }
    throw lastError ?? new Error(`Request failed: ${url}`);
}

async function tryReadLocalFixture(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return null;
    try {
        const [contents] = await file.load_contents_async(null);
        return JSON.parse(new TextDecoder('utf-8').decode(contents));
    } catch (_) {
        return null;
    }
}

// Disk-first fetch: serve fixtures/<slug>/<fixtureName> if present (the tests'
// fixtures), otherwise hit the network at `url`.
async function fetchWithLocalFallback(slug, fixtureName, url, cancellable) {
    const localPath = GLib.build_filenamev([FIXTURES_DIR, slug, fixtureName]);
    const local = await tryReadLocalFixture(localPath);
    return local ?? fetchJson(url, cancellable);
}

export async function fetchScoreboard(slug, cancellable = null) {
    return fetchWithLocalFallback(slug, 'scoreboard.json',
        `${API_BASE_URL}/${encodeURIComponent(slug)}/scoreboard`, cancellable);
}

// Scoreboard for a date range (YYYYMMDD[-YYYYMMDD]), used by the panel for
// past/future days; the caller filters client-side by local date. The same
// scoreboard.json fixture feeds this and the poller, so the e2e runner can drive
// every day from one fixture. Only the network fallback uses the range.
export async function fetchScoreboardForDate(slug, dateRange, cancellable = null) {
    return fetchWithLocalFallback(slug, 'scoreboard.json',
        `${API_BASE_URL}/${encodeURIComponent(slug)}/scoreboard?dates=${encodeURIComponent(dateRange)}`, cancellable);
}

export async function fetchSummary(slug, eventId, cancellable = null) {
    return fetchWithLocalFallback(slug, `summary-${eventId}.json`,
        `${API_BASE_URL}/${encodeURIComponent(slug)}/summary?event=${encodeURIComponent(eventId)}`, cancellable);
}

export async function fetchTeams(slug, cancellable = null) {
    return fetchWithLocalFallback(slug, 'teams.json',
        `${API_BASE_URL}/${encodeURIComponent(slug)}/teams`, cancellable);
}

// Download remote bytes (used to cache team crests for notification icons).
export async function fetchBytes(url, cancellable = null) {
    const session = getSession();
    const message = Soup.Message.new('GET', url);
    const bytes = await session.send_and_read_async(
        message,
        GLib.PRIORITY_DEFAULT,
        cancellable
    );
    const status = message.get_status();
    if (status !== Soup.Status.OK)
        throw new Error(`HTTP ${status} for ${url}`);
    return bytes.get_data();
}

// Allow the extension to free the Soup session on disable().
export function disposeSession() {
    if (_session) {
        try { _session.abort(); } catch (_) { /* ignore */ }
        _session = null;
    }
}
