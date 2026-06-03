// GnomeFootball — preferences UI built with libadwaita 1.4+.
//
// Three pages:
//   1. Competitions: per-country expanders with leagues, each league exposes a
//      mode (all matches / specific teams) and an inline team list.
//   2. Events: one switch per notification type.
//   3. General: polling interval and a manual "check now" button.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    ALL_EVENT_TYPES,
    COUNTRY_GROUPS,
    EVENT_TYPE,
    SUBSCRIPTION_MODE,
} from './lib/constants.js';
import {
    ensureCatalog,
    isCatalogFresh,
    readCatalog,
    refreshCatalog,
} from './lib/catalog.js';

// ----- Country / event display labels ----------------------------------------

function countryLabel(id) {
    switch (id) {
        case 'spain':     return _('Spain');
        case 'england':   return _('England');
        case 'italy':     return _('Italy');
        case 'france':    return _('France');
        case 'portugal':  return _('Portugal');
        case 'germany':   return _('Germany');
        case 'brazil':    return _('Brazil');
        case 'argentina': return _('Argentina');
        case 'mexico':    return _('Mexico');
        case 'colombia':  return _('Colombia');
        case 'chile':     return _('Chile');
        case 'usa':       return _('United States');
        case 'uefa':      return _('UEFA');
        case 'conmebol':  return _('CONMEBOL');
        case 'concacaf':  return _('CONCACAF');
        case 'fifa':      return _('FIFA');
        default:          return id;
    }
}

function eventLabel(eventType) {
    switch (eventType) {
        case EVENT_TYPE.MATCH_START:       return _('Match start (kick-off)');
        case EVENT_TYPE.GOAL:              return _('Goal');
        case EVENT_TYPE.YELLOW_CARD:       return _('Yellow card');
        case EVENT_TYPE.RED_CARD:          return _('Red card');
        case EVENT_TYPE.SUBSTITUTION:      return _('Substitution');
        case EVENT_TYPE.HALF_TIME_END:     return _('First half ends');
        case EVENT_TYPE.SECOND_HALF_START: return _('Second half starts');
        case EVENT_TYPE.MATCH_END:         return _('Full-time');
        case EVENT_TYPE.EXTRA_TIME:        return _('Extra time');
        case EVENT_TYPE.PENALTIES:         return _('Penalty shootout');
        default:                           return eventType;
    }
}

// ----- Subscription helpers --------------------------------------------------

function readSubscriptions(settings) {
    try {
        return JSON.parse(settings.get_string('subscriptions-json') || '{}');
    } catch (_e) {
        return {};
    }
}

function writeSubscriptions(settings, subs) {
    settings.set_string('subscriptions-json', JSON.stringify(subs));
}

function isSubscribed(subs, slug) {
    return Object.prototype.hasOwnProperty.call(subs, slug);
}

function getMode(subs, slug) {
    return subs[slug]?.mode ?? SUBSCRIPTION_MODE.ALL;
}

function getSelectedTeams(subs, slug) {
    return Array.isArray(subs[slug]?.teams) ? subs[slug].teams : [];
}

// ----- Main preferences class ------------------------------------------------

