// League and team catalog: loads team rosters from the upstream API, normalizes
// the response, caches the result in GSettings (catalog-cache-json) for
// CATALOG_TTL_SECONDS.

import GLib from 'gi://GLib';

import {
    ALL_LEAGUE_SLUGS,
    CATALOG_TTL_SECONDS,
    COUNTRY_GROUPS,
    findLeagueMeta,
} from './constants.js';
import { fetchScoreboard, fetchTeams } from './sports-api.js';

function nowSeconds() {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

function normalizeTeam(rawTeam) {
    return {
        id: String(rawTeam.id),
        name: rawTeam.displayName ?? rawTeam.name ?? rawTeam.shortDisplayName ?? '',
        abbreviation: rawTeam.abbreviation ?? '',
        logo: rawTeam.logos?.[0]?.href ?? rawTeam.logo ?? '',
    };
}

function extractTeamsFromTeamsResponse(response) {
    // /teams response shape: sports[0].leagues[0].teams = [{ team: {...} }, ...]
    const leaguesArray = response?.sports?.[0]?.leagues;
    if (!Array.isArray(leaguesArray) || leaguesArray.length === 0)
        return [];
    const teamWrappers = leaguesArray[0].teams ?? [];
    return teamWrappers
        .map(w => w?.team)
        .filter(Boolean)
        .map(normalizeTeam);
}

async function fetchOneLeague(slug, cancellable) {
    const meta = findLeagueMeta(slug);
    const defaultName = meta?.league?.defaultName ?? slug;
    const countryId = meta?.group?.id ?? 'other';

    try {
        const data = await fetchTeams(slug, cancellable);
        const teams = extractTeamsFromTeamsResponse(data);
        const leagueInfo = data?.sports?.[0]?.leagues?.[0];
        return {
            slug,
            name: leagueInfo?.name ?? defaultName,
            abbreviation: leagueInfo?.abbreviation ?? '',
            logo: leagueInfo?.logos?.[0]?.href ?? '',
            country: countryId,
            teams,
            available: teams.length > 0,
        };
    } catch (e) {
        console.warn(`[GnomeFootball] catalog: failed to fetch teams for ${slug}: ${e.message}`);
        return {
            slug,
            name: defaultName,
            country: countryId,
            teams: [],
            available: false,
            error: e.message,
        };
    }
}

// Conditional leagues (e.g. FIFA World Cup) are only marked available when the
// scoreboard returns at least one event — otherwise hidden in the UI.
async function probeConditionalAvailability(slug, cancellable) {
    try {
        const data = await fetchScoreboard(slug, cancellable);
        return Array.isArray(data?.events) && data.events.length > 0;
    } catch (e) {
        return false;
    }
}

export function isCatalogFresh(settings) {
    const fetchedAt = settings.get_int64('catalog-fetched-at');
    if (!fetchedAt)
        return false;
    return (nowSeconds() - Number(fetchedAt)) < CATALOG_TTL_SECONDS;
}

export function readCatalog(settings) {
    const raw = settings.get_string('catalog-cache-json');
    try {
        return JSON.parse(raw || '{}');
    } catch (_) {
        return {};
    }
}

export function writeCatalog(settings, catalog) {
    settings.set_string('catalog-cache-json', JSON.stringify(catalog));
    settings.set_int64('catalog-fetched-at', nowSeconds());
}

export async function refreshCatalog(settings, cancellable = null, onProgress = null) {
    const catalog = {};
    const total = ALL_LEAGUE_SLUGS.length;
    let done = 0;

    for (const group of COUNTRY_GROUPS) {
        for (const leagueDef of group.leagues) {
            if (cancellable?.is_cancelled())
                throw new Error('Cancelled');

            if (leagueDef.conditional) {
                const active = await probeConditionalAvailability(leagueDef.slug, cancellable);
                if (!active) {
                    catalog[leagueDef.slug] = {
                        slug: leagueDef.slug,
                        name: leagueDef.defaultName,
                        country: group.id,
                        teams: [],
                        available: false,
                        conditional: true,
                    };
                    done++;
                    onProgress?.({ done, total, currentSlug: leagueDef.slug });
                    continue;
                }
            }

            catalog[leagueDef.slug] = await fetchOneLeague(leagueDef.slug, cancellable);
            if (leagueDef.conditional)
                catalog[leagueDef.slug].conditional = true;

            done++;
            onProgress?.({ done, total, currentSlug: leagueDef.slug });
        }
    }

    writeCatalog(settings, catalog);
    return catalog;
}

export async function ensureCatalog(settings, cancellable = null, onProgress = null) {
    if (isCatalogFresh(settings)) {
        const cached = readCatalog(settings);
        if (Object.keys(cached).length === ALL_LEAGUE_SLUGS.length)
            return cached;
    }
    return refreshCatalog(settings, cancellable, onProgress);
}
