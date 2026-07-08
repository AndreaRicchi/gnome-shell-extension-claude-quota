#!/usr/bin/env gjs -m
// Live end-to-end check of the network path, outside GNOME Shell.
// Run: gjs -m test/live-fetch.js
// Reads your real token from ~/.claude/.credentials.json and hits the API.

import GLib from 'gi://GLib';
import System from 'system';

import {UsageClient} from '../usageClient.js';
import {parseUsage, formatReset} from '../usageModel.js';

const loop = GLib.MainLoop.new(null, false);
const client = new UsageClient();

client.fetchUsage('', null).then(result => {
    if (!result.ok) {
        print(`fetch failed: ${result.reason}`);
        client.destroy();
        loop.quit();
        System.exit(1);
        return;
    }

    const model = parseUsage(result.json);
    print(`Panel would show: ${model.sessionPercent}%\n`);
    for (const row of model.rows)
        print(`  ${row.label.padEnd(24)} ${String(row.percent).padStart(3)}%   ${formatReset(row.resetsAt)}`);

    client.destroy();
    loop.quit();
});

loop.run();
