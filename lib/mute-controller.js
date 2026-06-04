// Per-match mute controller (Feature 3).
//
// Single in-memory owner of the set of muted matches, shared across the three
// consumers that all run in the shell process:
//   - the notifier, whose "Mute match" action button calls mute();
//   - the poller, which checks isMuted() before dispatching and calls afterTick()
//     to auto-expire mutes at full-time / by age;
//   - the calendar panel, whose per-row bell + "Mute all" button toggle entries
//     and which re-renders via subscribe().
//
// Because every consumer reads/writes the SAME in-memory instance, mute state is
// always consistent within a session. Persistence to muted-matches.json is only
// so a mute survives a logout/login mid-match (D14); it is deliberately kept out
// of live-state.json (which the poller rewrites wholesale each tick) to avoid a
// clobber race. Entries are transient: pruned at full-time and aged out, so a
// mute set on a Tuesday match is gone by Wednesday.
//
// Storage is injected (defaults to the real JSON files) so the logic is unit
// testable without touching disk.

import { readJson as defaultRead, writeJson as defaultWrite, MUTED_MATCHES_FILE } from './storage.js';

// Hard cap on how long a mute lingers. Covers orphans (a muted match that drops
// out of the scoreboard without us observing its full-time) and gives the
// "gone by the next day" property. Full-time expiry (afterTick) is the normal
// path; this is the backstop.
const MUTE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class MuteController {
    constructor({ readJson = defaultRead, writeJson = defaultWrite, maxAgeMs = MUTE_MAX_AGE_MS } = {}) {
        this._read = readJson;
        this._write = writeJson;
        this._maxAgeMs = maxAgeMs;
        // eventId (string) -> mutedAt (ms epoch)
        this._muted = new Map();
        this._subs = new Set();
    }

    // Load any persisted mutes (dropping already-expired ones). Async; the rest
    // of the API works against an empty set until this resolves. Emits once so a
    // panel built before the load picks up restored mutes.
    async load() {
        let data = {};
        try {
            data = await this._read(MUTED_MATCHES_FILE, {});
        } catch (_) {
            data = {};
        }
        const now = Date.now();
        for (const [id, at] of Object.entries(data ?? {})) {
            const ts = Number(at);
            const when = Number.isFinite(ts) ? ts : now;
            if (now - when <= this._maxAgeMs)
                this._muted.set(String(id), when);
        }
        this._emit();
    }

    // --- queries ------------------------------------------------------------

    isMuted(eventId) {
        return this._muted.has(String(eventId));
    }

    // True only when every listed id is muted (and there is at least one). Drives
    // the panel's "Mute all" / "Un-mute all" toggle label.
    areAllMuted(ids) {
        const arr = (ids ?? []).map(String).filter(Boolean);
        return arr.length > 0 && arr.every(id => this._muted.has(id));
    }

    // --- mutations ----------------------------------------------------------

    mute(eventId) {
        this._set(String(eventId), true);
    }

    unmute(eventId) {
        this._set(String(eventId), false);
    }

    toggle(eventId) {
        const id = String(eventId);
        this._set(id, !this._muted.has(id));
    }

    // Bulk per-match mute over the matches currently listed for a day (D15). Not
    // a date-level rule: it just adds/removes each id, exactly like pressing the
    // per-match button on every one.
    toggleAll(ids, mute) {
        const now = Date.now();
        let changed = false;
        for (const raw of ids ?? []) {
            const id = String(raw);
            if (!id)
                continue;
            const has = this._muted.has(id);
            if (mute && !has) {
                this._muted.set(id, now);
                changed = true;
            } else if (!mute && has) {
                this._muted.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._commit();
    }

    // Called by the poller after each tick. Expires mutes for matches that have
    // reached full-time (so the mute auto-clears at FT, D14) and ages out any
    // stragglers. One persist/emit for the whole batch.
    afterTick(finishedEventIds = []) {
        const now = Date.now();
        let changed = false;
        for (const raw of finishedEventIds) {
            if (this._muted.delete(String(raw)))
                changed = true;
        }
        for (const [id, at] of this._muted) {
            if (now - at > this._maxAgeMs) {
                this._muted.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._commit();
    }

    // --- subscription -------------------------------------------------------

    // Register a callback fired whenever the muted set changes. Returns an
    // unsubscribe function.
    subscribe(cb) {
        this._subs.add(cb);
        return () => this._subs.delete(cb);
    }

    dispose() {
        this._subs.clear();
        this._muted.clear();
    }

    // --- internals ----------------------------------------------------------

    _set(id, mute) {
        const has = this._muted.has(id);
        if (mute && !has) {
            this._muted.set(id, Date.now());
        } else if (!mute && has) {
            this._muted.delete(id);
        } else {
            return; // no change
        }
        this._commit();
    }

    _commit() {
        this._persist();
        this._emit();
    }

    _persist() {
        const obj = Object.fromEntries(this._muted);
        Promise.resolve(this._write(MUTED_MATCHES_FILE, obj)).catch(() => { /* best effort */ });
    }

    _emit() {
        for (const cb of this._subs) {
            try {
                cb();
            } catch (_) {
                /* a bad subscriber must not break the others */
            }
        }
    }
}
