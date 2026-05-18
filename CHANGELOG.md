# Changelog

All notable changes to Gnome Football are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - TBD

### Added

- Substitution notifications. New `event-substitution` toggle, **off by
  default** — enable it in preferences to receive a notification each time
  a player swap happens (`X replaces Y • minute • team • score`).
- VAR goal-disallowed notifications. When a previously notified goal is
  overturned (the play vanishes from the upstream feed and the team's
  score drops), a follow-up notification fires with the original scorer
  and the corrected score. Gated by the existing `event-goal` toggle —
  no extra switch.

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
- Replay/test harness driven by JSON fixtures, no network required.

[Unreleased]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/carlosjdelgado/GnomeFootball/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/carlosjdelgado/GnomeFootball/releases/tag/v1.0.0
