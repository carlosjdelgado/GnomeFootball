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
// testable without touching disk. The "mute everything by default" setting is
// likewise injected as a getter (isDefaultMuted) rather than a Gio dependency,
// keeping this module Gio-free.
//
// Mute model: there are two ambient defaults — notify-by-default (the setting
// off, the original behaviour) and mute-by-default (the setting on). The map
// stores OVERRIDES, i.e. per-match deviations from the current ambient default:
//   - default off: an override means "muted" (the user silenced this match);
//   - default on:  an override means "un-muted" (the user opted this match in).
// Each override records its absolute muted value (not just "is a deviation"),
// so flipping the default never silently re-interprets existing overrides — an
// explicit mute stays a mute, an explicit un-mute stays an un-mute. Matches
// without an override simply follow the ambient default.

import { readJson as defaultRead, writeJson as defaultWrite, MUTED_MATCHES_FILE } from './storage.js';

// Hard cap on how long an override lingers. Covers orphans (an override for a
// match that drops out of the scoreboard without us observing its full-time)
// and gives the "gone by the next day" property. Full-time expiry (afterTick)
// is the normal path; this is the backstop.
const MUTE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class MuteController {
    constructor({
        readJson = defaultRead,
        writeJson = defaultWrite,
        maxAgeMs = MUTE_MAX_AGE_MS,
        isDefaultMuted = () => false,
    } = {}) {
        this._read = readJson;
        this._write = writeJson;
        this._maxAgeMs = maxAgeMs;
        this._isDefaultMuted = isDefaultMuted;
        // eventId (string) -> { muted: bool, at: ms epoch }
        this._overrides = new Map();
        this._subs = new Set();
    }

    // Load any persisted overrides (dropping already-expired ones). Async; the
    // rest of the API works against an empty set until this resolves. Emits once
    // so a panel built before the load picks up restored state. Accepts both the
    // current { muted, at } shape and the legacy bare-number (mutedAt) shape.
    async load() {
        let data = {};
        try {
            data = await this._read(MUTED_MATCHES_FILE, {});
        } catch (_) {
            data = {};
        }
        const now = Date.now();
        for (const [id, raw] of Object.entries(data ?? {})) {
            const o = this._normalizeOverride(raw, now);
            if (now - o.at <= this._maxAgeMs)
                this._overrides.set(String(id), o);
        }
        this._emit();
    }

    // --- queries ------------------------------------------------------------

    isMuted(eventId) {
        const o = this._overrides.get(String(eventId));
        return o ? o.muted : this._defaultMuted();
    }

    // True only when every listed id is effectively muted (and there is at least
    // one). Drives the panel's "Mute all" / "Un-mute all" toggle label.
    areAllMuted(ids) {
        const arr = (ids ?? []).map(String).filter(Boolean);
        return arr.length > 0 && arr.every(id => this.isMuted(id));
    }

    // --- mutations ----------------------------------------------------------

    mute(eventId) {
        this._setAbsolute(String(eventId), true);
    }

    unmute(eventId) {
        this._setAbsolute(String(eventId), false);
    }

    toggle(eventId) {
        const id = String(eventId);
        this._setAbsolute(id, !this.isMuted(id));
    }

    // Bulk per-match mute over the matches currently listed for a day (D15). Not
    // a date-level rule: it just forces each id to the desired absolute state,
    // exactly like pressing the per-match button on every one.
    toggleAll(ids, mute) {
        let changed = false;
        for (const raw of ids ?? []) {
            const id = String(raw);
            if (!id)
                continue;
            if (this._applyAbsolute(id, mute))
                changed = true;
        }
        if (changed)
            this._commit();
    }

    // Called by the poller after each tick. Expires overrides for matches that
    // have reached full-time (so any mute/un-mute auto-clears at FT, D14) and
    // ages out any stragglers. One persist/emit for the whole batch.
    afterTick(finishedEventIds = []) {
        const now = Date.now();
        let changed = false;
        for (const raw of finishedEventIds) {
            if (this._overrides.delete(String(raw)))
                changed = true;
        }
        for (const [id, o] of this._overrides) {
            if (now - o.at > this._maxAgeMs) {
                this._overrides.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._commit();
    }

    // Called when the "mute by default" setting flips. Existing overrides keep
    // their absolute meaning, but any that now coincide with the new ambient
    // default become redundant and are pruned (keeping the stored set to genuine
    // deviations). Always emits, since the default affects every match without
    // an override and the panel must re-render.
    notifyDefaultChanged() {
        const def = this._defaultMuted();
        let changed = false;
        for (const [id, o] of this._overrides) {
            if (o.muted === def) {
                this._overrides.delete(id);
                changed = true;
            }
        }
        if (changed)
            this._persist();
        this._emit();
    }

    // --- subscription -------------------------------------------------------

    // Register a callback fired whenever the effective mute state changes.
    // Returns an unsubscribe function.
    subscribe(cb) {
        this._subs.add(cb);
        return () => this._subs.delete(cb);
    }

    dispose() {
        this._subs.clear();
        this._overrides.clear();
    }

    // --- internals ----------------------------------------------------------

    _defaultMuted() {
        return !!this._isDefaultMuted();
    }

    _normalizeOverride(raw, now) {
        if (raw && typeof raw === 'object') {
            const ts = Number(raw.at);
            return { muted: !!raw.muted, at: Number.isFinite(ts) ? ts : now };
        }
        // Legacy shape: a bare timestamp meant "muted at <ts>".
        const ts = Number(raw);
        return { muted: true, at: Number.isFinite(ts) ? ts : now };
    }

    // Force id to the desired absolute muted state and commit if anything moved.
    _setAbsolute(id, mute) {
        if (this._applyAbsolute(id, mute))
            this._commit();
    }

    // Force id to the desired absolute muted state WITHOUT committing; returns
    // whether the stored set changed. An override is kept only when it deviates
    // from the ambient default, so the map stays minimal.
    _applyAbsolute(id, mute) {
        const want = !!mute;
        if (want === this._defaultMuted()) {
            // Ambient default already yields the desired state -> drop override.
            return this._overrides.delete(id);
        }
        const cur = this._overrides.get(id);
        if (cur && cur.muted === want)
            return false; // already deviating exactly this way
        this._overrides.set(id, { muted: want, at: Date.now() });
        return true;
    }

    _commit() {
        this._persist();
        this._emit();
    }

    _persist() {
        const obj = Object.fromEntries(this._overrides);
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
