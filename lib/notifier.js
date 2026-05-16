// Sends GNOME notifications for detected match events.
//
// Uses MessageTray.Source + MessageTray.Notification so each event creates its
// own banner (no in-place replacement). Notifications are silent; the OS still
// controls global notification sounds.
//
// Clicking the notification opens the ESPN match page in the user's default
// browser via Gio.AppInfo.launch_default_for_uri.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { EVENT_TYPE, espnMatchUrl } from './constants.js';
import { getIcon as getCachedIcon, disposeCrestCache } from './crest-cache.js';

let _source = null;
let _extensionPath = null;
let _defaultGicon = null;

export function initNotifier(extensionPath) {
    _extensionPath = extensionPath;
    _defaultGicon = null;
}

function gettext(text) {
    // Resolved at runtime via the extension's gettext binding (set up in
    // extension.js with initTranslations). At import time we just call
    // GLib's dgettext directly so this module is independent.
    return GLib.dgettext('gnomefootball', text) || text;
}

function defaultGicon() {
    if (_defaultGicon)
        return _defaultGicon;
    if (_extensionPath) {
        const file = Gio.File.new_for_path(
            `${_extensionPath}/icons/hicolor/scalable/apps/gnomefootball-symbolic.svg`);
        _defaultGicon = new Gio.FileIcon({ file });
    } else {
        _defaultGicon = new Gio.ThemedIcon({ name: 'applications-games-symbolic' });
    }
    return _defaultGicon;
}

function ensureSource() {
    if (_source)
        return _source;

    _source = new MessageTray.Source({
        title: 'Gnome Football',
        icon: defaultGicon(),
    });
    _source.connect('destroy', () => { _source = null; });
    Main.messageTray.add(_source);
    return _source;
}

// Ordered list of (cache key, remote url) candidates to try for an event.
// The notifier walks this list and uses the first one that downloads/loads
// successfully, falling back to FALLBACK_ICON if all entries fail.
function iconCandidatesForEvent(event) {
    const candidates = [];
    const pushTeam = (team) => {
        if (team?.id && team?.logo)
            candidates.push({ key: `team-${team.id}`, url: team.logo });
    };
    const pushLeague = () => {
        if (event.leagueSlug && event.leagueLogo)
            candidates.push({ key: `league-${event.leagueSlug}`, url: event.leagueLogo });
    };

    const hasProtagonist =
        event.type === EVENT_TYPE.GOAL ||
        event.type === EVENT_TYPE.YELLOW_CARD ||
        event.type === EVENT_TYPE.RED_CARD;

    if (hasProtagonist) {
        pushTeam(event.team);
        pushLeague();
    } else {
        pushLeague();
        pushTeam(event.home);
    }
    return candidates;
}

async function resolveIcon(event) {
    for (const { key, url } of iconCandidatesForEvent(event)) {
        try {
            return await getCachedIcon(key, url);
        } catch (e) {
            console.warn(`[GnomeFootball] icon ${key} failed: ${e.message}`);
        }
    }
    return defaultGicon();
}

function formatTitleAndBody(event) {
    const home = event.home?.name ?? gettext('Home');
    const away = event.away?.name ?? gettext('Away');
    const score = `${event.homeScore}-${event.awayScore}`;
    const league = event.leagueName ?? '';
    const minute = event.playMinute ? `${event.playMinute}'` : '';
    const player = event.playerName ?? '';
    const team = event.team?.name ?? '';

    switch (event.type) {
        case EVENT_TYPE.MATCH_START:
            return {
                title: gettext('Kick-off'),
                body: `${home} vs ${away}${league ? ` — ${league}` : ''}`,
            };

        case EVENT_TYPE.GOAL:
            return {
                title: gettext('GOAL'),
                body: [
                    `${home} ${score} ${away}`,
                    [player, minute].filter(Boolean).join(' '),
                    team,
                ].filter(Boolean).join(' • '),
            };

        case EVENT_TYPE.YELLOW_CARD:
            return {
                title: gettext('Yellow card'),
                body: [
                    [player, minute].filter(Boolean).join(' '),
                    team,
                    `${home} ${score} ${away}`,
                ].filter(Boolean).join(' • '),
            };

        case EVENT_TYPE.RED_CARD:
            return {
                title: gettext('Red card'),
                body: [
                    [player, minute].filter(Boolean).join(' '),
                    team,
                    `${home} ${score} ${away}`,
                ].filter(Boolean).join(' • '),
            };

        case EVENT_TYPE.HALF_TIME_END:
            return {
                title: gettext('Half-time'),
                body: `${home} ${score} ${away}${league ? ` — ${league}` : ''}`,
            };

        case EVENT_TYPE.SECOND_HALF_START:
            return {
                title: gettext('Second half'),
                body: `${home} ${score} ${away}${league ? ` — ${league}` : ''}`,
            };

        case EVENT_TYPE.MATCH_END:
            return {
                title: gettext('Full-time'),
                body: `${home} ${score} ${away}${league ? ` — ${league}` : ''}`,
            };

        case EVENT_TYPE.EXTRA_TIME:
            return {
                title: gettext('Extra time'),
                body: `${home} ${score} ${away}${league ? ` — ${league}` : ''}`,
            };

        case EVENT_TYPE.PENALTIES:
            return {
                title: gettext('Penalty shootout'),
                body: `${home} ${score} ${away}${league ? ` — ${league}` : ''}`,
            };

        default:
            return {
                title: gettext('Match update'),
                body: `${home} ${score} ${away}`,
            };
    }
}

function openInBrowser(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
    } catch (e) {
        console.warn(`[GnomeFootball] notifier: failed to open ${url}: ${e.message}`);
    }
}

export async function notifyEvent(event) {
    const source = ensureSource();
    const { title, body } = formatTitleAndBody(event);
    const url = espnMatchUrl(event.eventId);
    const gicon = await resolveIcon(event);

    const notification = new MessageTray.Notification({
        source,
        title,
        body,
        gicon,
        isTransient: false,
        urgency: MessageTray.Urgency.NORMAL,
    });

    notification.connect('activated', () => openInBrowser(url));

    source.addNotification(notification);
}

export function disposeNotifier() {
    if (_source) {
        try { _source.destroy(); } catch (_) { /* ignore */ }
        _source = null;
    }
    disposeCrestCache();
}
