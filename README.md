# Claude Quota — GNOME Shell extension

Track your Claude Pro usage from the GNOME top bar.

- A panel button shows the Claude icon plus your **current session** usage percentage.
- Clicking it opens a menu listing every active limit — session, weekly (all models), and per-model (e.g. Fable) — each with its percentage and reset time.
- Footer buttons: **Refresh** and **Settings**.

It reads the OAuth token that Claude Code already stores in
`~/.claude/.credentials.json` and calls the same `GET /api/oauth/usage`
endpoint that Claude Code's `/usage` command uses. Nothing is sent anywhere
except Anthropic's API.

> The token is only refreshed by Claude Code itself. If it expires, the panel
> shows a "Token expired" hint until you next use Claude Code.

## Requirements

- GNOME Shell 45–50
- libsoup 3 (ships with modern GNOME)
- An active Claude Pro/Max login in Claude Code

## Install (development)

```sh
UUID=claude-quota@andrearicchi.com
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
ln -s "$PWD" "$DEST"                 # or copy the folder
glib-compile-schemas "$DEST/schemas/"
gnome-extensions enable "$UUID"
```

Then reload GNOME Shell:

- **X11:** <kbd>Alt</kbd>+<kbd>F2</kbd>, type `r`, <kbd>Enter</kbd>
- **Wayland:** log out and back in, or test in a nested session (below)

## Test in a nested session (no logout, safe)

```sh
dbus-run-session -- gnome-shell --nested --wayland
# in the nested shell:
gnome-extensions enable claude-quota@andrearicchi.com
```

## Run the tests

```sh
gjs -m test/usageModel-test.js   # pure logic (offline, uses captured fixture)
gjs -m test/live-fetch.js        # live end-to-end against your account
```

## Settings

- **Refresh interval** — seconds between polls (default 300; also refreshes on menu open and manual refresh). On an HTTP 429 the interval backs off exponentially and resets on the next successful poll.
- **Credentials path** — override the default `~/.claude/.credentials.json`.

## Notes / roadmap

Out of scope for v1: automatic token refresh, desktop notifications,
historical charts, multi-account. The `icons/claude-ai-icon.svg` mark is a
placeholder.
