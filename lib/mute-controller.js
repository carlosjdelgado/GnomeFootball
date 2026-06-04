// The single in-memory owner of per-match mute state, shared by the notifier,
// poller and panel. Persisted to muted-matches.json (kept out of live-state.json,
// which the poller rewrites each tick, to avoid a clobber race); entries are
// transient, pruned at full-time and aged out.
//
// The map stores OVERRIDES — per-match deviations from the "mute by default"
// setting, each recording its absolute muted value so flipping the default never
// re-interprets existing ones. Storage and the default getter are injected.

import { readJson as defaultRead, writeJson as defaultWrite, MUTED_MATCHES_FILE } from './storage.js';

// Backstop expiry for overrides whose match drops out before we see its
// full-time; gives the "gone by the next day" property. afterTick is the normal path.
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

    // Load persisted overrides, dropping expired ones. Emits once so a panel built
    // before the load picks up restored state. Accepts the legacy bare-number shape too.
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

    isMuted(eventId) {
        const o = this._overrides.get(String(eventId));
        return o ? o.muted : this._defaultMuted();
    }

    // True only when every listed id is muted (and there is at least one).
    // Drives the panel's "Mute all" / "Un-mute all" toggle label.
    areAllMuted(ids) {
        const arr = (ids ?? []).map(String).filter(Boolean);
        return arr.length > 0 && arr.every(id => this.isMuted(id));
    }

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

    // Bulk mute: forces each listed id to the desired state, exactly like
    // pressing the per-match button on every one.
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

    // Called by the poller after each tick: expires overrides for matches that
    // reached full-time and ages out stragglers. One persist/emit per batch.
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

    // Called when "mute by default" flips: prune overrides that now match the
    // default, and always emit (the default affects every match without one).
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

    // Register a callback fired on every mute-state change; returns an unsubscribe.
    subscribe(cb) {
        this._subs.add(cb);
        return () => this._subs.delete(cb);
    }

    dispose() {
        this._subs.clear();
        this._overrides.clear();
    }

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

    _setAbsolute(id, mute) {
        if (this._applyAbsolute(id, mute))
            this._commit();
    }

    // Force id to the desired state without committing; returns whether the set
    // changed. An override is kept only when it deviates from the default.
    _applyAbsolute(id, mute) {
        const want = !!mute;
        if (want === this._defaultMuted())
            return this._overrides.delete(id);
        const cur = this._overrides.get(id);
        if (cur && cur.muted === want)
            return false;
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
