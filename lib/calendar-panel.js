// Calendar-integrated match panel (Feature 1).
//
// Builds a custom section widget and injects it into the Shell's DateMenu popup,
// alongside the weather / world-clocks / events sections. It shows the matches
// for the day currently selected in the calendar: "today" from the live poller
// snapshot (refreshed via setOnUpdate), other days fetched on demand through the
// date-aware data layer (match-data.js).
//
// Why a custom widget (not a MessageList subclass): the Shell's message-list
// classes were rewritten in 45+ and `MessageListSection` no longer exists. The
// integration points used here were validated against the upstream gnome-shell
// source for the supported versions (48, 49, 50): the displays container is
// `dateMenu._displaysSection.child` (a vertical St.BoxLayout), the calendar is
// `dateMenu._calendar`, and the date-change signal is `selected-date-changed`
// (emitting a GLib.DateTime). All identical across 48/49/50, so a single
// code-path serves every supported version.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import { getIcon as getCachedIcon } from './crest-cache.js';
import { isDarkTheme } from './theme.js';
import { localDateKey, groupMatchesByCompetition } from './match-model.js';

// We insert our card just below the events (reminders) section so the user's
// calendar events stay on top; INSERT_INDEX is only the fallback used when that
// section can't be located in the displays box.
const INSERT_INDEX = 0;
const CREST_ICON_SIZE = 22;
const LEAGUE_ICON_SIZE = 18;

// Grid geometry. All match rows share ONE grid so the score sits in the same
// column (same X) on every row regardless of how wide each team's abbreviation
// is — a 4-letter acronym just widens its column, it never shifts the score.
const COL_SPACING = 8;          // horizontal gap between grid columns
const ROW_SPACING = 4;          // vertical gap between match rows
const HEADER_GAP_BELOW = 6;     // extra gap from a league title to its rows
const HEADER_GAP_ABOVE = 10;    // extra gap above a league title (between leagues)
// Column indices: crest | abbrev | score | abbrev | crest | minute | (mute, F3).
// The minute column stays blank unless the match is live (state 'in'); the mute
// bell (Feature 3) lives in an expanding column so it hugs the card's right edge.
const MATCH_COLUMNS = 6;     // crest|abbrev|score|abbrev|crest|minute
const MINUTE_COLUMN = 5;
const MUTE_COLUMN = 6;       // bell column, only present when a mute controller is set

function gettext(text) {
    // Same approach as notifier.js: resolve via the gettext domain directly so
    // this module needs no init wiring.
    return GLib.dgettext('gnomefootball', text) || text;
}

function fallbackGicon() {
    return new Gio.ThemedIcon({ name: 'applications-games-symbolic' });
}

// A St.Icon whose gicon is filled in asynchronously from the crest cache, keyed
// by `cacheKey`. Shows a neutral fallback until (and unless) the icon resolves.
function makeRemoteIcon(cacheKey, url, cancellable, size, styleClass) {
    const icon = new St.Icon({
        gicon: fallbackGicon(),
        icon_size: size,
        style_class: styleClass,
    });
    if (cacheKey && url) {
        getCachedIcon(cacheKey, url, cancellable)
            .then(gicon => { icon.gicon = gicon; })
            .catch(() => { /* keep fallback */ });
    }
    return icon;
}

// Team crest (per-side, in a match row).
function makeCrestIcon(team, cancellable) {
    const id = team?.id;
    const variant = isDarkTheme() ? 'dark' : 'light';
    const key = id ? `team-${id}-${variant}` : '';
    return makeRemoteIcon(key, team?.logo, cancellable, CREST_ICON_SIZE, 'gf-match-crest');
}

// Competition logo (in a group header).
function makeLeagueIcon(group, cancellable) {
    const variant = isDarkTheme() ? 'dark' : 'light';
    const key = group?.slug ? `league-${group.slug}-${variant}` : '';
    return makeRemoteIcon(key, group?.logo, cancellable, LEAGUE_ICON_SIZE, 'gf-competition-logo');
}

