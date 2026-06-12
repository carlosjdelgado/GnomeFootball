// Periodic poller that queries the upstream API for subscribed leagues, runs the
// event detector over each live (or about-to-start) match, and dispatches notifications.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    ALL_EVENT_TYPES,
    EVENT_TYPE,
    MATCH_STATE,
    PRE_MATCH_WATCH_WINDOW_MINUTES,
} from './constants.js';
import { fetchScoreboardForDate, fetchSummary, disposeSession } from './sports-api.js';
import { detectEvents, pruneLiveState } from './event-detector.js';
import { notifyEvent } from './notifier.js';
import { LIVE_STATE_FILE, readJson, writeJson } from './storage.js';
import { pickLogo, isDarkTheme } from './theme.js';
import { toMatchView, compareMatchViews, localDateKey, utcRangeForLocalDay, matchPassesSubscription } from './match-model.js';

const SECONDS_PER_MINUTE = 60;

// Lowercased match state ('pre' | 'in' | 'post') from a raw scoreboard event.
function eventState(scoreboardEvent) {
    return String(scoreboardEvent.status?.type?.state ?? '').toLowerCase();
}

export class Poller {
    constructor(settings, mute = null) {
        this._settings = settings;
        this._timerId = 0;
        this._cancellable = null;
        this._running = false;
        this._signalHandlers = [];
        // Per-league snapshot of the current scoreboard, keyed by slug. Refreshed
        // every tick and consumed by the calendar panel for "today".
        this._todayMatches = new Map();
        this._onUpdate = null;
        // Mute controller: consulted before dispatching and told which matches
        // finished so it can auto-expire their mutes. Null until wired in.
        this._mute = mute;
    }

    // Register a callback fired after each poll tick so the panel can refresh.
    setOnUpdate(cb) {
        this._onUpdate = cb ?? null;
    }

    // A fresh, sorted copy of today's matches across subscribed leagues, filtered
    // to the LOCAL today. Safe for the panel to consume (not internal state).
    getTodayMatches() {
        const todayKey = localDateKey(Date.now());
        const all = [];
        for (const views of this._todayMatches.values()) {
            for (const view of views) {
                if (view.kickoffMs != null && localDateKey(view.kickoffMs) === todayKey)
                    all.push(view);
            }
        }
        all.sort(compareMatchViews);
        return all;
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
        this._todayMatches.clear();
        this._onUpdate = null;
        this._mute = null;
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
        // MATCH_REMINDER lives outside ALL_EVENT_TYPES (it carries its own
        // lead-time setting), so read it explicitly.
        enabled[EVENT_TYPE.MATCH_REMINDER] = this._settings.get_boolean('event-match-reminder');
        return enabled;
    }

    _reminderLeadMinutes() {
        const minutes = this._settings.get_int('reminder-lead-minutes');
        return Math.max(5, Math.min(180, minutes));
    }

    _matchPassesSubscription(scoreboardEvent, subscription) {
        return matchPassesSubscription(scoreboardEvent, subscription);
    }

