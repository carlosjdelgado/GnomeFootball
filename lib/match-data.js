// Date-aware data layer for the calendar panel. "Today" comes from the live
// poller snapshot; other dates are fetched on demand and cached in memory.
// ESPN's `dates` param is UTC, so we fetch a day±1 range and filter by local key.

import { fetchScoreboardForDate } from './sports-api.js';
import { isDarkTheme, pickLogo } from './theme.js';
import {
    toMatchView,
    compareMatchViews,
    localDateKey,
    utcRangeForLocalDay,
    matchViewPassesSubscription,
} from './match-model.js';

export class MatchDataProvider {
    // fetchScoreboard is injectable for unit testing (defaults to the real API).
    constructor(settings, { fetchScoreboard = fetchScoreboardForDate } = {}) {
        this._settings = settings;
        this._fetchScoreboard = fetchScoreboard;
        // Map<dateKey, Map<slug, matchView[]>> — cached per-day AND per-league so
        // a newly subscribed league re-fetches just itself on a visited day. Today
        // is never cached.
        this._cache = new Map();
    }

    _readSubscriptions() {
        try {
            return JSON.parse(this._settings.get_string('subscriptions-json') || '{}');
        } catch (_) {
            return {};
        }
    }

    // For today, delegates to todayProvider() (the poller snapshot); otherwise
    // fetches + caches.
    async getMatchesForDate(date, { todayProvider = null, cancellable = null } = {}) {
        const dateKey = localDateKey(date.getTime());
        const todayKey = localDateKey(Date.now());
        const subscriptions = this._readSubscriptions();

        let matches;
        if (dateKey === todayKey)
            matches = todayProvider ? todayProvider() : [];
        else
            matches = await this._collectForDateKey(date, dateKey, subscriptions, cancellable);

        // Re-filter against current subscriptions: the cache stores leagues
        // unfiltered and the today snapshot may predate a subscription change.
        return matches.filter(
            view => matchViewPassesSubscription(view, subscriptions[view.leagueSlug]));
    }

    // True when getMatchesForDate resolves without a fetch (today, no subscriptions,
    // or every subscribed league cached). Lets the panel skip the placeholder.
    hasImmediateData(date) {
        const dateKey = localDateKey(date.getTime());
        if (dateKey === localDateKey(Date.now()))
            return true;
        const slugs = Object.keys(this._readSubscriptions());
        if (slugs.length === 0)
            return true;
        const dayCache = this._cache.get(dateKey);
        if (!dayCache)
            return false;
        return slugs.every(slug => dayCache.has(slug));
    }

    // Gather a day's matches across subscribed leagues, fetching only those not
    // already cached for that day.
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
            // Cache only non-empty results, so an empty day (no fixtures yet, or
            // a cancelled fetch) re-fetches next visit instead of sticking empty.
            if (views.length > 0)
                this._setCached(dateKey, slug, views);
            return views;
        }));

        return perLeague.flat().sort(compareMatchViews);
    }

    // Fetch one league's matches on the local day, unfiltered by subscription
    // detail (the read-time filter handles team/league narrowing).
    async _fetchLeagueForDateKey(slug, range, dateKey, isDark, cancellable) {
        try {
            const scoreboard = await this._fetchScoreboard(slug, range, cancellable);
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
