// Calendar-integrated match panel: a custom section injected into the Shell's
// DateMenu, showing matches for the selected day (today from the poller snapshot,
// other days via match-data.js). A custom widget rather than a MessageList
// subclass (MessageListSection was removed in shell 45+); the DateMenu hooks
// (_displaysSection.child, _calendar, `selected-date-changed`) are identical
// across the supported versions 48/49/50.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import { getIcon as getCachedIcon } from './crest-cache.js';
import { isDarkTheme } from './theme.js';
import { localDateKey, groupMatchesByCompetition, teamAbbrev } from './match-model.js';

// Fallback insertion index when the events section can't be located (we normally
// insert just below it, so calendar events stay on top).
const INSERT_INDEX = 0;
const CREST_ICON_SIZE = 22;
const LEAGUE_ICON_SIZE = 18;

// Grid geometry. All match rows share ONE grid so the score sits in the same
// column on every row regardless of each abbreviation's width.
const COL_SPACING = 6;
const ROW_SPACING = 4;
const HEADER_GAP_BELOW = 6;     // gap from a league title to its rows
const HEADER_GAP_ABOVE = 10;    // gap above a league title (between leagues)
// Columns: crest | abbrev | score | abbrev | crest | minute | (mute).
const MATCH_COLUMNS = 6;
const MINUTE_COLUMN = 5;
const MUTE_COLUMN = 6;       // only present when a mute controller is set

// Resolve via the gettext domain directly (like notifier.js) so this module
// needs no init wiring.
function gettext(text) {
    return GLib.dgettext('gnomefootball', text) || text;
}

function fallbackGicon() {
    return new Gio.ThemedIcon({ name: 'dialog-question-symbolic' });
}

// A St.Icon whose gicon is filled in asynchronously from the crest cache,
// showing a neutral fallback until (and unless) the icon resolves.
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

function crestCacheKey(team) {
    const id = team?.id;
    if (!id)
        return '';
    return `team-${id}-${isDarkTheme() ? 'dark' : 'light'}`;
}

function leagueCacheKey(group) {
    if (!group?.slug)
        return '';
    return `league-${group.slug}-${isDarkTheme() ? 'dark' : 'light'}`;
}

// Team crest (per-side, in a match row).
function makeCrestIcon(team, cancellable) {
    return makeRemoteIcon(crestCacheKey(team), team?.logo, cancellable, CREST_ICON_SIZE, 'gf-match-crest');
}

// Competition logo (in a group header).
function makeLeagueIcon(group, cancellable) {
    return makeRemoteIcon(leagueCacheKey(group), group?.logo, cancellable, LEAGUE_ICON_SIZE, 'gf-competition-logo');
}

// Warm the crest cache for every badge so the grid renders with no pop-in.
async function prefetchCrests(groups, cancellable) {
    const seen = new Set();
    const jobs = [];
    const add = (key, url) => {
        if (!key || !url || seen.has(key))
            return;
        seen.add(key);
        jobs.push(getCachedIcon(key, url, cancellable).catch(() => {}));
    };
    for (const group of groups) {
        add(leagueCacheKey(group), group?.logo);
        for (const match of group.matches) {
            add(crestCacheKey(match.home), match.home?.logo);
            add(crestCacheKey(match.away), match.away?.logo);
        }
    }
    await Promise.all(jobs);
}

