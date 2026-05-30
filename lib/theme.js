// Picks ESPN logo variants (rel: "default"/"dark") by the GNOME color scheme.

import Gio from 'gi://Gio';

let _interfaceSettings = null;

function interfaceSettings() {
    if (!_interfaceSettings)
        _interfaceSettings = new Gio.Settings({ schema: 'org.gnome.desktop.interface' });
    return _interfaceSettings;
}

export function isDarkTheme() {
    try {
        return interfaceSettings().get_string('color-scheme') === 'prefer-dark';
    } catch (_) {
        return false;
    }
}

// Logo href for the current scheme; falls back to the first entry, then ''.
export function pickLogo(logos) {
    if (!Array.isArray(logos) || logos.length === 0)
        return '';
    const wanted = isDarkTheme() ? 'dark' : 'default';
    const match = logos.find(l => Array.isArray(l?.rel) && l.rel.includes(wanted));
    return match?.href ?? logos[0]?.href ?? '';
}
