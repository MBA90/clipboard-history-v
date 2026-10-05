// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard History V
//
// A user-defined shortcut opens a clipboard history popup next to the text
// cursor. Choosing an item puts it on the clipboard and pastes it into the
// app you were typing in.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {HistoryStore} from './historyStore.js';
import {ClipboardPopup} from './popup.js';
import {describeConflicts, findConflicts, normalizeAccel, parseAccel} from './shortcuts.js';
import {readBytes} from './fileUtils.js';

const CLIPBOARD = St.ClipboardType.CLIPBOARD;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 25;
const CARET_MAX_AGE_US = 10 * 60 * GLib.USEC_PER_SEC;
const PASTE_DELAY_MS = 120;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];
const TEXT_MIMES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];
// Password managers mark secrets with x-kde-passwordManagerHint; file
// manager copies are file references, not content.
const SKIP_MIMES = ['x-kde-passwordManagerHint', 'x-special/gnome-copied-files'];

const TERMINALS = [
    'terminal', 'ptyxis', 'org.gnome.console', 'kgx', 'kitty', 'alacritty',
    'wezterm', 'foot', 'tilix', 'konsole', 'xterm', 'terminator', 'guake',
    'blackbox', 'ghostty', 'rio', 'tabby', 'warp', 'contour', 'urxvt',
];

// Linux evdev key codes (layout independent, so pasting works with Arabic,
// Russian, etc. keyboard layouts too).
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_V = 47;
const KEY_INSERT = 110;

const SHORTCUT_KEY = 'open-clipboard-history-v';
const SHELL_KEYBINDINGS = 'org.gnome.shell.keybindings';
const MESSAGE_TRAY_KEY = 'toggle-message-tray';

function prettyAccel(accel) {
    const {mods, key} = parseAccel(accel);
    const names = {super: 'Super', control: 'Ctrl', alt: 'Alt', shift: 'Shift'};
    return [...['super', 'control', 'alt', 'shift'].filter(m => mods.has(m)).map(m => names[m]),
        key.charAt(0).toUpperCase() + key.slice(1)].join('+');
}

function eventMatchesAccel(event, accel) {
    const {mods, key} = parseAccel(accel);
    if (!key)
        return false;
    const state = event.get_state();
    const has = {
        control: (state & Clutter.ModifierType.CONTROL_MASK) !== 0,
        shift: (state & Clutter.ModifierType.SHIFT_MASK) !== 0,
        alt: (state & Clutter.ModifierType.MOD1_MASK) !== 0,
        super: (state & (Clutter.ModifierType.MOD4_MASK | Clutter.ModifierType.SUPER_MASK)) !== 0,
    };
    for (const m of Object.keys(has)) {
        if (has[m] !== mods.has(m))
            return false;
    }
    const [lower] = Clutter.keyval_convert_case(event.get_key_symbol());
    const name = Clutter.keyval_name(lower) ?? '';
    return name.toLowerCase() === key;
}

