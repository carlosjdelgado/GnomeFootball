# Changelog

All notable changes to Gnome Football are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.1] - 2026-06-12

### Fixed

- Calendar match panel now lists matches that kicked off in the early hours
  of your local day. A match starting after midnight local time (e.g. a
  04:00 kick-off in Europe/Madrid) falls in ESPN's previous UTC day, so the
  panel's "today" fetch was filing it under yesterday and leaving it out of
  today's list — even when it had already finished. The poller now fetches
  the full UTC range that covers the local day, matching the logic the
  calendar already used for other days, so an early-morning match shows up
  alongside the day's upcoming fixtures under its competition.

## [2.0.0] - 2026-06-12

### Added

- Calendar match panel. A new section in the GNOME calendar (the top-bar
  date menu) lists your subscribed matches for the selected day, grouped by
  competition. It is date-aware — browse past, current and upcoming days from
  the calendar — and shows each match's crests, score or kick-off time, and
  the live minute for matches in play. Controlled by the new
  `show-today-panel` toggle (**on by default**) under **General → Calendar
  panel** in preferences.
- Per-match mute. Each match notification carries a **Mute match** action,
  and every row in the calendar panel has a bell toggle, so you can silence a
  noisy fixture without unsubscribing from its league. A muted match is
  suppressed entirely (including full-time) and the mute auto-expires once the
  match finishes.
- Per-day mute. A **Mute all** / **Un-mute all** button in the calendar panel
  bulk-mutes (or restores) every match currently listed for the selected day.
- Mute matches by default. New `mute-matches-by-default` toggle
  (**off by default**) under **General → Notifications** — when on, no match
  notifies until you un-mute it from the calendar panel, turning the extension
  into an opt-in tracker.
- All new strings translated into every bundled locale (de, es, fr, it, pt).

## [1.2.0] - 2026-06-08

### Added

- Pre-match reminder. New `event-match-reminder` toggle, **off by default** —
  enable it in preferences to receive a heads-up notification before a
  subscribed match kicks off. A companion `reminder-lead-minutes` setting
  controls how far ahead it fires (default 30 minutes, range 5–180). The
  notification shows the teams, competition and local kick-off time, and
  fires once per match. Translated into all bundled locales (de, es, fr,
  it, pt).
- 7 new competitions across 3 new catalog groups:
  - **Mexico**: Liga MX, Liga de Expansión MX.
  - **Colombia**: Categoría Primera A, Categoría Primera B, Copa Colombia.
  - **Chile**: Primera División, Copa Chile.
- Clicking a notification opens that match's page (ESPN gamecast) in the
  default browser. Works for every event type; the notification stays in the
  tray after the click. Controlled by the new `open-match-page-on-click`
  toggle (**on by default**) under **General → Notifications** in preferences,
  so it can be turned off. Translated into all bundled locales (de, es, fr,
  it, pt).

## [1.1.2] - 2026-06-05

### Added

- Dark-mode logo selection. Notification crest and league logos now follow
  the active GNOME color scheme: the dark logo variant is used under
  `prefer-dark` and the default (light) variant otherwise, falling back to
  the default whenever a competition ships no dark variant. Cache keys are
  scoped by theme so switching appearance resolves the matching variant on
  the next notification.

### Changed

- Crest and league logos are now fetched at 150 × 150 px through the ESPN
  combiner endpoint instead of the 500 × 500 originals, cutting the
  download and on-disk cache size by ~91 %. At 150 px the image still
  covers 3× HiDPI; the rewrite is isolated to `lib/crest-cache.js` and
  only touches `a.espncdn.com/i/…` URLs — any other URL passes through
  unchanged. No user-facing changes.

## [1.1.1] - 2026-05-30

### Changed

- Replaced the JSON fixture replay harness with an interactive E2E test
  runner (`tests/e2e/run.sh`). Fixture files placed under
  `~/.local/share/gnomefootball/fixtures/<slug>/` are picked up
  automatically by the extension (disk-first lookup in `sports-api.js`)
  without any special mode being active. No user-facing changes.

## [1.1.0] - 2026-05-29

### Added

- Substitution notifications. New `event-substitution` toggle, **off by
  default** — enable it in preferences to receive a notification each time
  a player swap happens (`X replaces Y • minute • team • score`).
- VAR goal-disallowed notifications. When a previously notified goal is
  overturned (the play vanishes from the upstream feed and the team's
  score drops), a follow-up notification fires with the original scorer
  and the corrected score. Gated by the existing `event-goal` toggle —
  no extra switch.
- 13 new competitions and 5 new catalog groups:
  - **Brazil**: Brasileirão Série A, Brasileirão Série B, Copa do Brasil.
  - **Argentina**: Liga Profesional, Copa Argentina.
  - **United States**: Major League Soccer, US Open Cup.
  - **CONMEBOL**: Copa Libertadores, Copa Sudamericana, Recopa
    Sudamericana (club competitions only).
  - **CONCACAF**: CONCACAF Champions Cup, Leagues Cup
    *(conditional — only visible during its summer window)*.
  - **FIFA**: Club World Cup added alongside the World Cup, both
    conditional.

### Changed

- Preferences "Competitions" page reworked so it no longer overwhelms with
  the larger catalog. Each country/federation is now a collapsible row
  with an `X/Y enabled` subtitle counter; the league subscription, mode
  switch ("Specific teams only") and the team list are folded into a
  single nested row so subscribing to a few teams takes fewer clicks.
- Catalog refresh in preferences now shows a live progress indicator —
  a spinner replaces the "Refresh now" button while loading, the status
  row title becomes "Loading catalog…", and the subtitle counts leagues
  as they arrive (`Fetching leagues and teams (12 / 42)`). The previous
  silent refresh on prefs open made the window look frozen for the
  ~30 seconds the upstream calls take.

### Fixed

- Preferences chevrons of nested `AdwExpanderRow` rows (e.g. team
  selectors) no longer get stuck pointing up and tinted with the accent
  colour when their parent row is expanded. This was already present in
  1.0.0 — a libadwaita CSS specificity issue that propagated the parent's
  `:checked` styling down to descendant chevrons. Worked around with a
  scoped CSS override that re-asserts the collapsed state on nested rows.
- Preferences chevrons are now hidden entirely on rows whose expansion is
  locked (e.g. an unsubscribed league), removing a misleading affordance.

## [1.0.0] - 2026-05-17

Initial release, published on [extensions.gnome.org](https://extensions.gnome.org/extension/10007/).

### Added

- One notification per real event: kickoff, goals, yellow/red cards,
  half-time, second-half start, full-time, extra time, penalty shootout.
- Per-competition subscriptions with two modes: **all matches** in a
  league, or **specific teams** within a league.
- 28 leagues and cups across Spain, England, Italy, France, Portugal,
  Germany, UEFA and FIFA. Team rosters discovered live and cached for
  7 days.
- Crest icons on notifications, with on-disk caching.
- Cold-start protection: past events of an in-progress match are absorbed
  silently instead of producing catch-up notifications.
- Configurable polling interval (1–30 minutes, default 5).
- Translations: English, Spanish, Portuguese, Italian, German, French.
- JSON fixture replay harness for development testing (replaced in 1.1.1).

[Unreleased]: https://github.com/carlosjdelgado/GnomeFootball/compare/v2.0.0...HEAD
[2.0.1]: https://github.com/carlosjdelgado/GnomeFootball/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.1.2...v1.2.0
[1.1.2]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/carlosjdelgado/GnomeFootball/releases/tag/v1.0.0
