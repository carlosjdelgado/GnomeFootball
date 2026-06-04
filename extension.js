// GnomeFootball — main extension entry point.
// No panel indicator; the extension only runs a periodic poller and shows
// notifications. Configuration is done via the Extensions app.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Poller } from './lib/poller.js';
import { initNotifier, disposeNotifier } from './lib/notifier.js';
import { MatchDataProvider } from './lib/match-data.js';
import { CalendarPanel } from './lib/calendar-panel.js';

export default class GnomeFootballExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        initNotifier(this.path, this._settings);
        this._poller = new Poller(this._settings);

        // Calendar panel (Feature 1): consumes the poller's live "today"
        // snapshot and the date-aware data layer for other days.
        this._dataProvider = new MatchDataProvider(this._settings);
        this._panel = new CalendarPanel({
            settings: this._settings,
            dataProvider: this._dataProvider,
            getTodayMatches: () => this._poller.getTodayMatches(),
        });
        this._poller.setOnUpdate(() => this._panel.refreshIfToday());
        this._panel.enable();

        this._poller.enable();
        console.debug('[GnomeFootball] enabled');
    }

    disable() {
        if (this._poller) {
            this._poller.disable();
            this._poller = null;
        }
        if (this._panel) {
            this._panel.disable();
            this._panel = null;
        }
        if (this._dataProvider) {
            this._dataProvider.clearCache();
            this._dataProvider = null;
        }
        disposeNotifier();
        this._settings = null;
        console.debug('[GnomeFootball] disabled');
    }
}