// Local "HH:MM" for a kickoff timestamp, in the user's locale/timezone.
function formatKickoff(kickoffMs) {
    if (kickoffMs == null)
        return '';
    return new Date(kickoffMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Center column text for a match: kickoff time before the game, live/final
// score once it has started.
function scoreOrTime(match) {
    if (match.state === 'pre')
        return formatKickoff(match.kickoffMs);
    return `${match.homeScore} - ${match.awayScore}`;
}

// The live clock for a match in progress (e.g. "67'", "HT"); empty otherwise so
// the minute column stays blank before kick-off and after full time.
function liveMinute(match) {
    return match.state === 'in' ? (match.statusDetail || '') : '';
}

export class CalendarPanel {
    // mute (optional, supplied by Feature 3) is a controller:
    //   { isMuted(eventId), toggle(eventId), areAllMuted(ids), toggleAll(ids, mute),
    //     subscribe(cb) -> unsubscribe }
    // When absent, the per-row bell and the header Mute-all button are hidden.
    constructor({ settings, dataProvider, getTodayMatches, mute = null }) {
        this._settings = settings;
        this._dataProvider = dataProvider;
        this._getTodayMatches = getTodayMatches;
        this._mute = mute;

        this._section = null;       // root St.BoxLayout injected into the DateMenu
        this._listBox = null;       // body holding rows / empty state
        this._muteAllButton = null;
        this._displaysBox = null;   // the DateMenu container we injected into

        this._calendarSignalId = 0;
        this._settingsSignalId = 0;
        this._muteUnsubscribe = null;
        this._cancellable = null;
        this._renderGen = 0;
        this._selectedDate = new Date();
        this._currentMatches = [];
    }

    enable() {
        this._settingsSignalId = this._settings.connect(
            'changed::show-today-panel', () => this._syncVisibility());
        this._syncVisibility();
    }

    disable() {
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = 0;
        }
        this._teardownSection();
    }

    // Called by the poller after every tick: refresh only if the calendar is on
    // today (other days come from the cached/fetched data layer, not the poller).
    refreshIfToday() {
        if (!this._section)
            return;
        if (localDateKey(this._selectedDate.getTime()) === localDateKey(Date.now()))
            this._render();
    }

    // --- injection lifecycle ------------------------------------------------

    _syncVisibility() {
        const show = this._settings.get_boolean('show-today-panel');
        if (show && !this._section)
            this._buildSection();
        else if (!show && this._section)
            this._teardownSection();
    }

    _displaysContainer() {
        // dateMenu._displaysSection is an St.ScrollView; its .child is the
        // vertical displaysBox holding the weather/clocks/events sections.
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        return dateMenu?._displaysSection?.child ?? null;
    }

    _buildSection() {
        const dateMenu = Main.panel?.statusArea?.dateMenu;
        const container = this._displaysContainer();
        const calendar = dateMenu?._calendar;
        if (!container || !calendar) {
            console.warn('[GnomeFootball] DateMenu internals not found; panel disabled');
            return;
        }

        // Reuse the Shell's native card class (shared by the weather, world-
        // clocks and events sections) so our card matches them exactly — the
        // background, border, radius and padding all come from the active theme,
        // which gives us correct light/dark styling for free. The internal
        // layout (spacing) is the only thing we set ourselves.
        this._section = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'gf-match-section world-clocks-button',
            style: 'spacing: 6px;',
        });

        this._section.add_child(this._buildHeader());

        // The listBox holds a single child: either the match grid (all leagues)
        // or the empty-state label. Per-league and per-row spacing is handled
        // inside the grid, so no spacing is needed here.
        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._section.add_child(this._listBox);

        // Place the card right below the events (reminders) section. Fall back
        // to the top of the box only if that section can't be located.
        let index = INSERT_INDEX;
        const eventsItem = dateMenu?._eventsItem ?? null;
        if (eventsItem) {
            const at = container.get_children().indexOf(eventsItem);
            if (at >= 0)
                index = at + 1;
        }
        container.insert_child_at_index(this._section, index);
        this._displaysBox = container;

        // Seed the selected date from the calendar's current selection, then
        // react to changes.
        if (calendar._selectedDate instanceof Date)
            this._selectedDate = new Date(calendar._selectedDate.getTime());
        this._calendarSignalId = calendar.connect(
            'selected-date-changed', (_cal, datetime) => this._onDateChanged(datetime));

        if (this._mute)
            this._muteUnsubscribe = this._mute.subscribe(() => this._render());

        this._render();
    }

    _teardownSection() {
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        this._cancellable = null;

        const calendar = Main.panel?.statusArea?.dateMenu?._calendar;
        if (this._calendarSignalId && calendar) {
            calendar.disconnect(this._calendarSignalId);
        }
        this._calendarSignalId = 0;

        if (this._muteUnsubscribe) {
            try { this._muteUnsubscribe(); } catch (_) { /* ignore */ }
            this._muteUnsubscribe = null;
        }

        if (this._section) {
            this._section.destroy();
            this._section = null;
        }
        this._listBox = null;
        this._muteAllButton = null;
        this._displaysBox = null;
    }

    // --- header -------------------------------------------------------------

    _buildHeader() {
        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'gf-match-header',
            style: 'spacing: 8px;',
        });

        // Reuse the native section-header class so the "Football" title matches
        // the muted "Weather"/"World Clocks" headers (weight + dimmed colour).
        const title = new St.Label({
            text: gettext('Football'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'world-clocks-header',
        });
        header.add_child(title);

        if (this._mute) {
            this._muteAllButton = new St.Button({
                style_class: 'gf-mute-all-button',
                can_focus: true,
                label: gettext('Mute all'),
            });
            this._muteAllButton.connect('clicked', () => this._onMuteAllClicked());
            header.add_child(this._muteAllButton);
        }

        return header;
    }

    _onMuteAllClicked() {
        if (!this._mute)
            return;
        const ids = this._currentMatches.map(m => m.eventId).filter(Boolean);
        if (ids.length === 0)
            return;
        const allMuted = this._mute.areAllMuted(ids);
        this._mute.toggleAll(ids, !allMuted);
        // The mute controller's subscribe() callback triggers the re-render.
    }

    _updateMuteAllButton() {
        if (!this._muteAllButton)
            return;
        const ids = this._currentMatches.map(m => m.eventId).filter(Boolean);
        const visible = ids.length > 0;
        this._muteAllButton.visible = visible;
        if (!visible)
            return;
        this._muteAllButton.label = this._mute.areAllMuted(ids)
            ? gettext('Un-mute all')
            : gettext('Mute all');
    }

    // --- date changes & rendering ------------------------------------------

    _onDateChanged(datetime) {
        // datetime is a GLib.DateTime at the selected day; to_unix() is the
        // instant, and local Date getters then yield the right calendar day.
        const ms = datetime ? datetime.to_unix() * 1000 : Date.now();
        this._selectedDate = new Date(ms);
        this._render();
    }

    async _render() {
        if (!this._section || !this._listBox)
            return;

        const gen = ++this._renderGen;
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        const date = this._selectedDate;

        // When the data isn't immediately available (a non-today, uncached day
        // that needs a network fetch), show a loading placeholder right away so
        // the previously selected day's results don't linger on screen while we
        // wait for the fetch. Instant sources (today's snapshot, a cached day)
        // skip this to avoid a placeholder that flickers in and straight out.
        if (!this._dataProvider.hasImmediateData(date)) {
            this._currentMatches = [];
            this._listBox.destroy_all_children();
            this._listBox.add_child(this._buildLoadingState());
            this._updateMuteAllButton();
        }

        let matches = [];
        try {
            matches = await this._dataProvider.getMatchesForDate(date, {
                todayProvider: this._getTodayMatches,
                cancellable,
            });
        } catch (e) {
            if (!cancellable.is_cancelled())
                console.warn(`[GnomeFootball] panel data failed: ${e.message}`);
        }

        // A newer render started (or we were torn down) while awaiting: discard.
        if (gen !== this._renderGen || !this._listBox)
            return;

        this._currentMatches = matches;
        this._listBox.destroy_all_children();

        if (matches.length === 0) {
            this._listBox.add_child(this._buildEmptyState(date));
        } else {
            // One grid for ALL competitions: league titles span every column,
            // match cells line up underneath, so the score column is shared
            // across every row of every league (consistent vertical reading).
            this._listBox.add_child(
                this._buildMatchGrid(groupMatchesByCompetition(matches), cancellable));
        }

        this._updateMuteAllButton();
    }

    // Build the single grid holding every competition. Each league contributes
    // a full-width title row followed by one row per match; a running row index
    // keeps them in order. Because all matches live in the same grid, columns
    // (notably the score) are aligned across leagues.
    _buildMatchGrid(groups, cancellable) {
        const grid = new St.Widget({
            x_expand: true,
            style_class: 'gf-match-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: COL_SPACING,
                row_spacing: ROW_SPACING,
            }),
        });
        const layout = grid.layout_manager;

        // The title spans every column in use (the bell column only exists once
        // a mute controller is wired up in Feature 3).
        const headerSpan = this._mute ? MUTE_COLUMN + 1 : MATCH_COLUMNS;
        let row = 0;
        groups.forEach((group, index) => {
            const header = this._buildCompetitionHeader(group, cancellable, index > 0);
            layout.attach(header, 0, row, headerSpan, 1);
            row++;
            for (const match of group.matches) {
                this._attachMatchRow(layout, match, row, cancellable);
                row++;
            }
        });

        return grid;
    }

    // Competition header: logo first, then the commercial name (e.g. "LaLiga").
    // Padding adds breathing room below the title (gap to its scores) and, for
    // every league after the first, above it (gap between leagues).
    _buildCompetitionHeader(group, cancellable, withTopGap) {
        const padTop = withTopGap ? HEADER_GAP_ABOVE : 0;
        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'gf-competition-header',
            style: `spacing: 6px; padding-bottom: ${HEADER_GAP_BELOW}px; padding-top: ${padTop}px;`,
        });
        header.add_child(makeLeagueIcon(group, cancellable));
        header.add_child(new St.Label({
            text: group.name,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold;',
        }));
        return header;
    }

    // Attach one match's cells to the shared grid at `row`. Layout per row:
    //   crest | abbrev (right) | score | abbrev (left) | crest | minute | bell
    // Both crests hug the centre so each badge stays next to its abbreviation,
    // and the abbreviations flank the score. The score column carries a min
    // width so short scores ("2 - 0") and kick-off times ("17:30") share it; the
    // minute column is reserved for the live clock and the bell (Feature 3) sits
    // in an expanding column so it hugs the card's right edge.
    _attachMatchRow(layout, match, row, cancellable) {
        const homeCrest = makeCrestIcon(match.home, cancellable);
        homeCrest.x_align = Clutter.ActorAlign.END;
        homeCrest.y_align = Clutter.ActorAlign.CENTER;

        const awayCrest = makeCrestIcon(match.away, cancellable);
        awayCrest.x_align = Clutter.ActorAlign.START;
        awayCrest.y_align = Clutter.ActorAlign.CENTER;

        layout.attach(homeCrest, 0, row, 1, 1);
        layout.attach(this._abbrevLabel(match.home, Clutter.ActorAlign.END), 1, row, 1, 1);
        layout.attach(this._scoreLabel(match), 2, row, 1, 1);
        layout.attach(this._abbrevLabel(match.away, Clutter.ActorAlign.START), 3, row, 1, 1);
        layout.attach(awayCrest, 4, row, 1, 1);
        layout.attach(this._minuteLabel(match), MINUTE_COLUMN, row, 1, 1);

        if (this._mute && match.eventId)
            layout.attach(this._buildMuteButton(match.eventId), MUTE_COLUMN, row, 1, 1);
    }

    // The live-clock column, right of the away side. Reserved width fits up to
    // three digits plus the apostrophe ("120'") so the column stays a fixed size
    // and the rows align even when only some matches are in progress; the label
    // is blank for matches that are not live.
    _minuteLabel(match) {
        const label = new St.Label({
            text: liveMinute(match),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 36px; text-align: center;',
        });
        label.clutter_text.set_line_wrap(false);
        return label;
    }

    // A team's short ESPN abbreviation (e.g. "RSO", "BET", up to four letters).
    // We use the abbreviation rather than the full club name because the
    // DateMenu column is narrow and long names get truncated. `xAlign` decides
    // whether it hugs the score from the home (END) or away (START) side.
    _abbrevLabel(team, xAlign) {
        const label = new St.Label({
            text: team?.abbreviation || team?.name || '',
            x_align: xAlign,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.set_line_wrap(false);
        return label;
    }

    _scoreLabel(match) {
        const label = new St.Label({
            text: scoreOrTime(match),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; min-width: 48px; text-align: center;',
        });
        label.clutter_text.set_line_wrap(false);
        return label;
    }

    // Shown while a non-today, uncached day is being fetched. A spinner next to
    // a short message; if the Shell's Spinner is unavailable for any reason, the
    // message alone still conveys the loading state.
    _buildLoadingState() {
        const box = new St.BoxLayout({
            x_expand: true,
            style_class: 'gf-match-loading',
            style: 'spacing: 8px; padding: 4px 0;',
        });
        try {
            const spinner = new Animation.Spinner(16, { animate: true });
            box.add_child(spinner);
            spinner.play();
        } catch (_) {
            /* no spinner: the label below still signals loading */
        }
        box.add_child(new St.Label({
            text: gettext('Loading…'),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-style: italic;',
        }));
        return box;
    }

    _buildEmptyState(date) {
        const todayKey = localDateKey(Date.now());
        const key = localDateKey(date.getTime());
        let text;
        if (key === todayKey)
            text = gettext('No matches today');
        else if (key < todayKey)
            text = gettext('No matches played on this day');
        else
            text = gettext('No matches scheduled for this day');

        return new St.Label({
            text,
            x_expand: true,
            style: 'font-style: italic; padding: 4px 0;',
        });
    }

    _buildMuteButton(eventId) {
        const muted = this._mute.isMuted(eventId);
        const button = new St.Button({
            style_class: 'gf-mute-button',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: muted
                    ? 'notifications-disabled-symbolic'
                    : 'notification-symbolic',
                icon_size: 16,
            }),
        });
        button.connect('clicked', () => {
            this._mute.toggle(eventId);
            // subscribe() callback re-renders.
        });
        return button;
    }
}
