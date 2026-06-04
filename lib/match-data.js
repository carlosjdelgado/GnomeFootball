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
        // Map<dateKey, Map<slug, matchView[]>>. Caching is per-day AND
        // per-competition: each league's matches for a day are cached
        // independently, so subscribing to a NEW league re-fetches just that
        // league for an already-visited day (a day-level cache would hide it,
        // since the read-time subscription filter can only drop matches, never
        // resurrect ones that were never fetched). Today is never cached.
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
        if (dateKey === todayKey)
            matches = todayProvider ? todayProvider() : [];
        else
            matches = await this._collectForDateKey(date, dateKey, subscriptions, cancellable);

        // Re-filter against the CURRENT subscriptions, whatever the source. The
        // per-league cache stores each league's matches UNFILTERED, and the
        // live "today" snapshot may have been built while a league/team was
        // still subscribed — so this read-time filter is what enforces the
        // current subscriptions: it both drops leagues/teams the user has since
        // unsubscribed from and surfaces teams added within an already-cached
        // league.
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
        if (dateKey === localDateKey(Date.now()))
            return true;
        const slugs = Object.keys(this._readSubscriptions());
        // No subscriptions → resolves to an empty list without any fetch.
        if (slugs.length === 0)
            return true;
        const dayCache = this._cache.get(dateKey);
        if (!dayCache)
            return false;
        // Immediate only if EVERY currently-subscribed league is already cached
        // for this day; a single missing league still warrants a network fetch
        // (and thus the loading placeholder).
        return slugs.every(slug => dayCache.has(slug));
    }

    // Gather a day's matches across all currently-subscribed leagues, fetching
    // (and caching) only the leagues not already cached for that day.
    async _collectForDateKey(date, dateKey, subscriptions, cancellable) {
        const slugs = Object.keys(subscriptions);
        if (slugs.length === 0)
            return [];

        const range = utcRangeForLocalDay(date);
        const isDark = isDarkTheme();
        const dayCache = this._cache.get(dateKey);

        const perLeague = await Promise.all(slugs.map(async slug => {
            if (dayCache && dayCache.has(slug))
                return dayCache.get(slug);
            const views = await this._fetchLeagueForDateKey(slug, range, dateKey, isDark, cancellable);
            // Cache only non-empty results. An empty array usually means the
            // league has no match that day, or its data isn't available *yet*
            // (a future day ESPN hasn't populated, or a transient/cancelled
            // fetch) — caching it would "stick" the empty state for the rest of
            // the session even after matches appear. Re-fetching an empty
            // league on the next visit is cheap and self-healing; leagues that
            // do have matches are cached for instant re-renders.
            if (views.length > 0)
                this._setCached(dateKey, slug, views);
            return views;
        }));

        const all = [];
        for (const views of perLeague)
            all.push(...views);
        all.sort(compareMatchViews);
        return all;
    }

    // Fetch a single league's matches that fall on the requested LOCAL day,
    // UNFILTERED by subscription detail (the read-time filter in
    // getMatchesForDate handles team/league narrowing, so the cache stays valid
    // across subscription changes within a league).
    async _fetchLeagueForDateKey(slug, range, dateKey, isDark, cancellable) {
        try {
            const scoreboard = await fetchScoreboardForDate(slug, range, cancellable);
            const leagueName = scoreboard?.leagues?.[0]?.name ?? slug;
            const leagueLogo = pickLogo(scoreboard?.leagues?.[0]?.logos);
            const league = { slug, name: leagueName, logo: leagueLogo };
            const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];
            return events
                .map(ev => toMatchView(ev, league, isDark))
                .filter(view => view.kickoffMs != null
                    && localDateKey(view.kickoffMs) === dateKey);
        } catch (e) {
            console.warn(`[GnomeFootball] scoreboard ${slug} (${range}) failed: ${e.message}`);
            return [];
        }
    }

    _setCached(dateKey, slug, views) {
        let dayCache = this._cache.get(dateKey);
        if (!dayCache) {
            dayCache = new Map();
            this._cache.set(dateKey, dayCache);
        }
        dayCache.set(slug, views);
    }

    clearCache() {
        this._cache.clear();
    }
}
