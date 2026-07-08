# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell 45–50 extension (modern ESM/GJS) that shows Claude Pro usage in the
top bar: a panel button with the current-session percentage, and a menu listing
every active limit (session, weekly all-models, per-model like Fable) with reset
times, plus Refresh and Settings buttons.

## Commands

```sh
# Unit tests — pure logic, offline, uses test/sample-usage.json fixture
gjs -m test/usageModel-test.js

# Live end-to-end — reads the real token and hits the API (200 path)
gjs -m test/live-fetch.js

# Syntax check without the Shell (shell-resource imports won't resolve, but
# catches typos). node only checks syntax, it does not run the code.
node --check extension.js

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
For live-session bugs the real evidence is `journalctl --user -b 0 | grep -i claude`.

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
`refresh-interval` (int seconds, default 300) and `credentials-path` (string, empty
= default). Editing `schemas/*.gschema.xml` requires re-running
`glib-compile-schemas schemas/`. A short interval trips the API's 429 rate limit,
so polling now backs off exponentially on 429 (`backoffDelay` in `usageModel.js`,
honoring a `Retry-After` header) via the self-rescheduling timer in `extension.js`,
resetting to the base interval on the next successful poll.
