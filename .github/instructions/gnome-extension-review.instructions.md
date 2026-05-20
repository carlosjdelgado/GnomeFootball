---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Copilot code review — GNOME extension review guidelines

Review this PR for a GNOME Shell extension destined for extensions.gnome.org
**only** against the EGO review guidelines below
(https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Scope

- Comment only on violations of the rules below, and cite the category. No
  generic style, naming, formatting, or preference feedback.
- If the diff is clean, say so; do not invent issues.
- "Recommendations" are non-blocking notes.

## Lifecycle

- Module/constructor init: only static resources (`Map`, `RegExp`, plain data).
  No object creation, signal connects, main-loop sources, or Shell changes there.
- Do all setup in `enable()`, all teardown in `disable()`.

## disable() cleanup

- Destroy objects from `enable()`; disconnect every signal by stored ID; remove
  every main-loop source (even self-returning `GLib.SOURCE_REMOVE`); clear
  module-scope data (`Map.clear()`) and null references.

## Imports

- `extension.js` must not import `Gtk`, `Gdk`, `Adw`.
- `prefs.js` must not import `Clutter`, `Meta`, `St`, `Shell`.
- No deprecated `ByteArray`, `Lang`, `Mainloop`.

## Code quality

- No minified/obfuscated/unreadable code; no excessive `console`/`log`; prefer
  ES6 classes and async/await.

## GObject

- No `GObject.Object.run_dispose()` without a comment justifying it.

## Session modes

- Running in `unlock-dialog` must be justified, must disconnect keyboard-event
  signals in that mode, and `disable()` must explain why. No selective disabling.

## Subprocesses & external code

- Privileged subprocesses use `pkexec`, not user-writable; avoid if possible.
- No bundled binaries/libraries. Non-GJS scripts only if necessary, must exit
  cleanly, OSI-approved license. External installs (pip/npm/yarn) need explicit
  user action.

## GSettings

- Schema ID under `org.gnome.shell.extensions`, path under
  `/org/gnome/shell/extensions`; ship the `<schema-id>.gschema.xml` source.

## metadata.json

- UUID `id@namespace` (alphanumerics/`.`/`_`/`-`), namespace not `gnome.org`.
- `shell-version`: stable releases only (plus <=1 dev release). `url` to
  GitHub/GitLab.
- Drop `session-modes` if only `user`; drop unused `donations`.

## Privacy

- No telemetry, tracking, or sending data online. Clipboard access must be
  declared in the description, not shared with third parties without user action,
  no default shortcuts.

## Legal

- GPL-2.0-or-later-compatible license; attribute reused extension code. No
  unlicensed copyrighted/trademarked assets; no political agendas; follow the CoC.

## Recommendations (non-blocking)

- Exclude build scripts, `.po`/`.pot`, and unused media from the ZIP. Follow the
  GNOME HIG for UI.
