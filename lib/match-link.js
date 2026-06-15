// Opens the ESPN match page in the user's default browser. Shared by the
// notifier (banner click) and the calendar panel (score click).

import Gio from 'gi://Gio';

// ESPN resolves a match by its global gameId regardless of competition, so a
// single base is enough for every event type. The page always opens in English
// (www.espn.com); no locale variants.
const MATCH_URL_BASE = 'https://www.espn.com/soccer/match/_/gameId/';

// Real upstream event IDs are numeric; anything else (e.g. the test fixtures'
// "test-…" id) has no ESPN page, so a click must never launch a bogus URL.
export function canOpenMatch(eventId) {
    return /^\d+$/.test(String(eventId ?? ''));
}

// Launch the match page. Returns false when the id has no real page or the
// launch fails.
export function openMatchPage(eventId) {
    const id = String(eventId ?? '');
    if (!canOpenMatch(id))
        return false;
    try {
        Gio.AppInfo.launch_default_for_uri(`${MATCH_URL_BASE}${id}`, null);
        return true;
    } catch (e) {
        console.warn(`[GnomeFootball] failed to open match page: ${e.message}`);
        return false;
    }
}