// Local "HH:MM" for a kickoff timestamp, in the user's locale/timezone.
function formatKickoff(kickoffMs) {
    if (kickoffMs == null)
        return '';
    return new Date(kickoffMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Center column: kickoff time before the game, live/final score once started.
function scoreOrTime(match) {
    if (match.state === 'pre')
        return formatKickoff(match.kickoffMs);
    return `${match.homeScore} - ${match.awayScore}`;
}

// Live clock for a match in progress (e.g. "67'", "HT"); empty otherwise.
function liveMinute(match) {
    return match.state === 'in' ? (match.statusDetail || '') : '';
}

// A grid-cell label that never wraps. Ellipsize defaults to NONE so a tight grid
// can't shrink rigid cells; the abbrev cells opt into END (with a min-width floor)
// so a long code clips instead of forcing horizontal scroll.
function noWrapLabel(text, { xAlign = Clutter.ActorAlign.CENTER, style = '', ellipsize = Pango.EllipsizeMode.NONE } = {}) {
    const label = new St.Label({
        text,
        x_align: xAlign,
        y_align: Clutter.ActorAlign.CENTER,
        style,
    });
    label.clutter_text.set_line_wrap(false);
    label.clutter_text.set_ellipsize(ellipsize);
    return label;
}

const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_GAP = 4;

// Hover tooltip for a St cell (St has no native one). A single floating label
// lives in the uiGroup and is reused by every attached cell.
class Tooltip {
    constructor() {
        this._label = new St.Label({ style_class: 'dash-label', visible: false });
        this._label.clutter_text.set_line_wrap(false);
        Main.layoutManager.uiGroup.add_child(this._label);
        this._timeoutId = 0;
        this._target = null;
    }

    attach(actor, text) {
        if (!text)
            return;
        actor.reactive = true;
        actor.track_hover = true;
        actor.connect('notify::hover', () => {
            if (actor.hover)
                this._scheduleShow(actor, text);
            else if (this._target === actor)
                this.hide();
        });
        actor.connect('destroy', () => {
            if (this._target === actor)
                this.hide();
        });
    }

    _scheduleShow(actor, text) {
        this._cancelTimer();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_DELAY_MS, () => {
            this._timeoutId = 0;
            this._show(actor, text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show(actor, text) {
        if (!this._label || !actor.mapped || !actor.hover)
            return;
        this._target = actor;
        this._label.text = text;
        this._label.visible = true;
        Main.layoutManager.uiGroup.set_child_above_sibling(this._label, null);

        const [ax, ay] = actor.get_transformed_position();
        const [, natW] = this._label.get_preferred_width(-1);
        let x = ax + actor.width / 2 - natW / 2;
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor)
            x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - natW));
        this._label.set_position(Math.round(x), Math.round(ay + actor.height + TOOLTIP_GAP));
    }

    hide() {
        this._cancelTimer();
        this._target = null;
        if (this._label)
            this._label.visible = false;
    }

    _cancelTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    destroy() {
        this._cancelTimer();
        this._target = null;
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
    }
}

export class CalendarPanel {
    // mute (optional) is a controller { isMuted, toggle, areAllMuted, toggleAll,
    // subscribe }; when absent the per-row bell and Mute-all button are hidden.
    constructor({ settings, dataProvider, getTodayMatches, mute = null }) {
        this._settings = settings;
        this._dataProvider = dataProvider;
        this._getTodayMatches = getTodayMatches;
        this._mute = mute;

        this._section = null;       // root St.BoxLayout injected into the DateMenu
        this._listBox = null;       // body holding rows / empty state
        this._muteAllButton = null;
        this._displaysBox = null;   // the DateMenu container we injected into
        this._tooltip = null;

        this._calendarSignalId = 0;
        this._settingsSignalId = 0;
        this._muteUnsubscribe = null;
        this._cancellable = null;
        this._renderGen = 0;
        this._selectedDate = new Date();
        this._currentMatches = [];
        this._muteButtons = new Map();   // eventId -> bell button, for in-place refresh
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
    // today (other days come from the data layer, not the poller).
    refreshIfToday() {
        if (!this._section)
            return;
        if (localDateKey(this._selectedDate.getTime()) === localDateKey(Date.now()))
            this._render();
    }

    _syncVisibility() {
        const show = this._settings.get_boolean('show-today-panel');
        if (show && !this._section)
            this._buildSection();
        else if (!show && this._section)
            this._teardownSection();
    }

    _displaysContainer() {
        // .child is the vertical displaysBox holding the weather/clocks/events.
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

        // Reuse the Shell's native card class so our card matches the weather /
        // clocks / events ones, with correct light/dark theming for free.
        this._section = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'gf-match-section world-clocks-button',
            style: 'spacing: 6px;',
        });

        this._section.add_child(this._buildHeader());

        // Single child: the match grid (which handles its own spacing) or the
        // empty-state label.
        this._listBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._section.add_child(this._listBox);

        // Place the card right below the events (reminders) section.
        let index = INSERT_INDEX;
        const eventsItem = dateMenu?._eventsItem ?? null;
        if (eventsItem) {
            const at = container.get_children().indexOf(eventsItem);
            if (at >= 0)
                index = at + 1;
        }
        container.insert_child_at_index(this._section, index);
        this._displaysBox = container;

        // Seed from the calendar's current selection, then react to changes.
        if (calendar._selectedDate instanceof Date)
            this._selectedDate = new Date(calendar._selectedDate.getTime());
        this._calendarSignalId = calendar.connect(
            'selected-date-changed', (_cal, datetime) => this._onDateChanged(datetime));

        if (this._mute)
            this._muteUnsubscribe = this._mute.subscribe(() => this._refreshMuteState());

        this._tooltip = new Tooltip();
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

        if (this._tooltip) {
            this._tooltip.destroy();
            this._tooltip = null;
        }

        if (this._section) {
            this._section.destroy();
            this._section = null;
        }
        this._listBox = null;
        this._muteAllButton = null;
        this._displaysBox = null;
    }

    _buildHeader() {
        const header = new St.BoxLayout({
            x_expand: true,
            style_class: 'gf-match-header',
            style: 'spacing: 8px;',
        });

        // Native header class so "Football" matches the "Weather"/"World Clocks" titles.
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

    // Finished matches can't usefully be muted, so the bell and "Mute all" only
    // cover matches that haven't ended yet.
    _muteableIds() {
        return this._currentMatches
            .filter(m => m.eventId && m.state !== 'post')
            .map(m => m.eventId);
    }

    _onMuteAllClicked() {
        if (!this._mute)
            return;
        const ids = this._muteableIds();
        if (ids.length === 0)
            return;
        const allMuted = this._mute.areAllMuted(ids);
        this._mute.toggleAll(ids, !allMuted);   // subscribe() refreshes the bells in place
    }

    _updateMuteAllButton() {
        if (!this._muteAllButton)
            return;
        const ids = this._muteableIds();
        const visible = ids.length > 0;
        this._muteAllButton.visible = visible;
        if (!visible)
            return;
        this._muteAllButton.label = this._mute.areAllMuted(ids)
            ? gettext('Un-mute all')
            : gettext('Mute all');
    }

    _onDateChanged(datetime) {
        const ms = datetime ? datetime.to_unix() * 1000 : Date.now();
        this._selectedDate = new Date(ms);
        this._render();
    }

    async _render() {
        if (!this._section || !this._listBox)
            return;

        const gen = ++this._renderGen;
        this._muteButtons.clear();
        if (this._cancellable && !this._cancellable.is_cancelled())
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        const date = this._selectedDate;

        // For a day needing a fetch, show a placeholder so the previous day's
        // results don't linger. Instant sources skip it to avoid a flicker.
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

        if (matches.length === 0) {
            this._listBox.destroy_all_children();
            this._listBox.add_child(this._buildEmptyState(date));
            this._updateMuteAllButton();
            return;
        }

        // Warm every crest before swapping the spinner out.
        const groups = groupMatchesByCompetition(matches);
        await prefetchCrests(groups, cancellable);
        if (gen !== this._renderGen || !this._listBox)
            return;

        this._listBox.destroy_all_children();
        this._listBox.add_child(this._buildMatchGrid(groups, cancellable));
        this._updateMuteAllButton();
    }

    // One grid for all competitions: each league is a full-width title row plus
    // its match rows. Sharing the grid aligns the score column across leagues.
    _buildMatchGrid(groups, cancellable) {
        const grid = new St.Widget({
            x_align: Clutter.ActorAlign.START,
            style_class: 'gf-match-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: COL_SPACING,
                row_spacing: ROW_SPACING,
            }),
        });
        const layout = grid.layout_manager;

        // The title spans every column in use (the bell column only when muting).
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

    // Competition header: logo, then commercial name. Padding spaces it from its
    // rows below and, for every league after the first, from the league above.
    _buildCompetitionHeader(group, cancellable, withTopGap) {
        const padTop = withTopGap ? HEADER_GAP_ABOVE : 0;
        const header = new St.BoxLayout({
            x_align: Clutter.ActorAlign.START,
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

    // Attach one match's cells at `row`:
    //   crest | abbrev (right) | score | abbrev (left) | crest | minute | bell
    // Both crests hug the centre so each badge stays next to its abbreviation.
    _attachMatchRow(layout, match, row, cancellable) {
        const homeCrest = makeCrestIcon(match.home, cancellable);
        homeCrest.x_align = Clutter.ActorAlign.END;
        homeCrest.y_align = Clutter.ActorAlign.CENTER;

        const awayCrest = makeCrestIcon(match.away, cancellable);
        awayCrest.x_align = Clutter.ActorAlign.START;
        awayCrest.y_align = Clutter.ActorAlign.CENTER;

        if (this._tooltip) {
            this._tooltip.attach(homeCrest, match.home?.name);
            this._tooltip.attach(awayCrest, match.away?.name);
        }

        layout.attach(homeCrest, 0, row, 1, 1);
        layout.attach(this._abbrevLabel(match.home, Clutter.ActorAlign.END), 1, row, 1, 1);
        layout.attach(this._scoreLabel(match), 2, row, 1, 1);
        layout.attach(this._abbrevLabel(match.away, Clutter.ActorAlign.START), 3, row, 1, 1);
        layout.attach(awayCrest, 4, row, 1, 1);
        layout.attach(this._minuteLabel(match), MINUTE_COLUMN, row, 1, 1);

        if (this._mute && match.eventId && match.state !== 'post') {
            const muteButton = this._buildMuteButton(match.eventId);
            this._muteButtons.set(match.eventId, muteButton);
            layout.attach(muteButton, MUTE_COLUMN, row, 1, 1);
        }
    }

    // Live-clock column. No min-width: the cell sizes to the time text and stays
    // rigid, so a long stoppage like "90+10'" never clips; only abbrevs flex.
    _minuteLabel(match) {
        return noWrapLabel(liveMinute(match));
    }

    // A team's short acronym (the narrow column truncates full names). `xAlign`
    // hugs the score from the home (END) or away (START) side.
    _abbrevLabel(team, xAlign) {
        const label = noWrapLabel(teamAbbrev(team), {
            xAlign,
            ellipsize: Pango.EllipsizeMode.END,
            style: 'min-width: 28px;',
        });
        if (this._tooltip)
            this._tooltip.attach(label, team?.name);
        return label;
    }

    _scoreLabel(match) {
        return noWrapLabel(scoreOrTime(match), { style: 'font-weight: bold;' });
    }

    // Shown while a day is being fetched. Falls back to the label alone if the
    // Shell's Spinner is unavailable.
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

    // Un-slashed 'notifications-symbolic' isn't shipped by every Adwaita build,
    // so use the matching GNOME notifications bell for the un-muted state.
    _muteIconName(eventId) {
        return this._mute.isMuted(eventId)
            ? 'notifications-disabled-symbolic'
            : 'org.gnome.Settings-notifications-symbolic';
    }

    _buildMuteButton(eventId) {
        const button = new St.Button({
            style_class: 'gf-mute-button',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({
                icon_name: this._muteIconName(eventId),
                icon_size: 16,
            }),
        });
        button.connect('clicked', () => this._mute.toggle(eventId));
        return button;
    }

    // A mute toggle changes only bell glyphs and the Mute-all label, never the
    // match data, so update them in place — rebuilding the grid would flicker.
    _refreshMuteState() {
        if (!this._mute)
            return;
        for (const [eventId, button] of this._muteButtons) {
            if (button.child)
                button.child.icon_name = this._muteIconName(eventId);
        }
        this._updateMuteAllButton();
    }
}
