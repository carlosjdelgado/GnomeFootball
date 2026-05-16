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
        case 'spain':    return _('Spain');
        case 'england':  return _('England');
        case 'italy':    return _('Italy');
        case 'france':   return _('France');
        case 'portugal': return _('Portugal');
        case 'germany':  return _('Germany');
        case 'uefa':     return _('UEFA');
        case 'fifa':     return _('FIFA');
        default:         return id;
    }
}

function eventLabel(eventType) {
    switch (eventType) {
        case EVENT_TYPE.MATCH_START:       return _('Match start (kick-off)');
        case EVENT_TYPE.GOAL:              return _('Goal');
        case EVENT_TYPE.YELLOW_CARD:       return _('Yellow card');
        case EVENT_TYPE.RED_CARD:          return _('Red card');
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
        if (display)
            Gtk.IconTheme.get_for_display(display).add_search_path(`${this.path}/icons`);

        window.set_default_size(720, 720);
        window.set_search_enabled(true);

        this._addCompetitionsPage(window);
        this._addEventsPage(window);
        this._addGeneralPage(window);

        // Kick off an async catalog refresh if needed.
        this._maybeRefreshCatalogInBackground();
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
            description: _('Leagues and teams come from ESPN and are cached locally.'),
        });
        page.add(actionsGroup);

        this._statusRow = new Adw.ActionRow({
            title: this._catalogStatusTitle(),
            subtitle: this._catalogStatusSubtitle(),
        });
        const refreshButton = new Gtk.Button({
            label: _('Refresh now'),
            valign: Gtk.Align.CENTER,
        });
        refreshButton.add_css_class('flat');
        refreshButton.connect('clicked', () => this._onRefreshClicked(refreshButton));
        this._statusRow.add_suffix(refreshButton);
        actionsGroup.add(this._statusRow);

        this._competitionsPage = page;
        this._countryGroups = new Map(); // countryId -> { group, leagueRows: Map<slug, row> }
        this._buildCountryGroups(page);
        this._refreshCompetitionsUI();
    }

    _buildCountryGroups(page) {
        for (const country of COUNTRY_GROUPS) {
            const group = new Adw.PreferencesGroup({
                title: countryLabel(country.id),
            });
            page.add(group);
            const leagueRows = new Map();

            for (const leagueDef of country.leagues) {
                const row = this._buildLeagueRow(leagueDef);
                group.add(row.widget);
                leagueRows.set(leagueDef.slug, row);
            }
            this._countryGroups.set(country.id, { group, leagueRows });
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

        // ComboRow for subscription mode.
        const modeList = new Gtk.StringList();
        modeList.append(_('All matches'));
        modeList.append(_('Specific teams only'));
        const modeRow = new Adw.ComboRow({
            title: _('Notify for'),
            model: modeList,
            selected: getMode(subs, slug) === SUBSCRIPTION_MODE.TEAMS ? 1 : 0,
        });
        expander.add_row(modeRow);

        // Team list group (built lazily when expander is opened).
        const teamsGroup = new Adw.PreferencesGroup({
            title: _('Teams'),
        });
        const teamsContainer = new Adw.ExpanderRow({
            title: _('Select teams'),
            visible: getMode(subs, slug) === SUBSCRIPTION_MODE.TEAMS,
        });
        const placeholderRow = new Adw.ActionRow({
            title: _('Teams will appear once the catalog has loaded.'),
        });
        teamsContainer.add_row(placeholderRow);
        expander.add_row(teamsContainer);

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
        });

        modeRow.connect('notify::selected', () => {
            const subsNow = readSubscriptions(this._settings);
            const entry = subsNow[slug] ?? { mode: SUBSCRIPTION_MODE.ALL, teams: [] };
            entry.mode = modeRow.selected === 1 ? SUBSCRIPTION_MODE.TEAMS : SUBSCRIPTION_MODE.ALL;
            subsNow[slug] = entry;
            writeSubscriptions(this._settings, subsNow);
            teamsContainer.visible = entry.mode === SUBSCRIPTION_MODE.TEAMS;
            expander.set_subtitle(this._leagueSubtitle(slug, subsNow));
        });

        return {
            widget: expander,
            slug,
            expander,
            modeRow,
            teamsContainer,
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
            for (const leagueDef of country.leagues) {
                const row = entry.leagueRows.get(leagueDef.slug);
                if (!row) continue;
                const leagueData = catalog[leagueDef.slug];
                const isConditionalHidden =
                    leagueDef.conditional && (!leagueData || leagueData.available === false);
                row.widget.visible = !isConditionalHidden;
                if (!isConditionalHidden) visibleCount++;
                this._populateTeams(row, leagueData?.teams ?? [], subs);
                row.widget.set_subtitle(this._leagueSubtitle(leagueDef.slug, subs));
            }
            entry.group.visible = visibleCount > 0;
        }

        this._statusRow.title = this._catalogStatusTitle();
        this._statusRow.subtitle = this._catalogStatusSubtitle();
    }

    _populateTeams(row, teams, subs) {
        // Remove old rows from teamsContainer (except the placeholder we will rebuild).
        for (const [, switchRow] of row.teamSwitches)
            row.teamsContainer.remove(switchRow);
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
            row.teamsContainer.add_row(switchRow);
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
            description: _('How often to query ESPN for updates. Lower values catch events sooner but use more bandwidth.'),
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

        const actionsGroup = new Adw.PreferencesGroup({
            title: _('Actions'),
        });
        page.add(actionsGroup);

        const forceRow = new Adw.ActionRow({
            title: _('Force a check now'),
            subtitle: _('Asks the background poller to query ESPN immediately.'),
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

        try {
            await ensureCatalog(this._settings, null);
            this._refreshCompetitionsUI();
        } catch (e) {
            console.warn(`[GnomeFootball] prefs: background catalog refresh failed: ${e.message}`);
        }
    }

    async _onRefreshClicked(button) {
        button.sensitive = false;
        const originalLabel = button.label;
        button.label = _('Refreshing…');
        try {
            await refreshCatalog(this._settings, null);
            this._refreshCompetitionsUI();
        } catch (e) {
            console.warn(`[GnomeFootball] prefs: manual catalog refresh failed: ${e.message}`);
        } finally {
            button.label = originalLabel;
            button.sensitive = true;
        }
    }
}
