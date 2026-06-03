# Gnome Football

[![GNOME Extensions Version](https://img.shields.io/gnome-extensions/v/gnomefootball@carlosjdelgado)](https://extensions.gnome.org/extension/10007/gnome-football/)
[![GNOME Extensions Downloads](https://img.shields.io/gnome-extensions/dt/gnomefootball@carlosjdelgado)](https://extensions.gnome.org/extension/10007/gnome-football/)

A GNOME Shell extension that delivers native desktop notifications for football
(soccer) matches. It runs quietly in the background — no panel indicator, no
tray icon — and only speaks up when something happens in a match you care
about.

Data comes from a public soccer data API. Configuration lives in the standard
GNOME Extensions preferences window.

- **UUID:** `gnomefootball@carlosjdelgado`
- **GNOME Shell:** 48, 49, 50
- **Language:** GJS (GNOME JavaScript), ES modules
- **UI toolkit (prefs):** libadwaita 1.4+
- **License:** [GPL-2.0-or-later](LICENSE)
- **Changelog:** [docs/CHANGELOG.md](docs/CHANGELOG.md)

---

## Features

- One notification per real event: kickoff, goals, yellow/red cards, half-time,
  second-half start, full-time, extra time, penalty shootout.
- VAR goal-disallowed: when a previously-notified goal is overturned, you get
  a follow-up notification with the original scorer and the corrected score.
  Gated by the regular goal toggle — no extra switch.
- Substitutions (opt-in): off by default; enable in preferences to receive a
  notification each time a player swap happens.
- Pre-match reminder (opt-in): off by default; enable it to get a heads-up
  before a subscribed match kicks off. A configurable lead time (5–180
  minutes, default 30) controls how far ahead it fires, and it fires once per
  match.
- Click-to-open (on by default): clicking any notification opens that match's
  page in your default browser, and the notification stays in the tray after
  the click. Toggle it off under **General → Notifications** in preferences.
- Per-competition subscriptions, with two modes:
  - **All matches** in a league.
  - **Specific teams** — receive only matches that include any of the teams you
    pick.
- 49 leagues and cups across Spain, England, Italy, France, Portugal, Germany,
  Brazil, Argentina, Mexico, Colombia, Chile, United States, UEFA, CONMEBOL,
  CONCACAF and FIFA. Team rosters are discovered live from the upstream API and
  cached for 7 days.
- Crest icons on notifications, with on-disk caching.
- Cold-start protection: if the extension wakes up while a match is already in
  progress, past events are absorbed silently instead of spamming you with
  catch-up notifications.
- Configurable polling interval (1–30 minutes, default 5).
- Translated to Spanish, Portuguese, Italian, German and French.

---

## Screenshots

Native GNOME notifications, with the team crest on the left and the league
context in the body.

<table>
  <tr>
    <td align="center"><img src="docs/screenshots/notification-goal.png" alt="Goal notification" /></td>
    <td align="center"><img src="docs/screenshots/notification-second-half.png" alt="Second half start notification" /></td>
    <td align="center"><img src="docs/screenshots/notification-red-card.png" alt="Red card notification" /></td>
  </tr>
  <tr>
    <td align="center"><em>Goal — the scoring team's crest is downloaded and cached locally.</em></td>
    <td align="center"><em>Second half start — match-state transitions show the league badge.</em></td>
    <td align="center"><em>Red card — player name, minute, team, and running score.</em></td>
  </tr>
</table>

---

## Requirements

- GNOME Shell **48, 49 or 50**.
- `glib-compile-schemas` (ships with `glib2`).
- `msgfmt` (from `gettext`) — only needed to compile translations.
- An internet connection (the extension fetches data from a public sports data
  API).

---

## Installation

### From extensions.gnome.org (recommended)

The extension is published at
**[extensions.gnome.org/extension/10007/gnome-football](https://extensions.gnome.org/extension/10007/gnome-football/)**.

Install it through either of the usual paths:

- Open the listing with the
  [GNOME Shell browser integration](https://gnome.pages.gitlab.gnome.org/gnome-browser-integration/pages/installation-guide.html)
  installed (Firefox / Chrome / Edge) and flip the toggle to **ON**.
- Or open the
  [Extension Manager](https://flathub.org/apps/com.mattjakeman.ExtensionManager)
  app, search for *Gnome Football*, and click **Install**.

Once installed it's enabled automatically; no shell restart needed. See
[Usage](#usage) below for the prefs.

### From source (development install)

```sh
git clone https://github.com/carlosjdelgado/GnomeFootball.git
cd GnomeFootball
./install.sh
```

`install.sh` does three things:

1. Compiles the GSettings schema (`schemas/gschemas.compiled`).
2. Builds gettext `.mo` catalogs from `po/*.po` into `locale/`.
3. Symlinks the working copy into
   `~/.local/share/gnome-shell/extensions/gnomefootball@carlosjdelgado` so
   edits show up without reinstalling.

After that, restart the Shell so it picks up the new extension:

- **X11:** press `Alt+F2`, type `r`, hit `Enter`.
- **Wayland:** log out and back in (or reboot).

Then enable it:

```sh
gnome-extensions enable gnomefootball@carlosjdelgado
gnome-extensions prefs  gnomefootball@carlosjdelgado
```

### As a packaged zip

```sh
./package.sh
# Produces build/gnomefootball@carlosjdelgado.shell-extension.zip
gnome-extensions install --force build/gnomefootball@carlosjdelgado.shell-extension.zip
```

---

## Usage

Open the preferences window:

```sh
gnome-extensions prefs gnomefootball@carlosjdelgado
```

You'll find three pages:

- **Competitions.** At the top, a **Catalog** card shows when leagues and teams
  were last loaded from the upstream source and offers a **Refresh now** button;
  the catalog loads automatically on first open and is cached locally. Below it,
  toggle the leagues you want to follow. Each enabled league defaults to **All
  matches**; flip its **Specific teams only** switch to instead receive only
  matches involving teams you pick from the inline list. Conditional entries —
  such as cup competitions with a seasonal window — stay hidden until the
  upstream API reports active events for them.
- **Events.** At the top, a **Match reminder** card with a **Remind me before
  kick-off** switch (off by default) and a **Minutes before kick-off** field
  (5–180, default 30) that becomes editable once the reminder is on. Below it,
  one switch per in-match notification type: match start, goal, yellow card,
  red card, substitution, half-time, second-half start, full-time, extra time
  and penalty shootout.
- **General.** Polling interval (1–30 min), a **Notifications** card with an
  **Open match page on click** switch (on by default) that controls whether
  clicking a notification opens the match page in your browser, and a **Check
  now** button that forces an immediate tick.

That's it. Once you have at least one subscription, the extension will start
polling and surfacing notifications as matches happen.

### Where state lives

- **Preferences:** GSettings under
  `/org/gnome/shell/extensions/gnomefootball/`.
- **Live match state:** `$XDG_DATA_HOME/gnomefootball/live-state.json`
  (typically `~/.local/share/gnomefootball/live-state.json`).
- **Crest cache:** `$XDG_CACHE_HOME/gnomefootball/` (typically
  `~/.cache/gnomefootball/`).

If something looks stuck, you can safely delete the data dir — the extension
will rebuild it on the next tick.

---

## How it works

Each polling tick does:

1. Read `subscriptions-json` from GSettings to find which league slugs to
   query.
2. For every subscribed slug, fetch `/scoreboard` from the upstream API.
3. For matches that pass the subscription filter and are **in progress** (or
   about to kick off within the pre-match watch window), fetch the per-match
   `/summary` for the play-by-play (`keyEvents`).
4. Diff the new scoreboard + summary against the previous snapshot stored in
   `live-state.json`. The detector emits one logical event per real
   transition (kickoff, halftime, goal, card, etc.).
5. Forward each emitted event to the notifier, which builds a fresh
   `MessageTray.Notification` so notifications stack instead of replacing.
6. Persist the updated snapshot. Finished matches are pruned 6 hours after the
   final whistle.

### Cold-start suppression

The first time the extension sees a match that is **already in progress** (or
post), it captures a baseline snapshot but emits **zero** notifications. This
prevents a flood of "catch-up" alerts after a logout/login or extension
reload. From the next tick onward only true deltas are notified.

### Polling and the pre-match window

Matches in the `pre` state are only fetched when they kick off within the
pre-match watch window — 10 minutes by default
(`PRE_MATCH_WATCH_WINDOW_MINUTES`). This keeps the upstream footprint small
without missing the kickoff transition. When the match reminder is enabled the
poller widens that window to the reminder lead time (`max(10, lead-minutes)`)
so a not-yet-started match is already being tracked when its reminder is due to
fire.

---

## Development

### Iterating on the source

The dev workflow assumes you've run `./install.sh` once so the symlink exists.

| What you changed | Action required |
|---|---|
| `extension.js` | Disable → enable the extension |
| `lib/*.js` | Full logout/login (Wayland) or `Alt+F2 r` (X11) |
| `prefs.js` | Close and reopen the prefs window |
| `schemas/*.gschema.xml` | Re-run `./install.sh`, then reload the Shell |
| `po/*.po` | Re-run `./install.sh` to rebuild `locale/*.mo` |
| Scenarios under `tests/e2e/scenarios/` | Re-read on every run — no reload needed |

> **Note on GJS module caching.** On Wayland, disable/enable only re-imports
> `extension.js`. Everything under `lib/` is cached for the lifetime of the
> Shell process, so any change inside `lib/` requires a Shell restart. On
> Wayland that means a logout/login.

### Reading logs

```sh
journalctl --user -f -o cat /usr/bin/gnome-shell | grep -E '(GnomeFootball|gnomefootball)'
```

All log lines from the extension are prefixed with `[GnomeFootball]`.

### Forcing an immediate poll

```sh
gsettings set org.gnome.shell.extensions.gnomefootball force-check-trigger $(date +%s)
```

The poller listens for changes to that key and runs a tick on the spot.

### E2E test runner

The runner injects a fictional match directly into the live extension by
writing fixture files under `~/.local/share/gnomefootball/fixtures/<slug>/`.
`sports-api.js` picks them up via a disk-first lookup, so no special mode is
needed and real subscribed matches continue to work alongside the test match.

Requirements: `gsettings`, `jq`, and the extension installed and enabled.

```sh
./tests/e2e/run.sh
```

The script is interactive: each step shows the expected notification and waits
for you to press **Enter** to fire the next tick, or **q** to quit early.
Cleanup (fixture files, subscription entry, live-state entry) runs
automatically on exit.

To exercise a new case, edit the scenario under `tests/e2e/scenarios/`: each
step is a fixture snapshot the runner feeds to the extension on the next tick,
so adding a step (or tweaking an existing one) lets you reproduce any sequence
of match states without a real match.

---

## Internationalization

Translations live under `po/`:

- `gnomefootball.pot` — template, regenerated whenever new strings are added.
- `de.po`, `es.po`, `fr.po`, `it.po`, `pt.po` — per-locale catalogs.

After editing a `.po` file, run `./install.sh` (or `./package.sh`) to rebuild
the `.mo` files in `locale/`.

To add a new language:

1. `msginit --input=po/gnomefootball.pot --locale=<lang>_<COUNTRY>` to create
   `po/<lang>.po`.
2. Translate the entries.
3. Re-run `./install.sh`.

To refresh the `.pot` template after changing source strings:

```sh
xgettext --from-code=UTF-8 \
    --keyword=_ --keyword=N_ \
    --output=po/gnomefootball.pot \
    extension.js prefs.js lib/*.js
```

---

## Contributing

Contributions are welcome — bug reports, fixture additions, new translations,
extra leagues, UI polish, anything that helps.

### Ground rules

- **Code, identifiers, comments, defaults and the gettext template stay in
  English.** Translations are the only place for other languages.
- Keep the no-panel-UI principle. The extension stays invisible until a
  notification fires; configuration belongs in the prefs window.
- Don't add features beyond what the task requires; resist premature
  abstractions.
- Match the existing style: ES modules, 4-space indentation, no semicolons
  omitted, prefer explicit imports over `*`.

### Before opening a PR

1. Run `./install.sh` and confirm the extension loads (`journalctl` is clean).
2. If you changed anything in `lib/poller.js`, `lib/event-detector.js` or
   `lib/notifier.js`, run `./tests/e2e/run.sh` and verify each step
   produces the expected notification.
3. If you touched the schema, bump the relevant defaults in `prefs.js` if
   needed and verify `glib-compile-schemas schemas/` exits clean.
4. If you added user-visible strings, refresh `po/gnomefootball.pot` and run
   `./install.sh` to make sure existing translations still build.

### Good first contributions

- Add a new league slug under `lib/constants.js → COUNTRY_GROUPS` and verify
  the upstream API returns `200 OK` for `/teams` and `/scoreboard` on that
  slug.
- Translate `po/gnomefootball.pot` into your language.
- Extend the E2E test scenario with steps for event types not yet covered.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Extension shows up but never notifies | No subscriptions, or the subscribed leagues have no live matches. Use **Check now** in prefs and watch the logs. |
| `tick: no subscriptions, skipping` in the journal | The `subscriptions-json` map is empty — open prefs and enable at least one league. |
| Notifications appear with the generic games-controller icon | The icon theme didn't pick up `gnomefootball-symbolic.svg`. Reinstall via `./install.sh` and reload the Shell. |
| Burst of catch-up notifications after enabling the extension | Should not happen — file an issue with the journal output. The cold-start logic is designed to suppress these. |
| `summary <slug>/<id> failed` warnings | Transient upstream errors. The poller retries with backoff; usually self-heals on the next tick. |

---

## Acknowledgments

- GNOME Shell + libadwaita teams for the platform.
- All translators contributing under `po/`.

---

## License

Released under the **GNU General Public License v2.0 or later**
(`GPL-2.0-or-later`). See the [LICENSE](LICENSE) file for the full text.