    _isMatchRelevant(scoreboardEvent, preWindowMinutes) {
        const state = eventState(scoreboardEvent);
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
            return minutesUntilStart <= preWindowMinutes && minutesUntilStart > -2;
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
            if (subscribedSlugs.length === 0) {
                // No subscriptions: clear the panel snapshot and notify.
                if (this._todayMatches.size > 0) {
                    this._todayMatches.clear();
                    this._notifyUpdate();
                }
                return;
            }

            const enabledEvents = this._readEnabledEvents();
            const liveState = await readJson(LIVE_STATE_FILE, {});

            // When the reminder is on we must start tracking PRE matches early
            // enough to fire the lead-time notification; widen the watch window
            // accordingly. /summary is never fetched for PRE, so this adds no
            // extra HTTP cost — only earlier liveState bookkeeping.
            const reminderLeadMinutes = this._reminderLeadMinutes();
            const preWindowMinutes = enabledEvents[EVENT_TYPE.MATCH_REMINDER]
                ? Math.max(PRE_MATCH_WATCH_WINDOW_MINUTES, reminderLeadMinutes)
                : PRE_MATCH_WATCH_WINDOW_MINUTES;

            for (const slug of subscribedSlugs) {
                if (this._cancellable.is_cancelled())
                    return;
                await this._processLeague(
                    slug, subscriptions[slug], enabledEvents, liveState,
                    reminderLeadMinutes, preWindowMinutes);
            }

            // Drop snapshot entries for leagues no longer subscribed.
            const subscribedSet = new Set(subscribedSlugs);
            for (const slug of this._todayMatches.keys()) {
                if (!subscribedSet.has(slug))
                    this._todayMatches.delete(slug);
            }

            const pruned = pruneLiveState(liveState);
            await writeJson(LIVE_STATE_FILE, pruned);

            // Expire mutes for matches that reached full-time (afterTick is
            // idempotent, so re-passing a still-listed POST match is harmless).
            if (this._mute) {
                const finishedIds = Object.entries(pruned)
                    .filter(([, snap]) => snap.state === MATCH_STATE.POST)
                    .map(([eventId]) => eventId);
                this._mute.afterTick(finishedIds);
            }

            this._notifyUpdate();
        } finally {
            this._cancellable = null;
            this._running = false;
        }
    }

    _notifyUpdate() {
        if (!this._onUpdate)
            return;
        try {
            this._onUpdate();
        } catch (e) {
            console.warn(`[GnomeFootball] panel update callback failed: ${e.message}`);
        }
    }

    async _processLeague(slug, subscription, enabledEvents, liveState, reminderLeadMinutes, preWindowMinutes) {
        let scoreboard;
        try {
            // Fetch the local day ±1 (UTC) so a match played in the local early
            // morning — which ESPN files under its previous day — still reaches
            // the panel snapshot. getTodayMatches() filters back to local today.
            const range = utcRangeForLocalDay(new Date());
            scoreboard = await fetchScoreboardForDate(slug, range, this._cancellable);
        } catch (e) {
            console.warn(`[GnomeFootball] scoreboard ${slug} failed: ${e.message}`);
            return { tracked: 0, notified: 0 };
        }

        const leagueName = scoreboard?.leagues?.[0]?.name ?? slug;
        const leagueLogo = pickLogo(scoreboard?.leagues?.[0]?.logos);
        const events = Array.isArray(scoreboard?.events) ? scoreboard.events : [];

        // Panel snapshot: every subscribed match, not gated by _isMatchRelevant
        // (the panel lists the whole day, including pre-match ones far off).
        const league = { slug, name: leagueName, logo: leagueLogo };
        const isDark = isDarkTheme();
        const views = events
            .filter(ev => this._matchPassesSubscription(ev, subscription))
            .map(ev => toMatchView(ev, league, isDark));
        this._todayMatches.set(slug, views);

        let tracked = 0;
        let notified = 0;
        for (const scoreboardEvent of events) {
            if (this._cancellable.is_cancelled())
                return { tracked, notified };
            if (!this._matchPassesSubscription(scoreboardEvent, subscription))
                continue;
            if (!this._isMatchRelevant(scoreboardEvent, preWindowMinutes))
                continue;

            scoreboardEvent.leagueSlug = slug;
            scoreboardEvent.leagueName = leagueName;
            scoreboardEvent.leagueLogo = leagueLogo;

            const eventId = String(scoreboardEvent.id);
            const previousState = liveState[eventId];

            // Only fetch summary (plays) when in progress; pre/post don't need it.
            let summary = null;
            const state = eventState(scoreboardEvent);
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
                reminderLeadMinutes,
            });

            // Suppress dispatch for a muted match, but still advance liveState so
            // un-muting mid-match resumes from "now" rather than replaying.
            const muted = this._mute ? this._mute.isMuted(eventId) : false;
            if (!muted) {
                for (const detected of detectedEvents) {
                    notifyEvent(detected).catch(e => {
                        console.warn(`[GnomeFootball] notify failed: ${e.message}`);
                    });
                }
                notified += detectedEvents.length;
            }

            liveState[eventId] = nextState;
            tracked++;
        }

        return { tracked, notified };
    }
}
