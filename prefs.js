// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences: history on/off, clear history, and the keyboard shortcut.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {describeConflicts, findConflicts} from './shortcuts.js';

export default class ClipboardHistoryVPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(620, 460);

        const page = new Adw.PreferencesPage({
            title: 'Clipboard',
            icon_name: 'edit-paste-symbolic',
        });
        window.add(page);

        // ---- Clipboard ----------------------------------------------------
        const group = new Adw.PreferencesGroup({title: 'Clipboard'});
        page.add(group);

        const history = new Adw.SwitchRow({
            title: 'Clipboard history',
            subtitle: 'Save multiple items to the clipboard to use later. Press the shortcut to view your clipboard history and paste from it.',
        });
        settings.bind('history-enabled', history, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(history);

        const clearRow = new Adw.ActionRow({
            title: 'Clear clipboard data',
            subtitle: 'Clear everything (except pinned items)',
        });
        const clearButton = new Gtk.Button({
            label: 'Clear',
            valign: Gtk.Align.CENTER,
        });
        clearButton.connect('clicked', () => {
            settings.set_int('clear-history', settings.get_int('clear-history') + 1);
            clearButton.label = 'Cleared';
            clearButton.sensitive = false;
        });
        clearRow.add_suffix(clearButton);
        group.add(clearRow);

        // ---- Keyboard shortcut -------------------------------------------
        const keys = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
            description: 'No shortcut is set by default. Super+V is a good choice.',
        });
        page.add(keys);

        const shortcutRow = new Adw.ActionRow({
            title: 'Open clipboard history',
            subtitle: 'Click to change',
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Not set',
            valign: Gtk.Align.CENTER,
        });
        const removeButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Remove shortcut',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        removeButton.connect('clicked', () =>
            settings.set_strv('open-clipboard-history-v', []));

        const conflictRow = new Adw.ActionRow({
            title: 'These keys are also used elsewhere',
            css_classes: ['warning'],
            visible: false,
        });
        conflictRow.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));

        const showConflicts = async accel => {
            let conflicts = [];
            try {
                conflicts = await findConflicts(accel, this.metadata.uuid);
            } catch {
                // ignore; the check is only a hint
            }
            conflictRow.visible = conflicts.length > 0;
            conflictRow.subtitle = conflicts.length
                ? `${describeConflicts(conflicts)}. Only one of them will work, so pick different keys or change the other shortcut.`
                : '';
        };

        const sync = () => {
            const accel = settings.get_strv('open-clipboard-history-v')[0] ?? '';
            showConflicts(accel);
            shortcutLabel.accelerator = accel;
            removeButton.visible = accel !== '';
            if (accel === '')
                shortcutRow.subtitle = 'Click to choose a shortcut';
            else if (accel === '<Control>v')
                shortcutRow.subtitle = 'Ctrl+V now opens the history; pasting from it still works';
            else
                shortcutRow.subtitle = 'Click to change';
        };
        sync();
        settings.connect('changed::open-clipboard-history-v', sync);

        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.add_suffix(removeButton);
        shortcutRow.connect('activated', () => this._captureShortcut(window, settings));
        keys.add(shortcutRow);
        keys.add(conflictRow);
    }

    _captureShortcut(parent, settings) {
        const dialog = new Adw.Window({
            modal: true,
            transient_for: parent,
            default_width: 440,
            default_height: 240,
            resizable: false,
            title: 'Set shortcut',
        });
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 30, margin_bottom: 36, margin_start: 24, margin_end: 24,
            valign: Gtk.Align.CENTER,
        });
        box.append(new Gtk.Image({
            icon_name: 'input-keyboard-symbolic',
            pixel_size: 48,
            css_classes: ['dim-label'],
        }));
        box.append(new Gtk.Label({
            label: '<b>Press the new shortcut</b>',
            use_markup: true,
        }));
        box.append(new Gtk.Label({
            label: 'Esc to cancel · Backspace to remove the shortcut',
            css_classes: ['dim-label'],
        }));
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar());
        toolbar.set_content(box);
        dialog.set_content(toolbar);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (ctrl, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            if (!mask && keyval === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && keyval === Gdk.KEY_BackSpace) {
                settings.set_strv('open-clipboard-history-v', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            const lower = Gdk.keyval_to_lower(keyval);
            // Need at least one modifier, and ignore a lone modifier press.
            if (!mask || !Gtk.accelerator_valid(lower, mask))
                return Gdk.EVENT_STOP;
            settings.set_strv('open-clipboard-history-v', [Gtk.accelerator_name(lower, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.present();
    }
}
