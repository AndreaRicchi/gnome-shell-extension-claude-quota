// Claude Quota — GNOME Shell panel indicator for Claude Pro usage.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {UsageClient} from './usageClient.js';
import {parseUsage, formatReset, backoffDelay} from './usageModel.js';

// Human-friendly text for each non-ok fetch reason.
const REASON_TEXT = {
    'no-file': 'Not logged in — open Claude Code',
    'bad-file': 'Could not read credentials file',
    'no-token': 'No token found — open Claude Code',
    'expired': 'Token expired — open Claude Code to refresh',
    'network': 'Network error — retrying',
    'rate-limited': 'Rate limited — retrying',
    'parse': 'Server error — retrying',
    'callback': 'Server error — retrying',
};

// Reasons where the user must act and the stored data is meaningfully invalid,
// so we replace the display with an error message. Every *other* reason
// (rate-limited, network, parse, callback, http-5xx…) is a transient server-side
// hiccup: we keep showing the last valid values and note the error in the footer.
const ACTION_REQUIRED_REASONS = new Set([
    'no-file', 'bad-file', 'no-token', 'expired',
]);

// Any non-ok reason not in ACTION_REQUIRED_REASONS is treated as transient.
function isActionRequired(reason) {
    return ACTION_REQUIRED_REASONS.has(reason);
}

// Footer text for a reason; http-<code> errors read as a transient server error.
function reasonText(reason) {
    if (REASON_TEXT[reason])
        return REASON_TEXT[reason];
    if (typeof reason === 'string' && reason.startsWith('http-'))
        return 'Server error — retrying';
    return `Error: ${reason}`;
}

// Skip the auto-refresh fired on menu-open if we fetched more recently than this;
// re-polling the rolling-window /usage limiter on every menu open resets its
// window and prevents recovery. The explicit Refresh button is never debounced.
const MENU_REFRESH_DEBOUNCE_MS = 60000;