export default class ClipboardHistoryV extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._clipboard = St.Clipboard.get_default();
        this._readSerial = 0;
        this._readTimeoutId = 0;
        this._pasteTimeoutId = 0;
        this._caret = null;

        this._store = new HistoryStore(MAX_ITEMS);
        this._store.onChanged = () => this._popup?.refresh();
        this._store.load().catch(e => console.warn(`[clipboard-history-v] ${e.message}`));

        this._popup = new ClipboardPopup({
            store: this._store,
            settings: this._settings,
            onActivate: item => this._useItem(item).catch(e =>
                console.warn(`[clipboard-history-v] Paste failed: ${e.message}`)),
            onTurnOn: () => this._settings.set_boolean('history-enabled', true),
            isShortcut: event => this._settings.get_strv(SHORTCUT_KEY)
                .some(a => eventMatchesAccel(event, a)),
            shortcutModifiers: () =>
                parseAccel(this._settings.get_strv(SHORTCUT_KEY)[0] ?? '').mods,
        });

        // global.stage.context exists on GNOME 47+; get_default_backend()
        // is gone in GNOME 51.
        const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
        const seat = backend.get_default_seat();
        this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        // Watch the clipboard.
        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect('owner-changed',
            (sel, type) => this._onOwnerChanged(type));

        // Track the text caret (Wayland text-input / IBus) so the popup can
        // open right under it.
        try {
            this._caretId = Main.inputMethod.connect('cursor-location-changed', (im, rect) => {
                this._caret = {
                    x: rect.origin.x, y: rect.origin.y,
                    width: rect.size.width, height: rect.size.height,
                    window: global.display.focus_window,
                    time: GLib.get_monotonic_time(),
                };
            });
        } catch {
            this._caretId = 0;
        }

        this._settingsIds = [
            this._settings.connect('changed::history-enabled', () => {
                if (!this._settings.get_boolean('history-enabled'))
                    this._store.clearUnpinned();
                this._popup.refresh();
            }),
            this._settings.connect('changed::clear-history', () => this._store.clearUnpinned()),
            this._settings.connect(`changed::${SHORTCUT_KEY}`, () => {
                this._freeShellShortcut();
                this._scheduleShortcutCheck();
            }),
        ];

        this._freeShellShortcut();
        this._keybindingAdded = false;
        this._addKeybinding();

        // Other extensions may still be loading (e.g. right after login).
        // Retry the shortcut if it could not be added, and check for other
        // shortcuts using the same keys once everything has settled.
        this._extStateId = Main.extensionManager.connect('extension-state-changed',
            () => this._scheduleShortcutCheck());
        this._startupId = Main.layoutManager._startingUp
            ? Main.layoutManager.connect('startup-complete', () => this._scheduleShortcutCheck())
            : 0;
        this._scheduleShortcutCheck();

        this._showSetupHint();
    }

    _addKeybinding() {
        if (this._keybindingAdded)
            return;
        // Keybinding names are global in GNOME Shell, so this one must not
        // clash with names used by other extensions.
        const action = Main.wm.addKeybinding(SHORTCUT_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._togglePopup());
        this._keybindingAdded = action !== Meta.KeyBindingAction.NONE;
    }

    _scheduleShortcutCheck() {
        if (this._checkTimeoutId)
            GLib.source_remove(this._checkTimeoutId);
        this._checkTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._checkTimeoutId = 0;
            this._addKeybinding();
            if (!this._keybindingAdded)
                console.warn('[clipboard-history-v] Could not register the keyboard shortcut');
            this._warnAboutConflicts().catch(e =>
                console.warn(`[clipboard-history-v] Shortcut check failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    // Tell the user (once per shortcut/conflict combination) when another
    // shortcut uses the same keys, since then GNOME picks one at random.
    async _warnAboutConflicts() {
        const accel = this._settings.get_strv(SHORTCUT_KEY)[0] ?? '';
        const conflicts = await findConflicts(accel, this.uuid);
        if (!this._settings)
            return; // disabled meanwhile
        const signature = conflicts.length ? `${normalizeAccel(accel)}|${describeConflicts(conflicts)}` : '';
        if (signature === this._settings.get_string('conflict-warned'))
            return;
        this._settings.set_string('conflict-warned', signature);
        if (!signature)
            return;

        this._clearConflictNotice();
        const source = MessageTray.getSystemSource();
        this._conflictNotice = new MessageTray.Notification({
            source,
            title: `${prettyAccel(accel)} is used by more than one shortcut`,
            body: `Clipboard History V shares it with: ${describeConflicts(conflicts)}. ` +
                'Only one of them will work. Choose a different shortcut, or change the other one.',
        });
        this._conflictNotice.addAction('Choose shortcut', () => this.openPreferences());
        this._conflictNoticeId = this._conflictNotice.connect('destroy', () => {
            this._conflictNotice = null;
        });
        source.addNotification(this._conflictNotice);
    }

    disable() {
        if (this._setupHint) {
            this._setupHint.disconnect(this._setupHintId);
            this._setupHint.destroy();
            this._setupHint = null;
        }
        this._clearConflictNotice();

        Main.extensionManager.disconnect(this._extStateId);
        if (this._startupId)
            Main.layoutManager.disconnect(this._startupId);
        this._extStateId = this._startupId = 0;
        if (this._checkTimeoutId)
            GLib.source_remove(this._checkTimeoutId);
        this._checkTimeoutId = 0;

        if (this._keybindingAdded)
            Main.wm.removeKeybinding(SHORTCUT_KEY);
        this._keybindingAdded = false;
        this._restoreShellShortcut();

        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = null;

        if (this._caretId)
            Main.inputMethod.disconnect(this._caretId);
        this._caretId = 0;
        this._caret = null;

        this._selection.disconnect(this._ownerChangedId);
        this._selection = null;

        if (this._readTimeoutId)
            GLib.source_remove(this._readTimeoutId);
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._readTimeoutId = this._pasteTimeoutId = 0;

        this._popup.destroy();
        this._popup = null;
        this._store.destroy();
        this._store = null;

        this._keyboard = null;
        this._clipboard = null;
        this._settings = null;
    }

    _clearConflictNotice() {
        if (!this._conflictNotice)
            return;
        this._conflictNotice.disconnect(this._conflictNoticeId);
        this._conflictNotice.destroy();
        this._conflictNotice = null;
    }

    // No shortcut ships by default, so tell new users once how to set one.
    _showSetupHint() {
        if (this._settings.get_strv(SHORTCUT_KEY).length > 0 ||
            this._settings.get_boolean('setup-hint-shown'))
            return;
        this._settings.set_boolean('setup-hint-shown', true);

        const source = MessageTray.getSystemSource();
        this._setupHint = new MessageTray.Notification({
            source,
            title: 'Clipboard History V',
            body: 'Choose a keyboard shortcut to open your clipboard history.',
        });
        this._setupHint.addAction('Choose shortcut', () => this.openPreferences());
        this._setupHintId = this._setupHint.connect('destroy', () => {
            this._setupHint = null;
        });
        source.addNotification(this._setupHint);
    }

    // ---- popup -----------------------------------------------------------

    _togglePopup() {
        if (this._popup.isOpen) {
            this._popup.close();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        this._popup.open(this._anchor());
    }

    _anchor() {
        const win = global.display.focus_window;
        let c = this._caret;
        // Nothing tracked yet (e.g. right after unlocking): fall back to the
        // caret position the input method last reported for the focused app.
        const imRect = Main.inputMethod.currentFocus ? Main.inputMethod._cursorRect : null;
        if (!c && imRect)
            c = {...imRect, window: win, time: GLib.get_monotonic_time()};
        if (c && win && c.window === win &&
            GLib.get_monotonic_time() - c.time < CARET_MAX_AGE_US) {
            const f = win.get_frame_rect();
            const inside = c.x >= f.x - 4 && c.x <= f.x + f.width + 4 &&
                           c.y >= f.y - 4 && c.y <= f.y + f.height + 4;
            if (inside && (c.x !== 0 || c.y !== 0))
                return {x: c.x, y: c.y, height: Math.max(c.height, 1)};
        }

        const [x, y] = global.get_pointer();
        return {x, y, height: 0};
    }

    // ---- clipboard monitoring --------------------------------------------

    _onOwnerChanged(type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;
        if (!this._settings.get_boolean('history-enabled'))
            return;

        // Apps sometimes change the owner several times in a row.
        if (this._readTimeoutId)
            GLib.source_remove(this._readTimeoutId);
        this._readTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
            this._readTimeoutId = 0;
            this._readClipboard();
            return GLib.SOURCE_REMOVE;
        });
    }

    _readClipboard() {
        const mimes = this._clipboard.get_mimetypes(CLIPBOARD) ?? [];
        if (mimes.length === 0 || mimes.some(m => SKIP_MIMES.includes(m)))
            return;

        const serial = ++this._readSerial;
        const stale = () => !this._store || serial !== this._readSerial;

        const hasText = mimes.some(m => TEXT_MIMES.includes(m) || m.startsWith('text/plain'));
        const imageMime = IMAGE_MIMES.find(m => mimes.includes(m));

        if (hasText) {
            this._clipboard.get_text(CLIPBOARD, (cb, text) => {
                if (stale() || !text || text.length > MAX_TEXT_CHARS)
                    return;
                this._store.addText(text);
            });
        } else if (imageMime) {
            this._clipboard.get_content(CLIPBOARD, imageMime, (cb, bytes) => {
                if (stale() || !bytes)
                    return;
                const size = bytes.get_size();
                if (size === 0 || size > MAX_IMAGE_BYTES)
                    return;
                this._store.addImage(bytes, imageMime);
            });
        }
    }

    // ---- pasting ---------------------------------------------------------

    async _useItem(item) {
        if (item.kind === 'text') {
            this._clipboard.set_text(CLIPBOARD, item.text);
        } else {
            const contents = await readBytes(item.file);
            if (!contents || !this._clipboard)
                return;
            this._clipboard.set_content(CLIPBOARD, item.mime, new GLib.Bytes(contents));
        }

        // Give focus a moment to return to the app after the popup closes.
        if (this._pasteTimeoutId)
            GLib.source_remove(this._pasteTimeoutId);
        this._pasteTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteTimeoutId = 0;
            this._sendPasteKeys();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendPasteKeys() {
        // Terminals on Linux paste with Ctrl+Shift+V instead of Ctrl+V.
        const terminal = this._focusIsTerminal();
        let keys = terminal
            ? [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V]
            : [KEY_LEFTCTRL, KEY_V];

        // If the user bound clipboard history itself to that paste shortcut
        // (e.g. Ctrl+V), sending it would just reopen the popup. Use the
        // other universal paste key instead.
        const pasteAccel = terminal ? '<Control><Shift>v' : '<Control>v';
        const ours = this._settings.get_strv(SHORTCUT_KEY).map(normalizeAccel);
        if (ours.includes(normalizeAccel(pasteAccel)))
            keys = [KEY_LEFTSHIFT, KEY_INSERT];

        let t = GLib.get_monotonic_time();
        for (const k of keys)
            this._keyboard.notify_key(t++, k, Clutter.KeyState.PRESSED);
        for (const k of [...keys].reverse())
            this._keyboard.notify_key(t++, k, Clutter.KeyState.RELEASED);
    }

    _focusIsTerminal() {
        const win = global.display.focus_window;
        if (!win)
            return false;
        const ids = [win.get_wm_class(), win.get_wm_class_instance(),
            win.get_gtk_application_id(), win.get_sandboxed_app_id?.()]
            .filter(Boolean).map(s => s.toLowerCase());
        return ids.some(id => TERMINALS.some(t => id.includes(t)));
    }

    // ---- Super+V conflict with GNOME's notification list ---------------

    // GNOME binds Super+V (and Super+M) to the notification list. If the user
    // picks Super+V for this extension, the two bindings would conflict, so
    // that one accelerator is removed from GNOME's list while the extension
    // is enabled and put back in disable().
    _freeShellShortcut() {
        this._restoreShellShortcut();
        let shell;
        try {
            shell = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
        } catch {
            return;
        }
        const ours = this._settings.get_strv(SHORTCUT_KEY).map(normalizeAccel);
        const current = shell.get_strv(MESSAGE_TRAY_KEY);
        const keep = current.filter(a => !ours.includes(normalizeAccel(a)));
        const freed = current.filter(a => ours.includes(normalizeAccel(a)));
        if (freed.length) {
            this._settings.set_strv('released-shell-keys', freed);
            shell.set_strv(MESSAGE_TRAY_KEY, keep);
        }
    }

    _restoreShellShortcut() {
        const freed = this._settings.get_strv('released-shell-keys');
        if (!freed.length)
            return;
        try {
            const shell = new Gio.Settings({schema_id: SHELL_KEYBINDINGS});
            const current = shell.get_strv(MESSAGE_TRAY_KEY);
            const have = current.map(normalizeAccel);
            shell.set_strv(MESSAGE_TRAY_KEY,
                [...freed.filter(a => !have.includes(normalizeAccel(a))), ...current]);
        } catch {
            // schema missing; nothing to restore
        }
        this._settings.set_strv('released-shell-keys', []);
    }
}
