# Roadmap

This file collects forward-looking design decisions for upcoming versions
of Gnome Football. A version's section here freezes the *what* and *why*
before implementation begins; the *what shipped* lives in
[`CHANGELOG.md`](CHANGELOG.md) once released.

The roadmap is intentionally not linked from the `README` — it is
working notes for the maintainer, not user-facing material.

## v2.0.0 — Calendar integration, anticipation, and noise control

### Vision

v2.0.0 evolves Gnome Football from a background notifier into a
calendar-integrated football companion. Three coordinated additions:

1. **A date-aware match panel inside the GNOME calendar popup** —
   a passive surface to *consult* what's happening today, what
   happened yesterday, what's coming tomorrow.
2. **Pre-match reminders** — a proactive nudge before a subscribed
   match kicks off. Closes the loop with the panel.
3. **Per-match mute** — a fine-grained noise control surfaced
   directly from each match notification.

This is a deliberate shift from the v1.x identity ("invisible until a
notification fires"). v2.0.0 keeps notifications as the primary
interaction, but adds a passive surface to *consult* and a small set
of controls to *shape* the experience.

---

## Feature 1 — Calendar-integrated match panel

The user clicks a day in the calendar popup; the matches for that day
appear in the same popup. No new panel icon, no new app — the calendar
simply knows about football.

### D1 — Location: DateMenu (calendar popup)

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

### D2 — Date-aware, not today-only

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

### D3 — Date range: unlimited

Any date the user can navigate to in GNOME's calendar widget is
fetched on demand. No artificial caps. If ESPN has no data for a
date, the empty-state copy fires. Old finals and far-future fixtures
are both fair game.

### D4 — Cache: in-memory only, rebuilt per session

Past dates are cached in memory until the shell session ends. No new
files on disk, no purge logic, no invalidation rules. The cost is a
re-fetch of recently viewed dates after each login, which is
negligible for a feature browsed occasionally.

The existing `live-state.json` is **not** extended for this; it stays
focused on per-event diffing for notifications.

### D5 — Filter: subscriptions only

The panel shows the same matches the user would receive notifications
for: subscribed competitions, filtered by team selection when
`mode === "teams"`. No "show all" toggle, no exception list. Coherent
with the notification model — if a match would not generate a
notification, it does not appear in the panel either.

### D6 — Rows are informational, with one accessory control

The body of a row is not a link: clicking on teams, score, or status
does nothing. Rationale:

- Clicking to open ESPN duplicates an action already available on
  notifications.
- Inline expansion (goalscorers, cards, minute-by-minute) is
  significantly more work and pushes the extension toward being
  "an app".

The row does, however, carry **one accessory control**: a small
mute/un-mute icon at the right edge (see Feature 3 / D13). This is
the *only* interactive affordance on a row; everything else stays
read-only.

### D7 — Configuration for the panel: a single toggle

One new GSetting, `show-today-panel` (boolean, default `true`). Users
who do not want the panel disable it. Everything else (filter,
ordering, layout) is opinionated and not exposed.

Rejected alternatives: ordering options, density toggles,
crest-on/off — each one is a UI surface to maintain for marginal
user value.

### D8 — Empty state is visible, not hidden

When no matches match the current selection, the section still shows
a one-line empty-state message. Hiding the section entirely was
rejected because it would make the feature undiscoverable: a user
who just installed the extension would not see anything in the
calendar on an idle Tuesday.

---

## Feature 2 — Pre-match reminders

A single configurable notification fires N minutes before the kickoff
of each subscribed match. Pairs with Feature 1: the panel shows what's
coming, the reminder pokes when one is about to start.

### D9 — Single configurable lead time, off by default

One new GSetting, `pre-match-reminder-minutes` (integer, range 0–60,
default `0`). A value of `0` disables the feature; any positive value
schedules a reminder that many minutes before kickoff.

**Why one lead time, not multiple:** offering "remind me at 30, 10
and 5 minutes" multiplies prefs surface and notification noise for
marginal value. A single configurable lead suits the vast majority
of users; power users can pick 10 or 15 and that's the right answer
for them.

**Why default off:** behaviour-changing feature that fires
notifications a user did not previously receive. Existing users
opt in deliberately; first-time installers can flip it during
onboarding.

### D10 — One reminder per match, idempotent

Each match generates exactly one pre-match reminder. The detector
records a `preMatchReminderSent` flag per `matchId` in `liveState`,
flushed when the match transitions to `post`. Re-launching the
extension, changing the lead time mid-day, or a missed poll cycle
must never produce a duplicate reminder.

### D11 — Reuses existing subscription filter, no new toggle

A reminder fires only for matches that pass the same subscription
filter as live notifications: subscribed league, plus team filter
when `mode === "teams"`. No per-event toggle ("only remind for these
events"); the reminder is a *match-level* event, not a play-level
event, and shares the league/team gating already in place.

---

## Feature 3 — Per-match mute

Each match notification carries a "Mute match" action button. Tapping
it suppresses any further notifications for that match until full-time,
when the mute auto-expires.

### D12 — Mute action button on every match notification

Every notification fired for a play-level event (goal, card, kickoff,
half-time, etc.) carries a single action button labelled "Mute match"
(localised in all supported locales).

**Layout:** the button sits in the action area at the bottom of the
notification card. The notification body remains clickable as today
(opens the ESPN match page); the button is a separate hit target. No
ambiguity between "I want to read more" and "I want to silence this".

**Effect on press:** adds `matchId` to `liveState.mutedMatches`, then
dismisses the current notification card. No further notifications
fire for that match from that moment until full-time.

### D13 — Un-mute via the panel row's accessory icon

The mute toggle on a panel row (D6's accessory control) is the only
manual un-mute affordance. The icon reflects current state:

- Bell icon → match is active, click to mute.
- Bell-slash icon → match is muted, click to un-mute.

**Trade-off accepted:** users with `show-today-panel = false` cannot
manually un-mute. Their mutes simply auto-expire at full-time (see
D14). Adding a "muted matches" page to prefs was considered and
rejected as bureaucratic for a secondary feature.

### D14 — Auto-expire at full-time, no persistence across sessions

`mutedMatches` lives in `liveState.json` alongside other per-match
state. Entries are pruned when the match transitions to `post`, in
the same pass that prunes finished-match data 6 hours post-FT. A
shell logout/login during a match preserves the mute (it's on disk);
a mute set on a Tuesday match is gone by Wednesday morning.

No GSetting, no UI to view past mutes — it's strictly transient
runtime state. If a user wants to silence a whole league
permanently, they unsubscribe.

---

## Out of scope for v2.0.0

- Inline expansion of a match row (goalscorers / cards inline).
- Configurable ordering, density, or column choice for panel rows.
- Disk persistence of fetched scoreboards.
- Cross-extension DBus interface for the data.
- Multiple pre-match reminders at different lead times.
- Per-event-type mute ("mute goals only, keep cards").
- Workspace overview / activities integration.
- Inline match commentary / play-by-play stream.
- Notification grouping by match (relying on GNOME's natural
  stacking for now).

## Open considerations / risks

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
- **Pre-match reminder timing accuracy.** The reminder fires from a
  polling tick, so its real precision is bounded by
  `poll-interval-minutes`. With the default 5-minute poll, a
  reminder set for "10 minutes before" can land anywhere between 5
  and 10 minutes before kickoff. Acceptable, but document it in the
  prefs hint text.
- **Action-button compatibility across shell versions.** Action
  buttons on `MessageTray.Notification` are stable on 47–50, but the
  exact rendering (button position, label truncation) varies.
  Validate on all three supported shell versions.

## Pending design details (to settle during implementation)

- Order of matches within a day in the panel: by kickoff time only,
  or live-first then by time?
- Whether to show crest icons in panel rows (already loaded by the
  catalog layer), and the layout cost in a narrow popup.
- Behaviour while the popup is open across midnight — does the panel
  auto-rotate to the new "today", or stay on the date the user last
  selected?
- Exact lead-time choices exposed in prefs: free integer, or a
  curated set (5/10/15/30 min)?
- Whether the pre-match reminder's notification body should include
  the kickoff time, the lead-time, or both ("Kicks off in 10 minutes
  (20:00)").
- New translatable strings (panel headers, three empty-state
  messages, "Mute match" button label, pre-match body) must land in
  all existing locales.

---

## v2.1.0+ candidates (not committed)

Recorded here so v2.0.0 isn't padded with them. Revisit after v2.0.0
ships and adoption / bug reports settle.

- **GNOME Search Provider.** Type "barça" or "champions" in
  Activities Overview to surface upcoming matches from your
  subscriptions. Strong "feels like part of the shell" angle.
  Deferred from v2.0.0 because it adds a DBus service and search
  manifest, separate from the DateMenu integration work.
- **Women's football catalog.** WSL, Liga F, NWSL, UEFA Women's
  Champions League. ESPN exposes these; same shape of work as the
  v1.1.0 Americas expansion — a minor release on its own.
- **Additional federations.** CAF (CAF Champions League, AFCON), AFC
  (Saudi Pro League, AFC Champions League, Asian Cup). Catalog
  growth, not architectural.
- **Inline panel row expansion.** Expand a row to show goalscorers,
  cards and current state without leaving the calendar popup.
  Significant UI work; revisit if users actually ask for it.
- **GNOME Calendar / Evolution event injection.** Push subscribed
  fixtures as calendar events into a dedicated "Football fixtures"
  calendar collection. Most "native" integration possible, but high
  UX risk (polluting personal calendars); needs careful scoping.
