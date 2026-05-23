// GnomeFootball — main extension entry point.
// No panel indicator; the extension only runs a periodic poller and shows
// notifications. Configuration is done via the Extensions app.

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Poller } from './lib/poller.js';
import { initNotifier, disposeNotifier } from './lib/notifier.js';

export default class GnomeFootballExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        initNotifier(this.path);
        this._poller = new Poller(this._settings);
        this._poller.enable();
        console.debug('[GnomeFootball] enabled');
    }

    disable() {
        if (this._poller) {
            this._poller.disable();
            this._poller = null;
        }
        disposeNotifier();
        this._settings = null;
        console.debug('[GnomeFootball] disabled');
    }
}
