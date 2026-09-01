#!/usr/bin/env gjs -m
// Pure-logic tests for usageModel.js. Run: gjs -m test/usageModel-test.js
// (from the extension root, or any dir — paths are resolved from this file).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {parseUsage, formatReset, labelForLimit, classifyStatus, backoffDelay,
    letterForRow, formatPanelText} from '../usageModel.js';

let failures = 0;
function check(name, cond) {
    const ok = !!cond;
    print(`${ok ? 'ok  ' : 'FAIL'} - ${name}`);
    if (!ok)
        failures++;
}
function eq(name, actual, expected) {
    check(`${name} (got ${JSON.stringify(actual)})`, actual === expected);
}

// --- Load the captured fixture next to this script ---
const thisDir = GLib.path_get_dirname(
    Gio.File.new_for_uri(import.meta.url).get_path());
const fixturePath = GLib.build_filenamev([thisDir, 'sample-usage.json']);
const [, bytes] = Gio.File.new_for_path(fixturePath).load_contents(null);
const sample = JSON.parse(new TextDecoder().decode(bytes));

// --- parseUsage against the real fixture ---
const model = parseUsage(sample);
check('has rows', model.rows.length >= 3);
check('sessionPercent is a number', typeof model.sessionPercent === 'number');

check('session labelled', model.rows.some(r => r.label === 'Current session'));
check('weekly-all labelled',
    model.rows.some(r => r.label === 'Weekly · All models'));
check('scoped label present',
    model.rows.some(r => r.label.startsWith('Weekly · ') &&
        r.label !== 'Weekly · All models'));

// --- labelForLimit unit cases ---
eq('session label', labelForLimit({kind: 'session'}), 'Current session');
eq('weekly_all label', labelForLimit({kind: 'weekly_all'}), 'Weekly · All models');
eq('scoped label',
    labelForLimit({kind: 'weekly_scoped', scope: {model: {display_name: 'Fable'}}}),
    'Weekly · Fable');
eq('unknown kind title-cased',
    labelForLimit({kind: 'some_new_kind'}), 'Some New Kind');

// --- classifyStatus: the regression that caused the stuck-loading hang ---
eq('200 -> ok', classifyStatus(200), 'ok');
eq('204 -> ok', classifyStatus(204), 'ok');
eq('401 -> expired', classifyStatus(401), 'expired');
eq('403 -> expired', classifyStatus(403), 'expired');
eq('429 -> rate-limited', classifyStatus(429), 'rate-limited');
eq('500 -> http-500', classifyStatus(500), 'http-500');

// --- empty / malformed input ---
eq('empty json -> no rows', parseUsage({}).rows.length, 0);
eq('empty json -> null session', parseUsage({}).sessionPercent, null);

// --- formatReset relative windows ---
const iso = s => GLib.DateTime.new_now_local().add_seconds(s).format_iso8601();
eq('8h out -> hours', formatReset(iso(8 * 3600 + 30), GLib.DateTime.new_now_local()),
    'Reset in 8h');
eq('42m out -> minutes', formatReset(iso(42 * 60 + 5), GLib.DateTime.new_now_local()),
    'Reset in 42m');
eq('past -> resetting', formatReset(iso(-100), GLib.DateTime.new_now_local()),
    'Resetting…');
eq('empty -> empty', formatReset(null), '');
check('3 days out -> weekday',
    /^Reset on \w{3}$/.test(
        formatReset(iso(3 * 86400), GLib.DateTime.new_now_local())));

// --- panel text: rows -> compact top-bar string ---
eq('rows carry kind', model.rows[0].kind, 'session');
eq('scoped row carries model name',
    model.rows.find(r => r.label === 'Weekly · Fable')?.modelName, 'Fable');
eq('session row has null model name',
    model.rows.find(r => r.kind === 'session')?.modelName, null);

eq('panel text from fixture', formatPanelText(model.rows), 'S 15% · W 28% · F 26%');

eq('session letter', letterForRow({kind: 'session'}), 'S');
eq('weekly_all letter', letterForRow({kind: 'weekly_all'}), 'W');
eq('scoped letter from model name',
    letterForRow({kind: 'weekly_scoped', modelName: 'Fable'}), 'F');
eq('scoped without name falls back to W',
    letterForRow({kind: 'weekly_scoped', modelName: null}), 'W');
eq('unknown kind uses first letter', letterForRow({kind: 'some_new_kind'}), 'S');
eq('missing kind -> ?', letterForRow({}), '?');

eq('empty rows -> empty text', formatPanelText([]), '');
eq('null rows -> empty text', formatPanelText(null), '');
eq('empty json -> empty text', formatPanelText(parseUsage({}).rows), '');
eq('non-finite percent skipped',
    formatPanelText([{kind: 'session', percent: NaN}]), '');
eq('null percent coerced to 0',
    formatPanelText(parseUsage({limits: [{kind: 'session', percent: null}]}).rows),
    'S 0%');

// --- backoffDelay: 429 backoff math ---
eq('backoff level 0 -> base', backoffDelay(300, 0), 300);
eq('backoff level 2 -> 4x base', backoffDelay(300, 2), 1200);
eq('retryAfter floor wins over backoff', backoffDelay(300, 0, 900), 900);
eq('backoff still wins when larger than retryAfter', backoffDelay(300, 2, 500), 1200);
eq('maxSeconds cap clamps', backoffDelay(300, 6, 0, 1800), 1800);
eq('negative level treated as 0', backoffDelay(300, -3), 300);

print(failures === 0
    ? '\nAll tests passed.'
    : `\n${failures} test(s) FAILED.`);
System.exit(failures === 0 ? 0 : 1);