export default class GnomeFootballPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();

        const display = Gdk.Display.get_default();
        if (display) {
            Gtk.IconTheme.get_for_display(display).add_search_path(`${this.path}/icons`);
            this._installNestedExpanderCssFix(display);
        }

        window.set_default_size(720, 720);
        window.set_search_enabled(true);

        this._addCompetitionsPage(window);
        this._addEventsPage(window);
        this._addGeneralPage(window);

        // Kick off an async catalog refresh if needed.
        this._maybeRefreshCatalogInBackground();

        // Drop window-scoped references when the prefs window closes so the
        // PreferencesExtension instance doesn't keep widgets alive between
        // openings.
        window.connect('close-request', () => {
            this._settings = null;
            this._statusRow = null;
            this._competitionsPage = null;
            this._countryGroups = null;
            return false;
        });
    }

    // libadwaita styles the chevron of any descendant `.expander-row-arrow`
    // when the outer expander is `:checked`, regardless of whether the inner
    // expander is checked. Result: nested rows show an accent-coloured up
    // chevron even when collapsed. This override scopes the rotation/color to
    // direct-state expanders so nested rows render their own state correctly.
    _installNestedExpanderCssFix(display) {
        if (GnomeFootballPreferences._cssFixInstalled)
            return;
        const provider = new Gtk.CssProvider();
        provider.load_from_string(`
            row.expander row.expander:not(:checked) image.expander-row-arrow {
                -gtk-icon-transform: rotate(0.5turn);
                color: inherit;
            }
            row.expander image.expander-row-arrow:disabled {
                opacity: 0;
            }
        `);
        Gtk.StyleContext.add_provider_for_display(
            display,
            provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );
        GnomeFootballPreferences._cssFixInstalled = true;
    }

    // ----- Page 1: Competitions ---------------------------------------------

    _addCompetitionsPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('Competitions'),
            iconName: 'gnomefootball-symbolic',
        });
        window.add(page);

        // Action group at the top: refresh and status.
        const actionsGroup = new Adw.PreferencesGroup({
            title: _('Catalog'),
            description: _('Leagues and teams are loaded from a public sports data source and cached locally.'),
        });
        page.add(actionsGroup);

        this._statusRow = new Adw.ActionRow({
            title: this._catalogStatusTitle(),
            subtitle: this._catalogStatusSubtitle(),
        });
        this._refreshButton = new Gtk.Button({
            label: _('Refresh now'),
            valign: Gtk.Align.CENTER,
        });
        this._refreshButton.add_css_class('flat');
        this._refreshButton.connect('clicked', () => this._onRefreshClicked());
        this._statusRow.add_suffix(this._refreshButton);
        this._catalogProgressFraction = 0;
        this._refreshProgress = new Gtk.DrawingArea({
            content_width: 22,
            content_height: 22,
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        this._refreshProgress.set_draw_func((widget, cr, width, height) => {
            const fraction = this._catalogProgressFraction;
            const cx = width / 2;
            const cy = height / 2;
            const radius = Math.min(width, height) / 2 - 1.5;
            const fg = widget.get_color();

            cr.setLineWidth(2);
            cr.setLineCap(1); // CAIRO_LINE_CAP_ROUND

            cr.setSourceRGBA(fg.red, fg.green, fg.blue, 0.25);
            cr.arc(cx, cy, radius, 0, 2 * Math.PI);
            cr.stroke();

            if (fraction > 0) {
                cr.setSourceRGBA(fg.red, fg.green, fg.blue, 1.0);
                const start = -Math.PI / 2;
                const end = start + fraction * 2 * Math.PI;
                cr.arc(cx, cy, radius, start, end);
                cr.stroke();
            }
        });
        this._statusRow.add_suffix(this._refreshProgress);
        actionsGroup.add(this._statusRow);

        this._competitionsPage = page;
        // countryId -> { countryExpander, leagueRows: Map<slug, row> }
        this._countryGroups = new Map();
        this._buildCountryGroups(page);
        this._refreshCompetitionsUI();
    }

    _buildCountryGroups(page) {
        // One umbrella group with collapsible per-country rows. Keeps the page
        // short even with the full catalog visible.
        const group = new Adw.PreferencesGroup({
            title: _('Competitions'),
        });
        page.add(group);
        this._competitionsGroup = group;

        for (const country of COUNTRY_GROUPS) {
            const countryExpander = new Adw.ExpanderRow({
                title: countryLabel(country.id),
                subtitle: _('Off'),
            });
            group.add(countryExpander);

            const leagueRows = new Map();
            for (const leagueDef of country.leagues) {
                const row = this._buildLeagueRow(leagueDef);
                countryExpander.add_row(row.widget);
                leagueRows.set(leagueDef.slug, row);
            }
            this._countryGroups.set(country.id, { countryExpander, leagueRows });
        }
    }

    _countrySubtitle(enabled, total) {
        if (enabled === 0)
            return _('Off');
        return `${enabled}/${total} ${_('enabled')}`;
    }

    _refreshCountrySubtitles() {
        const subs = readSubscriptions(this._settings);
        const catalog = readCatalog(this._settings);
        for (const country of COUNTRY_GROUPS) {
            const entry = this._countryGroups.get(country.id);
            if (!entry) continue;
            let visibleCount = 0;
            let enabledCount = 0;
            for (const leagueDef of country.leagues) {
                const leagueData = catalog[leagueDef.slug];
                const hidden = leagueDef.conditional &&
                    (!leagueData || leagueData.available === false);
                if (!hidden) visibleCount++;
                if (isSubscribed(subs, leagueDef.slug)) enabledCount++;
            }
            entry.countryExpander.set_subtitle(this._countrySubtitle(enabledCount, visibleCount));
        }
    }

    _buildLeagueRow(leagueDef) {
        const slug = leagueDef.slug;
        const subs = readSubscriptions(this._settings);
        const subscribed = isSubscribed(subs, slug);

        const expander = new Adw.ExpanderRow({
            title: leagueDef.defaultName,
            subtitle: this._leagueSubtitle(slug, subs),
            showEnableSwitch: true,
            enableExpansion: subscribed,
            expanded: false,
        });

        // Combined mode-switch + teams-container. The switch (showEnableSwitch)
        // toggles "specific teams only" mode; when ON, the row's expansion
        // reveals the team list directly underneath without an extra header
        // row. The chevron is hidden via CSS when the switch is OFF.
        const modeRow = new Adw.ExpanderRow({
            title: _('Specific teams only'),
            subtitle: _('Notify only for matches involving selected teams'),
            showEnableSwitch: true,
            enableExpansion: getMode(subs, slug) === SUBSCRIPTION_MODE.TEAMS,
            expanded: false,
        });
        const placeholderRow = new Adw.ActionRow({
            title: _('Teams will appear once the catalog has loaded.'),
        });
        modeRow.add_row(placeholderRow);
        expander.add_row(modeRow);

        // Wire signals.
        expander.connect('notify::enable-expansion', () => {
            const subsNow = readSubscriptions(this._settings);
            if (expander.enableExpansion) {
                subsNow[slug] = subsNow[slug] ?? { mode: SUBSCRIPTION_MODE.ALL, teams: [] };
            } else {
                delete subsNow[slug];
            }
            writeSubscriptions(this._settings, subsNow);
            expander.set_subtitle(this._leagueSubtitle(slug, subsNow));
            this._refreshCountrySubtitles();
        });

        modeRow.connect('notify::enable-expansion', () => {
            const subsNow = readSubscriptions(this._settings);
            const entry = subsNow[slug] ?? { mode: SUBSCRIPTION_MODE.ALL, teams: [] };
            entry.mode = modeRow.enableExpansion
                ? SUBSCRIPTION_MODE.TEAMS
                : SUBSCRIPTION_MODE.ALL;
            subsNow[slug] = entry;
            writeSubscriptions(this._settings, subsNow);
            expander.set_subtitle(this._leagueSubtitle(slug, subsNow));
        });

        return {
            widget: expander,
            slug,
            expander,
            modeRow,
            placeholderRow,
            teamSwitches: new Map(),
        };
    }

    _leagueSubtitle(slug, subs) {
        if (!isSubscribed(subs, slug))
            return _('Off');
        const mode = getMode(subs, slug);
        if (mode === SUBSCRIPTION_MODE.ALL)
            return _('All matches');
        const count = getSelectedTeams(subs, slug).length;
        // Plural-aware label kept simple; gettext ngettext would be the formal way.
        return count === 1
            ? _('1 team selected')
            : `${count} ${_('teams selected')}`;
    }

    _refreshCompetitionsUI() {
        const catalog = readCatalog(this._settings);
        const subs = readSubscriptions(this._settings);

        for (const country of COUNTRY_GROUPS) {
            const entry = this._countryGroups.get(country.id);
            if (!entry) continue;

            let visibleCount = 0;
            let enabledCount = 0;
            for (const leagueDef of country.leagues) {
                const row = entry.leagueRows.get(leagueDef.slug);
                if (!row) continue;
                const leagueData = catalog[leagueDef.slug];
                const isConditionalHidden =
                    leagueDef.conditional && (!leagueData || leagueData.available === false);
                row.widget.visible = !isConditionalHidden;
                if (!isConditionalHidden) visibleCount++;
                if (isSubscribed(subs, leagueDef.slug)) enabledCount++;
                this._populateTeams(row, leagueData?.teams ?? [], subs);
                row.widget.set_subtitle(this._leagueSubtitle(leagueDef.slug, subs));
            }
            entry.countryExpander.visible = visibleCount > 0;
            entry.countryExpander.set_subtitle(this._countrySubtitle(enabledCount, visibleCount));
        }

        this._statusRow.title = this._catalogStatusTitle();
        this._statusRow.subtitle = this._catalogStatusSubtitle();
    }

    _populateTeams(row, teams, subs) {
        // Remove old team switches from modeRow (placeholder stays).
        for (const [, switchRow] of row.teamSwitches)
            row.modeRow.remove(switchRow);
        row.teamSwitches.clear();

        if (teams.length === 0) {
            row.placeholderRow.title = _('Teams will appear once the catalog has loaded.');
            row.placeholderRow.visible = true;
            return;
        }
        row.placeholderRow.visible = false;

        const selectedTeamIds = new Set(getSelectedTeams(subs, row.slug));
        const sortedTeams = [...teams].sort((a, b) => a.name.localeCompare(b.name));

        for (const team of sortedTeams) {
            const switchRow = new Adw.SwitchRow({
                title: team.name,
                subtitle: team.abbreviation || '',
                active: selectedTeamIds.has(team.id),
            });
            switchRow.connect('notify::active', () => {
                const subsNow = readSubscriptions(this._settings);
                const entry = subsNow[row.slug] ?? { mode: SUBSCRIPTION_MODE.TEAMS, teams: [] };
                const set = new Set(entry.teams ?? []);
                if (switchRow.active)
                    set.add(team.id);
                else
                    set.delete(team.id);
                entry.teams = Array.from(set);
                if (entry.mode !== SUBSCRIPTION_MODE.TEAMS)
                    entry.mode = SUBSCRIPTION_MODE.TEAMS;
                subsNow[row.slug] = entry;
                writeSubscriptions(this._settings, subsNow);
                row.expander.set_subtitle(this._leagueSubtitle(row.slug, subsNow));
            });
            row.modeRow.add_row(switchRow);
            row.teamSwitches.set(team.id, switchRow);
        }
    }

    // ----- Page 2: Events ---------------------------------------------------

    _addEventsPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('Events'),
            iconName: 'preferences-system-notifications-symbolic',
        });
        window.add(page);

        // Match reminder: a pre-kickoff heads-up with a user-defined lead time.
        // Off by default and rendered separately from the in-match event
        // switches because it carries its own lead-time setting.
        const reminderGroup = new Adw.PreferencesGroup({
            title: _('Match reminder'),
            description: _('Get a heads-up before a subscribed match kicks off.'),
        });
        page.add(reminderGroup);

        const reminderRow = new Adw.SwitchRow({
            title: _('Remind me before kick-off'),
            active: this._settings.get_boolean('event-match-reminder'),
        });
        this._settings.bind('event-match-reminder', reminderRow, 'active', 0);
        reminderGroup.add(reminderRow);

        const leadAdjustment = new Gtk.Adjustment({
            lower: 5,
            upper: 180,
            stepIncrement: 5,
            pageIncrement: 15,
            value: this._settings.get_int('reminder-lead-minutes'),
        });
        const leadRow = new Adw.SpinRow({
            title: _('Minutes before kick-off'),
            subtitle: _('Range: 5-180 minutes'),
            adjustment: leadAdjustment,
            sensitive: reminderRow.active,
        });
        this._settings.bind('reminder-lead-minutes', leadAdjustment, 'value', 0);
        reminderRow.connect('notify::active', () => {
            leadRow.sensitive = reminderRow.active;
        });
        reminderGroup.add(leadRow);

        const group = new Adw.PreferencesGroup({
            title: _('Notification types'),
            description: _('Choose which match events trigger a notification.'),
        });
        page.add(group);

        for (const evType of ALL_EVENT_TYPES) {
            const key = `event-${evType}`;
            const row = new Adw.SwitchRow({
                title: eventLabel(evType),
                active: this._settings.get_boolean(key),
            });
            this._settings.bind(key, row, 'active', 0); // Gio.SettingsBindFlags.DEFAULT === 0
            group.add(row);
        }
    }

    // ----- Page 3: General --------------------------------------------------

    _addGeneralPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        const pollingGroup = new Adw.PreferencesGroup({
            title: _('Polling'),
            description: _('How often to check for match updates. Lower values catch events sooner but use more bandwidth.'),
        });
        page.add(pollingGroup);

        const adjustment = new Gtk.Adjustment({
            lower: 1,
            upper: 30,
            stepIncrement: 1,
            pageIncrement: 5,
            value: this._settings.get_int('poll-interval-minutes'),
        });
        const spinRow = new Adw.SpinRow({
            title: _('Polling interval (minutes)'),
            subtitle: _('Range: 1-30 minutes'),
            adjustment,
        });
        this._settings.bind('poll-interval-minutes', adjustment, 'value', 0);
        pollingGroup.add(spinRow);

        const notificationsGroup = new Adw.PreferencesGroup({
            title: _('Notifications'),
            description: _('Control how notifications behave when you interact with them.'),
        });
        page.add(notificationsGroup);

        const clickRow = new Adw.SwitchRow({
            title: _('Open match page on click'),
            subtitle: _('Clicking a notification opens the match page in your browser.'),
            active: this._settings.get_boolean('open-match-page-on-click'),
        });
        this._settings.bind('open-match-page-on-click', clickRow, 'active', 0);
        notificationsGroup.add(clickRow);

        const actionsGroup = new Adw.PreferencesGroup({
            title: _('Actions'),
        });
        page.add(actionsGroup);

        const forceRow = new Adw.ActionRow({
            title: _('Force a check now'),
            subtitle: _('Asks the background poller to refresh match data immediately.'),
        });
        const forceButton = new Gtk.Button({
            label: _('Check now'),
            valign: Gtk.Align.CENTER,
        });
        forceButton.add_css_class('suggested-action');
        forceButton.connect('clicked', () => {
            this._settings.set_int64('force-check-trigger', Date.now());
        });
        forceRow.add_suffix(forceButton);
        actionsGroup.add(forceRow);
    }

    // ----- Catalog status + refresh ------------------------------------------

    _catalogStatusTitle() {
        const catalog = readCatalog(this._settings);
        const slugs = Object.keys(catalog);
        if (slugs.length === 0)
            return _('Catalog not loaded yet');
        return _('Catalog loaded');
    }

    _catalogStatusSubtitle() {
        const ts = Number(this._settings.get_int64('catalog-fetched-at'));
        if (!ts)
            return _('Press "Refresh now" to load leagues and teams.');
        const date = new Date(ts * 1000);
        const formatted = date.toLocaleString();
        const fresh = isCatalogFresh(this._settings);
        return fresh
            ? `${_('Last refreshed')}: ${formatted}`
            : `${_('Last refreshed')}: ${formatted} — ${_('refresh recommended')}`;
    }

    async _maybeRefreshCatalogInBackground() {
        const catalog = readCatalog(this._settings);
        if (Object.keys(catalog).length > 0 && isCatalogFresh(this._settings))
            return;

        this._setCatalogRefreshing(true);
        try {
            await ensureCatalog(this._settings, null, p => this._setCatalogProgress(p.done, p.total));
            this._refreshCompetitionsUI();
        } catch (e) {
            console.warn(`[GnomeFootball] prefs: background catalog refresh failed: ${e.message}`);
        } finally {
            this._setCatalogRefreshing(false);
        }
    }

    async _onRefreshClicked() {
        this._setCatalogRefreshing(true);
        try {
            await refreshCatalog(this._settings, null, p => this._setCatalogProgress(p.done, p.total));
            this._refreshCompetitionsUI();
        } catch (e) {
            console.warn(`[GnomeFootball] prefs: manual catalog refresh failed: ${e.message}`);
        } finally {
            this._setCatalogRefreshing(false);
        }
    }

    _setCatalogRefreshing(active) {
        if (active) {
            this._refreshButton.visible = false;
            this._catalogProgressFraction = 0;
            this._refreshProgress.queue_draw();
            this._refreshProgress.visible = true;
            this._statusRow.title = _('Loading catalog…');
            this._statusRow.subtitle = _('Fetching leagues and teams');
        } else {
            this._refreshProgress.visible = false;
            this._refreshButton.visible = true;
            this._statusRow.title = this._catalogStatusTitle();
            this._statusRow.subtitle = this._catalogStatusSubtitle();
        }
    }

    _setCatalogProgress(done, total) {
        this._catalogProgressFraction = total > 0 ? done / total : 0;
        this._refreshProgress.queue_draw();
        this._statusRow.subtitle = `${_('Fetching leagues and teams')} (${done} / ${total})`;
    }
}
