// Networking + credential access for the Claude usage endpoint.
// Isolated from GNOME Shell UI so its failure modes are explicit and testable.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {classifyStatus} from './usageModel.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

/** Default path to Claude Code's stored OAuth credentials. */
export function defaultCredentialsPath() {
    return GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
}

/**
 * Read the OAuth access token from the credentials file.
 * Uses async IO so the compositor is never blocked on disk (EGO-X-004).
 * @param {string} [path] override; empty/undefined -> default path
 * @returns {Promise<{ok: boolean, token?: string, expiresAt?: number, reason?: string}>}
 */
export function readCredentials(path) {
    const file = Gio.File.new_for_path(
        path && path.length ? path : defaultCredentialsPath()
    );

    // Always resolves (never rejects) so fetchUsage's settle guarantee holds.
    // No cancellable: this small local read matches the old sync semantics and
    // avoids a cancelled read masquerading as 'no-file'.
    return new Promise(resolve => {
        file.load_contents_async(null, (f, result) => {
            let contents;
            try {
                const [ok, bytes] = f.load_contents_finish(result);
                if (!ok) {
                    resolve({ ok: false, reason: 'no-file' });
                    return;
                }
                contents = new TextDecoder().decode(bytes);
            } catch (_e) {
                resolve({ ok: false, reason: 'no-file' });
                return;
            }

            let data;
            try {
                data = JSON.parse(contents);
            } catch (_e) {
                resolve({ ok: false, reason: 'bad-file' });
                return;
            }

            const oauth = data?.claudeAiOauth;
            const token = oauth?.accessToken;
            if (!token) {
                resolve({ ok: false, reason: 'no-token' });
                return;
            }

            resolve({ ok: true, token, expiresAt: Number(oauth.expiresAt) || 0 });
        });
    });
}

export class UsageClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.set_property('timeout', 15);
    }

    /**
     * Fetch and parse the usage JSON.
     * @param {string} credentialsPath
     * @param {Gio.Cancellable} cancellable
     * @returns {Promise<{ok: boolean, json?: object, reason?: string}>}
     */
    fetchUsage(credentialsPath, cancellable) {
        return new Promise(resolve => {
            // readCredentials never rejects, but guard anyway so the Promise
            // always settles even if the credential read throws unexpectedly.
            readCredentials(credentialsPath).then(cred => {
                this._sendUsageRequest(cred, cancellable, resolve);
            }).catch(() => resolve({ ok: false, reason: 'no-file' }));
        });
    }

    /** Issue the authenticated GET once credentials are loaded. */
    _sendUsageRequest(cred, cancellable, resolve) {
        if (!cred.ok) {
            resolve({ ok: false, reason: cred.reason });
            return;
        }
        // Expired tokens are refreshed by Claude Code itself; short-circuit
        // rather than making a call we know will 401.
        if (cred.expiresAt && cred.expiresAt < Date.now()) {
            resolve({ ok: false, reason: 'expired' });
            return;
        }

        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${cred.token}`);
        headers.append('anthropic-beta', OAUTH_BETA);
        headers.append('Content-Type', 'application/json');

        this._session.send_and_read_async(
            msg,
            GLib.PRIORITY_DEFAULT,
            cancellable ?? null,
            (session, result) => {
                // The whole body is wrapped so the Promise ALWAYS settles.
                // A throw here (e.g. an unexpected marshalling error) must
                // never leave the caller's in-flight guard stuck forever.
                try {
                    let bytes;
                    try {
                        bytes = session.send_and_read_finish(result);
                    } catch (e) {
                        if (e instanceof GLib.Error &&
                            e.matches(Gio.io_error_quark(),
                                Gio.IOErrorEnum.CANCELLED))
                            resolve({ ok: false, reason: 'cancelled' });
                        else
                            resolve({ ok: false, reason: 'network' });
                        return;
                    }

                    // Read the raw guint, not msg.get_status() — the enum
                    // getter throws on codes it doesn't know (e.g. 429).
                    const reason = classifyStatus(msg.status_code);
                    if (reason !== 'ok') {
                        const out = { ok: false, reason };
                        // Honor a numeric Retry-After on 429 so backoff never
                        // polls sooner than the server asks. HTTP-date form
                        // parses to NaN and is ignored (falls back to backoff).
                        if (reason === 'rate-limited') {
                            const ra = Number(msg.get_response_headers()
                                .get_one('retry-after'));
                            if (Number.isFinite(ra) && ra > 0)
                                out.retryAfter = ra;
                        }
                        resolve(out);
                        return;
                    }

                    try {
                        const text = new TextDecoder().decode(bytes.get_data());
                        resolve({ ok: true, json: JSON.parse(text) });
                    } catch (_e) {
                        resolve({ ok: false, reason: 'parse' });
                    }
                } catch (_e) {
                    resolve({ ok: false, reason: 'callback' });
                }
            }
        );
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