const ClaudeQuotaIndicator = GObject.registerClass(
class ClaudeQuotaIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Claude Quota');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._client = new UsageClient();
        this._cancellable = null;
        this._inFlight = false;
        this._timerId = 0;
        // Consecutive 429 count; grows the poll interval, reset on any success.
        this._backoffLevel = 0;
        // Last *good* icon state (null, 'warn', or 'error'); updated only on
        // success so a following transient error restores it rather than
        // clearing the state.
        this._iconState = null;
        // Last *good* rows, kept on screen through transient server-side errors.
        this._lastRows = null;
        // Monotonic ms of the last fetch attempt; used to debounce menu-open.
        this._lastFetchMs = 0;

        // --- Panel: a single Claude icon whose whole glyph conveys status.
        // The icon is swapped between three variants (normal / warning / error)
        // rather than overlaying a corner badge.
        this._icons = {
            normal: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-ai-icon.svg`),
            warn: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-ai-icon-warning.svg`),
            error: Gio.icon_new_for_string(
                `${extension.path}/icons/claude-ai-icon-error.svg`),
        };
        this._icon = new St.Icon({
            gicon: this._icons.normal,
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        // --- Menu: dynamic rows + footer ---
        this._rowsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._rowsSection);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildFooter();

        // Refresh when the menu is opened, but debounce so repeatedly opening the
        // menu to check status doesn't keep re-poking the rate-limit window.
        this._menuStateId = this.menu.connect('open-state-changed', (_m, open) => {
            if (!open)
                return;
            const nowMs = GLib.get_monotonic_time() / 1000;
            if (this._lastFetchMs === 0 ||
                nowMs - this._lastFetchMs > MENU_REFRESH_DEBOUNCE_MS)
                this._refresh();
        });

        // React to interval changes from preferences: reset backoff and re-arm
        // at the new base interval.
        this._settingsChangedId = this._settings.connect(
            'changed::refresh-interval', () => {
                this._backoffLevel = 0;
                this._scheduleNext(this._baseInterval());
            });

        this._setPlaceholder('Loading…');
        // The initial refresh schedules the following tick itself.
        this._refresh();
    }

    _buildFooter() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        this._statusLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-quota-status',
            x_expand: true,
        });

        const refreshBtn = this._makeIconButton(
            'view-refresh-symbolic', 'Refresh', () => this._refresh());
        const settingsBtn = this._makeIconButton(
            'emblem-system-symbolic', 'Settings', () => {
                this.menu.close();
                this._extension.openPreferences();
            });

        item.add_child(this._statusLabel);
        item.add_child(refreshBtn);
        item.add_child(settingsBtn);
        this.menu.addMenuItem(item);
    }

    _makeIconButton(iconName, accessibleName, onClick) {
        const btn = new St.Button({
            style_class: 'claude-quota-footer-button',
            child: new St.Icon({icon_name: iconName, icon_size: 16}),
            can_focus: true,
        });
        btn.set_accessible_name(accessibleName);
        btn.connect('clicked', onClick);
        return btn;
    }

    _baseInterval() {
        return Math.max(10, this._settings.get_int('refresh-interval'));
    }

    // Arm a single next poll. Self-rescheduling (from _refresh) rather than a
    // repeating timer, so each delay can reflect the last outcome (backoff).
    _scheduleNext(delaySeconds) {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, delaySeconds, () => {
                this._timerId = 0;
                this._refresh();
                return GLib.SOURCE_REMOVE;
            });
    }

    async _refresh() {
        if (this._inFlight)
            return;
        this._inFlight = true;
        this._lastFetchMs = GLib.get_monotonic_time() / 1000;

        this._cancellable = new Gio.Cancellable();
        const path = this._settings.get_string('credentials-path');

        try {
            let result;
            try {
                result = await this._client.fetchUsage(path, this._cancellable);
            } catch (_e) {
                result = {ok: false, reason: 'network'};
            }
            if (result.reason === 'cancelled')
                return;
            this._render(result);

            // Arm the next poll, backing off while rate-limited.
            if (result.reason === 'rate-limited')
                this._backoffLevel = Math.min(this._backoffLevel + 1, 6);
            else
                this._backoffLevel = 0;
            // Cap backoff at 10 min so the panel recovers reasonably soon after
            // the rate-limit window lifts (a manual Refresh recovers instantly).
            this._scheduleNext(
                backoffDelay(this._baseInterval(), this._backoffLevel,
                    result.retryAfter, 600));
        } finally {
            // Always clear the guard, even if _render throws, so a single
            // failure can never permanently wedge future refreshes.
            this._inFlight = false;
        }
    }

    // Swap the panel icon. state ∈ {null, 'warn', 'error'}; null → normal.
    _applyIcon(state) {
        this._icon.gicon = this._icons[state ?? 'normal'] ?? this._icons.normal;
    }

    _render(result) {
        if (result.ok) {
            const model = parseUsage(result.json);
            const p = model.sessionPercent;
            let state = null;
            if (p !== null) {
                if (p > 99)
                    state = 'error';
                else if (p > 75)
                    state = 'warn';
            }
            this._iconState = state;
            this._lastRows = model.rows;
            this._applyIcon(this._iconState);
            this._renderRows(model.rows);
            this._statusLabel.set_text(
                `Updated ${GLib.DateTime.new_now_local().format('%H:%M')}`);
            return;
        }

        const msg = reasonText(result.reason);

        // Credential/auth errors: the data is invalid and the user must act, so
        // replace the display with the error message.
        if (isActionRequired(result.reason)) {
            this._applyIcon('error');
            this._setMessageRow(msg);
            this._statusLabel.set_text('');
            return;
        }

        // Transient server-side error: keep showing the last valid values (and the
        // last good icon), noting the error in the footer. Fall back to a message
        // row only when we have no good data yet (first load already failing).
        this._applyIcon(this._iconState);
        if (this._lastRows?.length) {
            this._renderRows(this._lastRows);
            this._statusLabel.set_text(msg);
        } else {
            this._setMessageRow(msg);
            this._statusLabel.set_text('');
        }
    }

    _renderRows(rows) {
        this._rowsSection.removeAll();
        if (!rows.length) {
            this._setMessageRow('No usage data available');
            return;
        }
        for (const row of rows)
            this._rowsSection.addMenuItem(this._makeRow(row));
    }

    _makeRow(row) {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });

        const vbox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'claude-quota-row',
        });

        const top = new St.BoxLayout({x_expand: true});
        top.add_child(new St.Label({
            text: row.label,
            x_expand: true,
            style_class: 'claude-quota-row-label',
        }));
        const pct = new St.Label({
            text: `${row.percent}%`,
            style_class: 'claude-quota-row-percent',
        });
        if (row.percent >= 90)
            pct.add_style_class_name('claude-quota-high');
        top.add_child(pct);

        vbox.add_child(top);
        vbox.add_child(new St.Label({
            text: formatReset(row.resetsAt),
            style_class: 'claude-quota-row-reset',
        }));

        item.add_child(vbox);
        return item;
    }

    _setMessageRow(text) {
        this._rowsSection.removeAll();
        const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
        this._rowsSection.addMenuItem(item);
    }

    _setPlaceholder(text) {
        this._setMessageRow(text);
    }

    destroy() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._menuStateId) {
            this.menu.disconnect(this._menuStateId);
            this._menuStateId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        this._client?.destroy();
        this._client = null;
        this._settings = null;
        super.destroy();
    }
});

export default class ClaudeQuotaExtension extends Extension {
    enable() {
        this._indicator = new ClaudeQuotaIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
