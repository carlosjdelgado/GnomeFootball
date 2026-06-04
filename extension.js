// GnomeFootball — main extension entry point.
// No panel indicator; the extension only runs a periodic poller and shows
// notifications. Configuration is done via the Extensions app.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Poller } from './lib/poller.js';
import { initNotifier, disposeNotifier } from './lib/notifier.js';
import { MatchDataProvider } from './lib/match-data.js';
import { CalendarPanel } from './lib/calendar-panel.js';
import { MuteController } from './lib/mute-controller.js';

export default class GnomeFootballExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        // One mute controller shared by the notifier, poller and panel. Persisted
        // mutes load asynchronously; it starts empty until load() resolves.
        this._mute = new MuteController({
            isDefaultMuted: () => this._settings.get_boolean('mute-matches-by-default'),
        });
        this._mute.load().catch(e =>
            console.warn(`[GnomeFootball] mute load failed: ${e.message}`));
        // Apply "mute by default" flips live (no relogin needed).
        this._muteDefaultChangedId = this._settings.connect(
            'changed::mute-matches-by-default', () => this._mute.notifyDefaultChanged());

        initNotifier(this.path, this._settings, this._mute);
        this._poller = new Poller(this._settings, this._mute);

        this._dataProvider = new MatchDataProvider(this._settings);
        this._panel = new CalendarPanel({
            settings: this._settings,
            dataProvider: this._dataProvider,
            getTodayMatches: () => this._poller.getTodayMatches(),
            mute: this._mute,
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
        if (this._muteDefaultChangedId) {
            this._settings.disconnect(this._muteDefaultChangedId);
            this._muteDefaultChangedId = null;
        }
        if (this._mute) {
            this._mute.dispose();
            this._mute = null;
        }
        this._settings = null;
        console.debug('[GnomeFootball] disabled');
    }
}
