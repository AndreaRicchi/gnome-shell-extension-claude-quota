import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeQuotaPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Claude Quota',
            description: 'Reads the OAuth token stored by Claude Code.',
        });
        page.add(group);

        // Refresh interval.
        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Seconds between usage checks',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 3600,
                step_increment: 5,
                page_increment: 30,
            }),
        });
        group.add(interval);
        settings.bind('refresh-interval', interval, 'value',
            Gio.SettingsBindFlags.DEFAULT);

        // Compact per-limit percentages next to the panel icon.
        const panelText = new Adw.SwitchRow({
            title: 'Show percentages in top bar',
            subtitle: 'Compact per-limit usage next to the panel icon',
        });
        group.add(panelText);
        settings.bind('show-panel-percentages', panelText, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        // Expected usage per limit; ahead-of-pace limits turn yellow.
        const pace = new Adw.SwitchRow({
            title: 'Show usage pace',
            subtitle: 'Yellow when a limit is 10+ points above a steady rate',
        });
        group.add(pace);
        settings.bind('show-pace', pace, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        // Credentials path override (empty = ~/.claude/.credentials.json).
        const path = new Adw.EntryRow({
            title: 'Credentials path (blank = default)',
            show_apply_button: true,
        });
        group.add(path);
        settings.bind('credentials-path', path, 'text',
            Gio.SettingsBindFlags.DEFAULT);

        window.add(page);
    }
}
