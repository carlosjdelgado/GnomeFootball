// Periodic poller that queries the upstream API for subscribed leagues, runs the
// event detector over each live (or about-to-start) match, and dispatches notifications.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    ALL_EVENT_TYPES,
    EVENT_TYPE,
    MATCH_STATE,
    PRE_MATCH_WATCH_WINDOW_MINUTES,
    SUBSCRIPTION_MODE,
} from './constants.js';
import { fetchScoreboard, fetchSummary, disposeSession } from './sports-api.js';
import { detectEvents, pruneLiveState } from './event-detector.js';
import { notifyEvent } from './notifier.js';
import { LIVE_STATE_FILE, readJson, writeJson } from './storage.js';

const SECONDS_PER_MINUTE = 60;

export class Poller {
    constructor(settings) {
        this._settings = settings;
        this._timerId = 0;
        this._cancellable = null;
        this._running = false;
        this._signalHandlers = [];
    }

    enable() {
        this._scheduleNextTick(/* immediate */ true);

        // React to settings changes affecting the schedule or trigger an immediate run.
        const intervalHandler = this._settings.connect(
            'changed::poll-interval-minutes',
            () => this._rescheduleAfterIntervalChange()
        );
        this._signalHandlers.push(intervalHandler);

        const forceHandler = this._settings.connect(
            'changed::force-check-trigger',
            () => this._safeTick()
        );
        this._signalHandlers.push(forceHandler);
    }

    _safeTick() {
        this._runTickAsync().catch(e =>
            console.warn(`[GnomeFootball] tick failed: ${e.message}`)
        );
    }

    disable() {
        for (const id of this._signalHandlers)
            this._settings.disconnect(id);
        this._signalHandlers = [];

        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        this._cancellable = null;
        disposeSession();
    }

    _intervalSeconds() {
        const minutes = this._settings.get_int('poll-interval-minutes');
        return Math.max(1, Math.min(30, minutes)) * SECONDS_PER_MINUTE;
    }

    _scheduleNextTick(immediate = false) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }

        const intervalSeconds = this._intervalSeconds();

        const fire = () => {
            this._safeTick();
            // After the tick (which is async), schedule the next one.
            this._scheduleNextTick(false);
        };

        if (immediate) {
            // Run shortly after startup, then on the normal cadence.
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                this._timerId = 0;
                fire();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
                this._timerId = 0;
                fire();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _rescheduleAfterIntervalChange() {
        // Restart with the new interval. We do not run a tick immediately on
        // interval change — wait until the next scheduled fire.
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        const intervalSeconds = this._intervalSeconds();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, intervalSeconds, () => {
            this._timerId = 0;
            this._safeTick();
            this._scheduleNextTick(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _readSubscriptions() {
        try {
            return JSON.parse(this._settings.get_string('subscriptions-json') || '{}');
        } catch (_) {
            return {};
        }
    }

    _readEnabledEvents() {
        const enabled = {};
        for (const evType of ALL_EVENT_TYPES)
            enabled[evType] = this._settings.get_boolean(`event-${evType}`);
        return enabled;
    }

    _matchPassesSubscription(scoreboardEvent, subscription) {
        if (!subscription)
            return false;
        if (subscription.mode === SUBSCRIPTION_MODE.ALL)
            return true;
        if (subscription.mode === SUBSCRIPTION_MODE.TEAMS) {
            const teamIds = new Set(subscription.teams ?? []);
            if (teamIds.size === 0)
                return false;
            const competitors = scoreboardEvent.competitions?.[0]?.competitors ?? [];
            return competitors.some(c => teamIds.has(String(c.id)));
        }
        return false;
    }

    _isMatchRelevant(scoreboardEvent) {
        const state = String(scoreboardEvent.status?.type?.state ?? '').toLowerCase();
        if (state === MATCH_STATE.IN)
            return true;

        if (state === MATCH_STATE.PRE) {
            const isoDate = scoreboardEvent.date;
            if (!isoDate)
                return false;
            const startMs = Date.parse(isoDate);
            if (isNaN(startMs))
                return false;
            const minutesUntilStart = (startMs - Date.now()) / 60_000;
            return minutesUntilStart <= PRE_MATCH_WATCH_WINDOW_MINUTES && minutesUntilStart > -2;
        }

        // POST: emit final whistle once and then we can stop polling it.
        if (state === MATCH_STATE.POST)
            return true;

        return false;
    }

    async _runTickAsync() {
        if (this._running)
            return;
        this._running = true;
        this._cancellable = new Gio.Cancellable();

        try {
            const subscriptions = this._readSubscriptions();
            const subscribedSlugs = Object.keys(subscriptions);
            if (subscribedSlugs.length === 0)
                return;

            const enabledEvents = this._readEnabledEvents();
            const liveState = await readJson(LIVE_STATE_FILE, {});

            for (const slug of subscribedSlugs) {
                if (this._cancellable.is_cancelled())
                    return;
                await this._processLeague(slug, subscriptions[slug], enabledEvents, liveState);
            }

            const pruned = pruneLiveState(liveState);
            await writeJson(LIVE_STATE_FILE, pruned);
        } finally {
            this._cancellable = null;
            this._running = false;
        }
    }

    async _processLeague(slug, subscription, enabledEvents, liveState) {
        let scoreboard;
        try {
            scoreboard = await fetchScoreboard(slug, this._cancellable);
        } catch (e) {
            console.warn(`[GnomeFootball] scoreboard ${slug} failed: ${e.message}`);
            return { tracked: 0, notified: 0 };
        }

        const leagueName = scoreboard?.leagues?.[0]?.name ?? slug;
        const leagueLogo = scoreboard?.leagues?.[0]?.logos?.[0]?.href ?? '';
        const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];

        let tracked = 0;
        let notified = 0;
        for (const scoreboardEvent of events) {
            if (this._cancellable.is_cancelled())
                return { tracked, notified };
            if (!this._matchPassesSubscription(scoreboardEvent, subscription))
                continue;
            if (!this._isMatchRelevant(scoreboardEvent))
                continue;

            scoreboardEvent.leagueSlug = slug;
            scoreboardEvent.leagueName = leagueName;
            scoreboardEvent.leagueLogo = leagueLogo;

            const eventId = String(scoreboardEvent.id);
            const previousState = liveState[eventId];

            // Only fetch summary (plays) when in progress; pre/post don't need it.
            let summary = null;
            const state = String(scoreboardEvent.status?.type?.state ?? '').toLowerCase();
            if (state === MATCH_STATE.IN) {
                try {
                    summary = await fetchSummary(slug, eventId, this._cancellable);
                } catch (e) {
                    console.warn(`[GnomeFootball] summary ${slug}/${eventId} failed: ${e.message}`);
                }
            }

            const { events: detectedEvents, nextState } = detectEvents({
                scoreboardEvent,
                summary,
                previousState,
                enabledEvents,
            });

            for (const detected of detectedEvents) {
                notifyEvent(detected).catch(e => {
                    console.warn(`[GnomeFootball] notify failed: ${e.message}`);
                });
            }
            notified += detectedEvents.length;

            liveState[eventId] = nextState;
            tracked++;
        }

        return { tracked, notified };
    }
}
