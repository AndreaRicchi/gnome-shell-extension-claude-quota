// Pure data-transformation helpers: raw /api/oauth/usage JSON -> normalized
// rows for the UI. Deliberately free of GNOME Shell imports so it can be
// exercised with plain `gjs` in tests. Only GLib (date math) is used.

import GLib from 'gi://GLib';

/**
 * Classify an HTTP status code into a fetch outcome reason.
 * Kept pure (plain number in, string out) so it is testable without a live
 * server. Note: read the code from `msg.status_code` (a guint), NOT
 * `msg.get_status()`, whose SoupStatus-enum marshalling throws on codes it
 * doesn't know (e.g. 429).
 * @param {number} status
 * @returns {'ok'|'expired'|'rate-limited'|string} 'http-<code>' for other errors
 */
export function classifyStatus(status) {
    if (status >= 200 && status < 300)
        return 'ok';
    if (status === 401 || status === 403)
        return 'expired';
    if (status === 429)
        return 'rate-limited';
    return `http-${status}`;
}

/**
 * Human-readable label for a limit entry.
 * @param {object} limit one element of the API `limits[]` array
 */
export function labelForLimit(limit) {
    switch (limit.kind) {
    case 'session':
        return 'Current session';
    case 'weekly_all':
        return 'Weekly · All models';
    case 'weekly_scoped': {
        const name = limit.scope?.model?.display_name;
        return name ? `Weekly · ${name}` : 'Weekly · Scoped';
    }
    default:
        // Title-case an unknown kind, e.g. "some_new_kind" -> "Some New Kind".
        return String(limit.kind || 'Limit')
            .split('_')
            .map(w => w ? w[0].toUpperCase() + w.slice(1) : w)
            .join(' ');
    }
}

/**
 * Normalize the raw API response into rows + the panel percentage.
 * @param {object} json parsed response body
 * @returns {{rows: Array, sessionPercent: (number|null), status: string}}
 */
export function parseUsage(json) {
    const limits = Array.isArray(json?.limits) ? json.limits : [];
    const rows = limits.map((l, i) => ({
        id: `${l.kind}:${l.scope?.model?.id ?? l.scope?.model?.display_name ?? i}`,
        label: labelForLimit(l),
        group: l.group ?? 'other',
        percent: Math.round(Number(l.percent) || 0),
        resetsAt: l.resets_at ?? null,
        severity: l.severity ?? 'normal',
    }));

    const session = rows.find(r => r.group === 'session');
    const weeklyAll = rows.find(r => r.id.startsWith('weekly_all'));
    const sessionPercent = session
        ? session.percent
        : (weeklyAll ? weeklyAll.percent : null);

    return { rows, sessionPercent, status: 'ok' };
}

/**
 * Next poll delay (seconds) given the base interval and consecutive 429 count.
 * Doubles the interval per consecutive rate-limit, never below a Retry-After
 * hint, and clamped to `maxSeconds`. Kept pure so it is unit-testable.
 * @param {number} baseSeconds  configured refresh-interval
 * @param {number} level        consecutive rate-limit count (0 = normal)
 * @param {number} [retryAfter] seconds from a Retry-After header, if any
 * @param {number} [maxSeconds] hard cap (default 1800 = 30 min)
 * @returns {number} seconds until the next poll
 */
export function backoffDelay(baseSeconds, level, retryAfter = 0, maxSeconds = 1800) {
    const base = Math.max(1, baseSeconds);
    let delay = base * Math.pow(2, Math.max(0, level));
    if (retryAfter > 0)
        delay = Math.max(delay, retryAfter);
    return Math.min(delay, maxSeconds);
}

/**
 * Format a reset timestamp relative to `now`.
 * @param {string} iso ISO-8601 timestamp (e.g. "2026-07-08T11:39:59+00:00")
 * @param {GLib.DateTime} [now] defaults to current local time
 * @returns {string} e.g. "Reset in 8h", "Reset in 42m", "Reset on Wed"
 */
export function formatReset(iso, now = GLib.DateTime.new_now_local()) {
    if (!iso)
        return '';

    const target = GLib.DateTime.new_from_iso8601(iso, null);
    if (!target)
        return '';

    const local = target.to_local();
    const diffSeconds = Math.floor(
        (local.to_unix() - now.to_unix())
    );

    if (diffSeconds <= 0)
        return 'Resetting…';
    if (diffSeconds < 3600)
        return `Reset in ${Math.max(1, Math.round(diffSeconds / 60))}m`;
    if (diffSeconds < 86400)
        return `Reset in ${Math.round(diffSeconds / 3600)}h`;
    // More than a day out: name the weekday it resets on.
    return `Reset on ${local.format('%a')}`;
}
