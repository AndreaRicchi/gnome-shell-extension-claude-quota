# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell 45–51 extension (modern ESM/GJS) that shows Claude Pro usage in the
top bar: a panel button with a status icon (normal/warn/error variants driven by
the session percentage) and, when the `show-panel-percentages` setting is on,
compact per-limit percentages next to it ("S 15% · W 28% · F 26%"), plus a menu
listing every active limit (session, weekly all-models, per-model like Fable)
with reset times, and Refresh and Settings buttons.

## Commands

```sh
# Unit tests — pure logic, offline, uses test/sample-usage.json fixture
gjs -m test/usageModel-test.js

# Live end-to-end — reads the real token and hits the API (200 path)
gjs -m test/live-fetch.js

# Syntax check without the Shell. node is not installed on this machine; gjs
# parses the file, so a SyntaxError is a real error, while an ImportError on
# resource:///…shell… means the parse succeeded (expected for extension.js).
gjs -m extension.js

# Marketplace linter (CI gates every push/PR and release on this — see
# .github/workflows/shexli.yml). The tree-sitter pin is required: 0.26 segfaults.
# shexli always exits 0; CI counts `--format json` findings, minus the EGO-M-004
# false positive on shell-version 51, to fail.
pip install -U shexli 'tree-sitter<0.26'
shexli dist/*.shell-extension.zip

# Install for development (symlink so edits are live) + compile settings schema
UUID=claude-quota@andrearicchi.com
ln -s "$PWD" "$HOME/.local/share/gnome-shell/extensions/$UUID"
glib-compile-schemas schemas/     # required after editing the gschema.xml
```

There is no build step and no test framework — `test/usageModel-test.js` is a
plain gjs script that `print`s `ok`/`FAIL` lines and exits non-zero on failure.

## Verifying runtime behaviour (important GNOME 50 gotcha)

You cannot reload a running Wayland shell without logging out. To exercise the
extension in a real Shell without touching the user's session, launch a throwaway
one. **The README's `gnome-shell --nested --wayland` is wrong for GNOME 50** —
`--nested` was removed. Use `--devkit` instead:

```sh
dbus-run-session -- bash -c '
  gnome-shell --devkit >/tmp/shell.log 2>&1 &
  sleep 8
  gnome-extensions enable claude-quota@andrearicchi.com
  sleep 5
  gnome-extensions info claude-quota@andrearicchi.com   # look for State: ACTIVE
'
```

`State: ACTIVE` only proves `enable()` didn't throw — async errors (in a refresh
or `_render`) surface later. Always also `grep -i "JS ERROR\|claude" /tmp/shell.log`.
Repeated `JS ERROR: TypeError: can't access property "height", _monitor is null`
lines are headless-devkit noise: they appear before any extension is enabled, so
do not attribute them to this code. For live-session bugs the real evidence is
`journalctl --user -b 0 | grep -i claude`.

Before any runtime check, confirm the install path is still the symlink into the
repo: an install from EGO replaces it with a plain directory, and the devkit
session then runs stale code while the repo edits look ignored. Re-link before
testing.

## README audience

The README is for end users, styled after kem-a/kiwi-menu: icon in the H1, a
shields.io badge row, screenshots inline. The EGO marketplace install comes first
and is the recommended one; there are no release-zip install steps, one terse
Contributing section (symlink install + tests) and no Releasing section.
Maintainer workflows — pack, shexli, tagging, EGO upload — live in this file
only. EGO badge links keep the `XXXX` placeholder id in HTML comments until the
marketplace listing is approved.

## Architecture

Three source modules with a deliberate dependency direction, so the hard-to-test
Shell UI stays thin and the logic stays unit-testable:

- **`usageModel.js`** — pure functions, no Shell imports (only `gi://GLib` for
  date math). `parseUsage(json)` normalizes the API's `limits[]` array into rows +
  the panel percentage; `classifyStatus(status)` maps an HTTP code to a reason;
  `formatReset(iso)` renders "Reset in 8h" / "Reset on Wed". This is the only file
  the tests import, and everything here runs under plain `gjs`.
- **`usageClient.js`** — networking + credentials, isolated so failure modes are
  explicit. `readCredentials()` loads the token; `UsageClient.fetchUsage()` calls
  the endpoint via libsoup 3 and returns `{ok, json}` or `{ok:false, reason}`.
- **`extension.js`** — the only file that touches Shell APIs (`PanelMenu.Button`,
  `PopupMenu`, `St`). Owns the panel widget, the poll timer, and rendering.

`extension.js → usageClient.js → usageModel.js`. Never import `resource:///…shell…`
into the client/model modules or you break the tests.

### Data source

`GET https://api.anthropic.com/api/oauth/usage` with headers `Authorization:
Bearer <token>`, `anthropic-beta: oauth-2025-04-20`, `Content-Type:
application/json`. This is the same endpoint Claude Code's `/usage` uses. The
token is read (never refreshed) from `~/.claude/.credentials.json`
(`claudeAiOauth.accessToken` / `expiresAt`); Claude Code refreshes it on its own
use, so an expired token shows a "Token expired" state rather than being renewed
here. The response's `limits[]` array (`kind` = `session` / `weekly_all` /
`weekly_scoped`, each with `percent`, `resets_at`, and optional `scope.model`) is
the source of truth — the menu renders it dynamically, so new limit kinds appear
automatically.

### Async invariants (these are load-bearing — a past hang came from breaking them)

- **Read HTTP status via `msg.status_code` (a guint), never `msg.get_status()`.**
  The latter marshals into the `SoupStatus` enum and *throws* on codes not in it
  (notably 429), which previously killed the async callback and wedged the UI.
- **`fetchUsage`'s Promise must always settle** — its whole `send_and_read_async`
  callback is wrapped so any throw still `resolve()`s. In `extension.js`, the
  `_inFlight` guard is cleared in a `try/finally`. If either guarantee is removed,
  a single transient error permanently freezes refreshes (panel stuck at `…`).

## Settings

GSettings schema `org.gnome.shell.extensions.claude-quota`:
`refresh-interval` (int seconds, default 300), `credentials-path` (string, empty
= default), `show-panel-percentages` (bool, default false — shows
`formatPanelText`'s compact per-limit string next to the panel icon), and
`show-pace` (bool, default true — `paceForRow` adds "expected N%" to each menu
row and colours limits 10+ points ahead yellow, in the menu via CSS and in the
panel label via `formatPanelMarkup`). The API gives no window start or length,
so `WINDOW_SECONDS` in `usageModel.js` hardcodes them per kind; a new kind gets
no pace until it is added there. Pace is computed at render time, never stored
in rows, because `_lastRows` is re-rendered through transient errors.
Editing `schemas/*.gschema.xml` requires re-running
`glib-compile-schemas schemas/`. A short interval trips the API's 429 rate limit,
so polling now backs off exponentially on 429 (`backoffDelay` in `usageModel.js`,
honoring a `Retry-After` header) via the self-rescheduling timer in `extension.js`,
resetting to the base interval on the next successful poll.
