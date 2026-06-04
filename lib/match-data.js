// Date-aware data layer for the calendar panel (Feature 1).
//
// "Today" comes from the live poller snapshot (no re-fetch). Other dates are
// fetched on demand from the scoreboard endpoint and cached in memory for the
// session (no disk persistence — roadmap D4).
//
// Timezone handling (roadmap risk): ESPN's `dates` parameter is UTC, but the
// user's local day can straddle two UTC dates. We therefore fetch a day±1 range
// and filter the results client-side by local date key.

import { fetchScoreboardForDate } from './sports-api.js';
import { isDarkTheme, pickLogo } from './theme.js';
import {
    toMatchView,
    compareMatchViews,
    localDateKey,
    matchPassesSubscription,
    matchViewPassesSubscription,
} from './match-model.js';

// UTC date range string (YYYYMMDD-YYYYMMDD) spanning the local day ±1, wide
// enough to capture every match that falls on the local day regardless of the
// user's UTC offset.
function utcRangeForLocalDay(date) {
    const prev = new Date(date.getTime());
    prev.setDate(prev.getDate() - 1);
    const next = new Date(date.getTime());
    next.setDate(next.getDate() + 1);
    return `${localDateKey(prev.getTime())}-${localDateKey(next.getTime())}`;
}

export class MatchDataProvider {
    constructor(settings) {
        this._settings = settings;
        // Map<dateKey, matchView[]>. Today is never cached (always live).
        this._cache = new Map();
    }

    _readSubscriptions() {
        try {
            return JSON.parse(this._settings.get_string('subscriptions-json') || '{}');
        } catch (_) {
            return {};
        }
    }

    // Returns the matches for `date` (a JS Date). For today, delegates to
    // `todayProvider()` (the poller snapshot). Otherwise fetches + caches.
    async getMatchesForDate(date, { todayProvider = null, cancellable = null } = {}) {
        const dateKey = localDateKey(date.getTime());
        const todayKey = localDateKey(Date.now());
        const subscriptions = this._readSubscriptions();

        let matches;
        if (dateKey === todayKey) {
            matches = todayProvider ? todayProvider() : [];
        } else if (this._cache.has(dateKey)) {
            matches = this._cache.get(dateKey);
        } else {
            matches = await this._fetchForDateKey(date, dateKey, cancellable);
            // Cache only non-empty results. An empty array usually means the
            // day's data isn't available *yet* (a future day ESPN hasn't
            // populated, or a transient/cancelled fetch) — caching it would
            // "stick" the empty state for the rest of the session even after the
            // matches appear (and would poison a day the user browsed before its
            // data was on disk). Re-fetching an empty day on the next visit is
            // cheap and self-healing; days that do have matches are still cached
            // for instant re-renders.
            if (matches.length > 0)
                this._cache.set(dateKey, matches);
        }

        // Re-filter against the CURRENT subscriptions, whatever the source. The
        // fetch path already filtered (no-op here), but a cached day or the live
        // "today" snapshot may have been built while a league was still
        // subscribed — never surface matches for a league/team the user has
        // since unsubscribed from.
        return matches.filter(
            view => matchViewPassesSubscription(view, subscriptions[view.leagueSlug]));
    }

    // True when getMatchesForDate will resolve WITHOUT a network fetch — the
    // date is today (served from the live poller snapshot) or a previously
    // cached day. The panel uses this to decide whether to show a "loading"
    // placeholder: a real fetch warrants one, an instant result does not (which
    // would otherwise flicker the placeholder in and straight back out).
    hasImmediateData(date) {
        const dateKey = localDateKey(date.getTime());
        return dateKey === localDateKey(Date.now()) || this._cache.has(dateKey);
    }

    async _fetchForDateKey(date, dateKey, cancellable) {
        const subscriptions = this._readSubscriptions();
        const slugs = Object.keys(subscriptions);
        if (slugs.length === 0)
            return [];

        const range = utcRangeForLocalDay(date);
        const isDark = isDarkTheme();
        const all = [];

        const results = await Promise.all(slugs.map(async slug => {
            try {
                const scoreboard = await fetchScoreboardForDate(slug, range, cancellable);
                const leagueName = scoreboard?.leagues?.[0]?.name ?? slug;
                const leagueLogo = pickLogo(scoreboard?.leagues?.[0]?.logos);
                const league = { slug, name: leagueName, logo: leagueLogo };
                const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
                return events
                    .filter(ev => matchPassesSubscription(ev, subscriptions[slug]))
                    .map(ev => toMatchView(ev, league, isDark));
            } catch (e) {
                console.warn(`[GnomeFootball] scoreboard ${slug} (${range}) failed: ${e.message}`);
                return [];
            }
        }));

        for (const views of results) {
            for (const view of views) {
                // Keep only matches that land on the requested LOCAL day.
                if (view.kickoffMs != null && localDateKey(view.kickoffMs) === dateKey)
                    all.push(view);
            }
        }
        all.sort(compareMatchViews);
        return all;
    }

    clearCache() {
        this._cache.clear();
    }
}
