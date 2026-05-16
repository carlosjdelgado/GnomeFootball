// Thin async HTTP client around libsoup3 for ESPN's public soccer endpoints.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { ESPN_BASE_URL, USER_AGENT } from './constants.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const REQUEST_TIMEOUT_SECONDS = 15;
const MAX_ATTEMPTS = 3;

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
            // Retry on 5xx; bail on 4xx.
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

export async function fetchScoreboard(slug, cancellable = null) {
    const url = `${ESPN_BASE_URL}/${encodeURIComponent(slug)}/scoreboard`;
    return fetchJson(url, cancellable);
}

export async function fetchSummary(slug, eventId, cancellable = null) {
    const url = `${ESPN_BASE_URL}/${encodeURIComponent(slug)}/summary?event=${encodeURIComponent(eventId)}`;
    return fetchJson(url, cancellable);
}

export async function fetchTeams(slug, cancellable = null) {
    const url = `${ESPN_BASE_URL}/${encodeURIComponent(slug)}/teams`;
    return fetchJson(url, cancellable);
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
