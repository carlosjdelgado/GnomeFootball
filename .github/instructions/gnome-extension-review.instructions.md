---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Copilot code review — GNOME Shell extension review guidelines

You are reviewing a pull request for a GNOME Shell extension that will be
published on extensions.gnome.org (EGO). Review the changes **only** against the
official EGO review guidelines reproduced below
(source: https://gjs.guide/extensions/review-guidelines/review-guidelines.html).

## Scope rules (important)

- Comment **only** on violations of the guidelines in this document. Do not
  raise generic style, naming, formatting, micro-optimization, or
  personal-preference feedback that is not covered here.
- Cite the specific guideline category for every comment you make.
- If the diff has no guideline violations, say so explicitly and do not invent
  issues.
- Items under "Recommendations" are non-blocking notes, not failures.

## Initialization & lifecycle

- No object creation, signal connections, main-loop sources, or GNOME Shell
  modifications during module init or constructors. Only static resources are
  allowed at module scope (e.g. `Map`, `RegExp`, plain data).
- All such setup must happen in `enable()`; all teardown must happen in
  `disable()`.

## Cleanup in disable()

- Destroy every object created in `enable()`.
- Disconnect every signal handler via its stored handler ID.
- Remove every main-loop source (GLib timeouts/idle), even if the callback would
  eventually return `GLib.SOURCE_REMOVE`.
- Clear dynamic module-scope data (e.g. `Map.clear()`) and null out references.

## Imports

- `extension.js` (Shell process) must NOT import `Gtk`, `Gdk`, or `Adw`.
- `prefs.js` (preferences process) must NOT import `Clutter`, `Meta`, `St`, or
  `Shell`.
- Do not use deprecated modules: `ByteArray`, `Lang`, `Mainloop`.

## Code quality

- No minified, obfuscated, or otherwise unreadable code.
- No excessive `console`/`log` output.
- Prefer modern JavaScript (ES6 classes, `async`/`await`).

## GObject

- Do not call `GObject.Object.run_dispose()` without a comment explaining the
  real-world situation that requires it.

## Session modes

- If the extension keeps running in `unlock-dialog` mode, that necessity must be
  justified, all keyboard-event signals must be disconnected in that mode, and
  `disable()` must carry an explanatory comment.
- No selective disabling of extensions.

## Subprocesses & external code

- Privileged subprocesses must use `pkexec` and must not be user-writable; avoid
  them where possible.
- No bundled binary executables or libraries. Non-GJS scripts only when strictly
  necessary, must exit cleanly, and must use OSI-approved licenses.
- Installing external modules (pip/npm/yarn) requires explicit user action.

## GSettings schema

- Schema ID must be based on `org.gnome.shell.extensions`; schema path based on
  `/org/gnome/shell/extensions`.
- The `.gschema.xml` source must be shipped in the package; its filename must
  match `<schema-id>.gschema.xml`.

## metadata.json

- UUID matches `extension-id@namespace` (alphanumerics, `.`, `_`, `-` only);
  the namespace must not be `gnome.org`.
- `shell-version` lists only stable releases (plus at most one development
  release).
- `url` points to a GitHub or GitLab repository.
- Drop `session-modes` if only `user` mode is used; drop the `donations` field if
  unused.

## Privacy & telemetry

- No telemetry, user tracking, or sending data online.
- Clipboard access, if any, must be declared in the extension description, must
  not share data with third parties without explicit user interaction, and must
  not bind default keyboard shortcuts.

## Legal

- Licensing must be GPL-2.0-or-later compatible; attribute code reused from other
  extensions. No copyrighted or trademarked assets without permission. No
  political agendas. Must comply with the GNOME Code of Conduct.

## Recommendations (non-blocking notes only)

- Exclude build scripts, `.po`/`.pot` files, and unused media from the packaged
  ZIP.
- Follow the GNOME Human Interface Guidelines for any UI.
