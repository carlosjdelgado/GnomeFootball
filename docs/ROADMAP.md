# Roadmap

This file collects forward-looking design decisions for upcoming versions
of Gnome Football. A version's section here freezes the *what* and *why*
before implementation begins; the *what shipped* lives in
[`CHANGELOG.md`](CHANGELOG.md) once released.

The roadmap is intentionally not linked from the `README` — it is
working notes for the maintainer, not user-facing material.

## v2.0.0 — Calendar-integrated match panel

### Vision

Make today's, yesterday's and tomorrow's matches part of the GNOME shell
itself rather than a separate widget bolted onto it. The user clicks a
day in the calendar popup; the matches for that day appear in the same
popup. No new panel icon, no new app — the calendar simply knows about
football.

This is a deliberate shift from the v1.x identity ("invisible until a
notification fires"). v2.0.0 keeps notifications as the primary
interaction, but adds a passive surface where the user can glance at
fixtures without leaving the shell.

### Decisions adopted

#### D1 — Location: DateMenu (calendar popup)

The panel lives as a section inside the calendar popup, next to the
weather and the message list. Candidates considered and rejected:

- **Quick Settings (`SystemIndicator`)**: official extension API, more
  stable across shell versions, but Quick Settings is mentally
  "toggles and system state" — not "events of the day". A list of
  matches there would feel out of place.
- **Panel button (`PanelMenu.Button`)**: most flexible, most stable,
  but breaks the v1.x identity of no permanent panel UI. Feels like a
  separate app sitting in the panel — the opposite of the integration
  aimed at.
- **Persistent notification**: GNOME notifications are not designed
  to be sticky widgets; auto-dismissal makes them unsuitable.

DateMenu wins on "feels like a feature of GNOME, not an extension".

**Trade-off:** the panel attaches to shell internals
(`Main.panel.statusArea.dateMenu`), not to a public extension API.
Each major shell release may require revalidation. Mitigation:
implement as a subclass of `MessageListSection` (the same class used
by weather, stable since shell 46), validate on the three supported
shell versions before release, and accept that a future GNOME 51
redesign may need a v2.0.1 patch.

#### D2 — Date-aware, not today-only

The panel mirrors the day the user has selected in the calendar
widget. GNOME's calendar already emits a `selected-date` signal when
the user clicks a day; the panel listens to that signal and refreshes.

- **Today** (default on popup open): live data from the existing
  poller — no separate fetch.
- **Past dates**: final score and full-time status. Data is
  immutable.
- **Future dates**: scheduled kickoff time, no score.

Empty states are differentiated by tense: "No matches today", "No
matches played on this day", "No matches scheduled for this day".

**Why over a today-only design:** the date-aware version doubles the
value without adding any new UI affordance — it reuses the calendar
grid that GNOME already paints. It converts the panel from "info
widget glued next to the calendar" into "the calendar itself knows
about football", which is the level of integration the feature is
aiming at.

**Cost:** roughly double the surface of a today-only panel (per-date
caching, on-demand fetches, error handling per date). Accepted.

#### D3 — Date range: unlimited

Any date the user can navigate to in GNOME's calendar widget is
fetched on demand. No artificial caps. If ESPN has no data for a
date, the empty-state copy fires. Old finals and far-future fixtures
are both fair game.

#### D4 — Cache: in-memory only, rebuilt per session

Past dates are cached in memory until the shell session ends. No new
files on disk, no purge logic, no invalidation rules. The cost is a
re-fetch of recently viewed dates after each login, which is
negligible for a feature browsed occasionally.

The existing `live-state.json` is **not** extended for this; it stays
focused on per-event diffing for notifications.

#### D5 — Filter: subscriptions only

The panel shows the same matches the user would receive notifications
for: subscribed competitions, filtered by team selection when
`mode === "teams"`. No "show all" toggle, no exception list. Coherent
with the notification model — if a match would not generate a
notification, it does not appear in the panel either.

#### D6 — Rows are read-only

A row displays the match (teams, score or kickoff time, current
minute or final status) but has no click action. Rationale:

- Clicking to open ESPN duplicates an action already available on
  notifications.
- Inline expansion (goalscorers, cards, minute-by-minute) is
  significantly more work and pushes the extension toward being
  "an app".
- Read-only keeps v2.0.0 focused and shippable.

The decision can be revisited in v2.1.0 if user feedback asks for it.

#### D7 — Configuration: a single toggle

One new GSetting, `show-today-panel` (boolean, default `true`). Users
who do not want the panel disable it. Everything else (filter,
ordering, layout) is opinionated and not exposed.

Rejected alternatives: ordering options, density toggles,
crest-on/off — each one is a UI surface to maintain for marginal
user value.

#### D8 — Empty state is visible, not hidden

When no matches match the current selection, the section still shows
a one-line empty-state message. Hiding the section entirely was
rejected because it would make the feature undiscoverable: a user
who just installed the extension would not see anything in the
calendar on an idle Tuesday.

### Out of scope for v2.0.0

- Inline expansion of a match row.
- Configurable ordering, density, or column choice.
- Notifications for upcoming matches (a separate feature).
- Match listing in workspace overview or activities.
- Disk persistence of fetched scoreboards.
- Cross-extension DBus interface for the data.

### Open considerations / risks

- **GNOME 51 redesign risk.** If GNOME 51 (autumn 2026) restructures
  `dateMenu` substantially, the panel may need rework. Probability:
  medium. Impact: blocks support on the new shell version until
  updated.
- **Timezone normalization.** ESPN's `/scoreboard?dates=YYYYMMDD`
  parameter uses UTC; the user's "today" in their local timezone may
  span two UTC dates. The fetch layer must normalize using the
  user's local date, not UTC. Easy to get wrong, easy to forget;
  cover with a dedicated test fixture.
- **EGO reviewer concerns.** extensions.gnome.org discourages
  modifying shell internals. The integration here is a controlled
  append into an existing message-list section, not a monkey-patch
  of shell behaviour, but reviewers may ask for justification.
  Document the integration approach in the submission notes.
- **Poller / panel data race for "today".** Today's data must flow
  from the poller to the panel without re-fetch; the poller does not
  currently expose a queryable snapshot. v2.0.0 will need to
  introduce a small read-only accessor on the poller.

### Pending design details (to settle during implementation)

- Order of matches within a day: by kickoff time only, or live-first
  then by time?
- Whether to show crest icons in rows (already loaded by the catalog
  layer), and the layout cost in a narrow popup.
- Behaviour while the popup is open across midnight — does the panel
  auto-rotate to the new "today", or stay on the date the user last
  selected?
- New translatable strings (at minimum: three empty-state messages
  and the section header) must land in all existing locales.
