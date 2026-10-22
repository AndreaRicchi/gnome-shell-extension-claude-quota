#!/usr/bin/env gjs -m
// Pure-logic tests for usageModel.js. Run: gjs -m test/usageModel-test.js
// (from the extension root, or any dir — paths are resolved from this file).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

import {parseUsage, formatReset, labelForLimit, classifyStatus, backoffDelay,
    letterForRow, formatPanelText, expectedPercent, paceForRow,
    formatPanelMarkup} from '../usageModel.js';

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

// --- pace: expected usage from the elapsed share of each window ---
// Fixture: session resets 16:00 UTC (5h window, opened 11:00), weekly resets
// 2026-07-09T22:00 UTC (7d window, opened 2026-07-02T22:00).
const at = s => GLib.DateTime.new_from_iso8601(s, null);
const session = model.rows.find(r => r.kind === 'session');
const weekly = model.rows.find(r => r.kind === 'weekly_all');
const scoped = model.rows.find(r => r.kind === 'weekly_scoped');

eq('session 2h into 5h -> 40% expected',
    expectedPercent(session, at('2026-07-08T13:00:00Z')), 40);
eq('session window just opened -> 0%',
    expectedPercent(session, at('2026-07-08T11:00:00Z')), 0);
eq('reset further out than the window clamps to 0%',
    expectedPercent(session, at('2026-07-08T10:00:00Z')), 0);
eq('weekly 3.5d into 7d -> 50% expected',
    expectedPercent(weekly, at('2026-07-06T10:00:00Z')), 50);
eq('scoped weekly uses the 7d window',
    expectedPercent(scoped, at('2026-07-06T10:00:00Z')), 50);
eq('past reset -> null',
    expectedPercent(session, at('2026-07-08T16:00:01Z')), null);
eq('null resetsAt -> null',
    expectedPercent({...session, resetsAt: null}, at('2026-07-08T13:00:00Z')), null);
eq('unparseable resetsAt -> null',
    expectedPercent({...session, resetsAt: 'soon'}, at('2026-07-08T13:00:00Z')), null);
eq('unknown kind -> null',
    expectedPercent({...session, kind: 'some_new_kind'}, at('2026-07-08T13:00:00Z')),
    null);

// The issue's own example: 50% used, 40% expected -> ahead.
const twoHoursIn = at('2026-07-08T13:00:00Z');
eq('10 points ahead -> ahead',
    paceForRow({...session, percent: 50}, twoHoursIn)?.ahead, true);
eq('9 points ahead -> not ahead',
    paceForRow({...session, percent: 49}, twoHoursIn)?.ahead, false);
eq('behind -> not ahead',
    paceForRow({...session, percent: 15}, twoHoursIn)?.ahead, false);
eq('pace carries expected', paceForRow(session, twoHoursIn)?.expected, 40);
eq('no window -> no pace',
    paceForRow({...session, kind: 'some_new_kind'}, twoHoursIn), null);
eq('non-finite percent -> no pace',
    paceForRow({...session, percent: NaN}, twoHoursIn), null);

// --- panel markup: ahead segments wrapped in a colour span, rest escaped ---
// 13:00 UTC: session 15% vs 40% expected, weekly 28% vs 66%: nothing ahead.
eq('markup with nothing ahead equals plain text',
    formatPanelMarkup(model.rows, twoHoursIn), 'S 15% · W 28% · F 26%');
eq('ahead segment wrapped',
    formatPanelMarkup([{...session, percent: 50}, weekly], twoHoursIn),
    '<span foreground="#e5c07b">S 50%</span> · W 28%');
eq('model letter escaped',
    formatPanelMarkup([{kind: 'weekly_scoped', modelName: '<b>', percent: 5}],
        twoHoursIn),
    '&lt; 5%');
eq('null rows -> empty markup', formatPanelMarkup(null, twoHoursIn), '');

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
