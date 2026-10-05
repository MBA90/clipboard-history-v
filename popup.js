// SPDX-License-Identifier: GPL-2.0-or-later
// The clipboard history popup.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PREVIEW_MAX_LINES = 6;

const MODIFIER_KEYS = {
    super: [Clutter.KEY_Super_L, Clutter.KEY_Super_R, Clutter.KEY_Meta_L,
        Clutter.KEY_Meta_R, Clutter.KEY_Hyper_L, Clutter.KEY_Hyper_R],
    control: [Clutter.KEY_Control_L, Clutter.KEY_Control_R],
    alt: [Clutter.KEY_Alt_L, Clutter.KEY_Alt_R, Clutter.KEY_ISO_Level3_Shift],
    shift: [Clutter.KEY_Shift_L, Clutter.KEY_Shift_R],
};
const ALL_MODIFIER_KEYS = Object.values(MODIFIER_KEYS).flat();
const PREVIEW_MAX_CHARS = 300;

// St.BoxLayout replaced `vertical` with `orientation` in GNOME 48.
function vbox(params = {}) {
    const box = new St.BoxLayout(params);
    if (box.orientation !== undefined)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'chv-icon-button',
        can_focus: true,
        accessible_name: accessibleName,
        child: new St.Icon({icon_name: iconName, icon_size: 16}),
    });
}

function makePreview(text) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    while (lines.length > 1 && lines[0].trim() === '')
        lines.shift();
    let truncated = lines.length > PREVIEW_MAX_LINES;
    let s = lines.slice(0, PREVIEW_MAX_LINES).join('\n');
    if (s.length > PREVIEW_MAX_CHARS) {
        s = s.slice(0, PREVIEW_MAX_CHARS);
        truncated = true;
    }
    s = s.trimEnd();
    if (truncated)
        s += ' …';
    return s.trim() === '' ? ' ' : s;
}

export class ClipboardPopup {
    constructor({store, settings, onActivate, onTurnOn, isShortcut, shortcutModifiers}) {
        this._store = store;
        this._settings = settings;
        this._onActivate = onActivate;
        this._onTurnOn = onTurnOn;
        this._isShortcut = isShortcut;
        this._shortcutModifiers = shortcutModifiers;
        this._cycling = false;
        this._backdrop = null;
        this._grab = null;
        this._cards = [];
    }

    get isOpen() {
        return this._backdrop !== null;
    }

    open(anchor) {
        if (this.isOpen)
            return;

        this._backdrop = new St.Widget({
            reactive: true,
            x: 0, y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        // Close when clicking outside the panel. Presses inside the panel
        // must keep propagating: on GNOME 49+ buttons use click gestures,
        // and stopping the event in an ancestor cancels the gesture.
        const outside = event => global.stage.get_event_actor(event) === this._backdrop;
        this._backdrop.connect('button-press-event', (a, event) => {
            if (!outside(event))
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('touch-event', (a, event) => {
            if (!outside(event))
                return Clutter.EVENT_PROPAGATE;
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (a, event) => this._onKeyPress(event));
        this._backdrop.connect('key-release-event', (a, event) => this._onKeyRelease(event));
        this._cycling = false;

        this._buildPanel();
        this._backdrop.add_child(this._panel);
        Main.uiGroup.add_child(this._backdrop);

        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});
        // GNOME 46-49 expose get_seat_state(); GNOME 50 removed it and only
        // has is_revoked().
        const grabFailed = typeof this._grab.get_seat_state === 'function'
            ? (this._grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0
            : this._grab.is_revoked?.() ?? false;
        if (grabFailed) {
            // Another grab is active (e.g. a menu is open); don't steal it.
            this.close(true);
            return;
        }

        this.refresh();
        this._place(anchor);

        this._panel.opacity = 0;
        this._panel.translation_y = 12;
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        this._focusCard(0);
    }

    close(immediate = false) {
        if (!this._backdrop)
            return;
        const backdrop = this._backdrop;
        const panel = this._panel;
        this._backdrop = null;
        this._panel = null;
        this._cards = [];

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        backdrop.reactive = false;
        if (immediate) {
            backdrop.destroy();
            return;
        }
        panel.ease({
            opacity: 0,
            translation_y: 6,
            duration: 100,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => backdrop.destroy(),
        });
    }

    destroy() {
        this.close(true);
    }

    // ---- building --------------------------------------------------------

    _buildPanel() {
        this._panel = vbox({style_class: 'chv-panel', reactive: true});

        const header = new St.BoxLayout({style_class: 'chv-header', x_expand: true});
        header.add_child(new St.Label({
            text: 'Clipboard history',
            style_class: 'chv-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._clearAllButton = new St.Button({
            label: 'Clear all',
            style_class: 'chv-text-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clearAllButton.connect('clicked', () => this._store.clearUnpinned());
        header.add_child(this._clearAllButton);
        this._panel.add_child(header);

        this._list = vbox({style_class: 'chv-list', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'chv-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._scroll.child = this._list;
        this._panel.add_child(this._scroll);

        this._placeholder = vbox({
            style_class: 'chv-empty',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panel.add_child(this._placeholder);
    }

    refresh() {
        if (!this._panel)
            return;

        const focusedIndex = this._focusedCardIndex();
        this._list.destroy_all_children();
        this._placeholder.destroy_all_children();
        this._cards = [];

        const enabled = this._settings.get_boolean('history-enabled');
        const items = enabled ? this._store.items : [];

        this._clearAllButton.reactive = items.some(it => !it.pinned);
        this._clearAllButton.can_focus = this._clearAllButton.reactive;
        this._clearAllButton.visible = enabled;

        if (!enabled) {
            this._showPlaceholder(
                'Clipboard history is off',
                'Turn it on to save multiple items to your clipboard and paste them from here.',
                'Turn on');
        } else if (items.length === 0) {
            this._showPlaceholder(
                'Nothing here',
                "You'll see your clipboard history here once you've copied something.",
                null);
        } else {
            this._scroll.show();
            this._placeholder.hide();
            for (const item of items)
                this._list.add_child(this._makeCard(item));
            if (focusedIndex >= 0)
                this._focusCard(Math.min(focusedIndex, this._cards.length - 1));
        }

        if (this._cards.length === 0 && this._backdrop)
            global.stage.set_key_focus(this._turnOnButton ?? this._backdrop);
    }

    _showPlaceholder(title, body, buttonLabel) {
        this._scroll.hide();
        this._placeholder.show();
        this._turnOnButton = null;

        this._placeholder.add_child(new St.Icon({
            icon_name: 'edit-paste-symbolic',
            style_class: 'chv-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._placeholder.add_child(new St.Label({
            text: title,
            style_class: 'chv-empty-title',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const bodyLabel = new St.Label({
            text: body,
            style_class: 'chv-empty-body',
            x_expand: true,
        });
        bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        bodyLabel.clutter_text.line_wrap = true;
        bodyLabel.clutter_text.line_alignment = Pango.Alignment.CENTER;
        this._placeholder.add_child(bodyLabel);

        if (buttonLabel) {
            this._turnOnButton = new St.Button({
                label: buttonLabel,
                style_class: 'chv-accent-button',
                can_focus: true,
                x_align: Clutter.ActorAlign.CENTER,
            });
            this._turnOnButton.connect('clicked', () => this._onTurnOn());
            this._placeholder.add_child(this._turnOnButton);
        }
    }

    _makeCard(item) {
        const card = vbox({
            style_class: 'chv-card',
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        const row = new St.BoxLayout({x_expand: true});

        const main = new St.Button({
            style_class: 'chv-card-main',
            can_focus: true,
            x_expand: true,
            accessible_name: item.kind === 'text' ? item.text.slice(0, 200) : 'Image',
        });
        let content;
        if (item.kind === 'text') {
            content = new St.Label({
                text: makePreview(item.text),
                style_class: 'chv-card-text',
                x_expand: true,
            });
            content.clutter_text.line_wrap = true;
            content.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            content.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        } else {
            const uri = GLib.filename_to_uri(item.file, null);
            content = new St.Widget({
                style_class: 'chv-card-image',
                x_expand: true,
                style: `background-image: url("${uri}");`,
            });
        }
        main.set_child(content);
        main.connect('clicked', () => this._activate(item));

        const side = vbox({style_class: 'chv-card-side'});
        const more = iconButton('view-more-horizontal-symbolic', 'See more');
        side.add_child(more);
        if (item.pinned) {
            side.add_child(new St.Icon({
                icon_name: 'view-pin-symbolic',
                icon_size: 14,
                style_class: 'chv-pin-indicator',
                x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        row.add_child(main);
        row.add_child(side);
        card.add_child(row);

        // The "..." row: Delete, Pin/Unpin, Clear all.
        const actions = new St.BoxLayout({
            style_class: 'chv-actions',
            x_align: Clutter.ActorAlign.END,
            visible: false,
        });
        const del = iconButton('user-trash-symbolic', 'Delete');
        del.connect('clicked', () => this._store.remove(item.id));
        const pin = iconButton('view-pin-symbolic', item.pinned ? 'Unpin' : 'Pin');
        if (item.pinned)
            pin.add_style_pseudo_class('checked');
        pin.connect('clicked', () => this._store.togglePin(item.id));
        const clear = iconButton('edit-clear-all-symbolic', 'Clear all');
        clear.connect('clicked', () => this._store.clearUnpinned());
        actions.add_child(del);
        actions.add_child(pin);
        actions.add_child(clear);
        card.add_child(actions);

        more.connect('clicked', () => {
            actions.visible = !actions.visible;
            if (actions.visible) {
                for (const c of this._cards) {
                    if (c.actions !== actions)
                        c.actions.hide();
                }
                del.grab_key_focus();
            } else {
                more.grab_key_focus();
            }
        });

        const cardFocusIn = () => card.add_style_pseudo_class('focus');
        const cardFocusOut = () => card.remove_style_pseudo_class('focus');
        main.connect('key-focus-in', cardFocusIn);
        main.connect('key-focus-out', cardFocusOut);

        this._cards.push({item, card, main, more, actions});
        return card;
    }

    // ---- behaviour -------------------------------------------------------

    _activate(item) {
        this.close();
        this._onActivate(item);
    }

    _focusedCardIndex() {
        const focus = global.stage.get_key_focus();
        if (!focus)
            return -1;
        return this._cards.findIndex(c => c.card.contains(focus));
    }

    _focusCard(index) {
        const c = this._cards[index];
        if (!c)
            return;
        c.main.grab_key_focus();
        this._ensureVisible(c.card);
    }

    _ensureVisible(actor) {
        const adj = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        if (!adj)
            return;
        const box = actor.get_allocation_box();
        const {value, pageSize} = {value: adj.value, pageSize: adj.page_size};
        if (box.y1 < value)
            adj.value = box.y1;
        else if (box.y2 > value + pageSize)
            adj.value = box.y2 - pageSize;
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        const state = event.get_state();

        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        // Pressing the shortcut again (e.g. keep holding Super, tap V)
        // moves down to the next item, wrapping back to the top.
        if (this._isShortcut(event)) {
            if (this._cards.length === 0) {
                this.close();
                return Clutter.EVENT_STOP;
            }
            const i = this._focusedCardIndex();
            this._focusCard(i < 0 ? 0 : (i + 1) % this._cards.length);
            // Still holding the shortcut's modifier: letting go of it will
            // paste the selected item (see _onKeyRelease).
            this._cycling = true;
            return Clutter.EVENT_STOP;
        }

        // Any other (non-modifier) key means the user is browsing normally;
        // releasing the modifier then shouldn't paste.
        if (!ALL_MODIFIER_KEYS.includes(sym))
            this._cycling = false;

        const focus = global.stage.get_key_focus();
        const idx = this._focusedCardIndex();

        switch (sym) {
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
            this._focusCard(idx < 0 ? 0 : Math.min(idx + 1, this._cards.length - 1));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
            this._focusCard(idx < 0 ? 0 : Math.max(idx - 1, 0));
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab: {
            const backward = sym === Clutter.KEY_ISO_Left_Tab ||
                (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
            this._panel?.navigate_focus(focus === this._backdrop ? null : focus,
                backward ? St.DirectionType.TAB_BACKWARD : St.DirectionType.TAB_FORWARD, true);
            const f = global.stage.get_key_focus();
            const c = this._cards.find(cc => cc.card.contains(f));
            if (c)
                this._ensureVisible(c.card);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // After moving through the list with the shortcut, releasing its
    // modifier key (e.g. Super) pastes the selected item and closes.
    _onKeyRelease(event) {
        if (!this._cycling)
            return Clutter.EVENT_PROPAGATE;

        const sym = event.get_key_symbol();
        const released = [...this._shortcutModifiers()]
            .some(m => MODIFIER_KEYS[m]?.includes(sym));
        if (!released)
            return Clutter.EVENT_PROPAGATE;

        this._cycling = false;
        const card = this._cards[this._focusedCardIndex()];
        if (card)
            this._activate(card.item);
        return Clutter.EVENT_STOP;
    }

    // anchor: {x, y, height} in stage coordinates, or null for screen center
    _place(anchor) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const gap = 6 * scale;
        const [, natW] = this._panel.get_preferred_width(-1);
        const [, natH] = this._panel.get_preferred_height(natW);

        const px = anchor ? anchor.x : global.get_pointer()[0];
        const py = anchor ? anchor.y : global.get_pointer()[1];
        let monitorIndex = Main.layoutManager.monitors.findIndex(m =>
            px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height);
        if (monitorIndex < 0)
            monitorIndex = Main.layoutManager.primaryIndex;
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);

        let x, y;
        if (!anchor) {
            x = wa.x + (wa.width - natW) / 2;
            y = wa.y + (wa.height - natH) / 2;
        } else {
            x = anchor.x;
            y = anchor.y + anchor.height + gap;
            if (y + natH > wa.y + wa.height)
                y = anchor.y - natH - gap; // flip above the caret
        }
        x = Math.max(wa.x + gap, Math.min(x, wa.x + wa.width - natW - gap));
        y = Math.max(wa.y + gap, Math.min(y, wa.y + wa.height - natH - gap));
        this._panel.set_position(Math.round(x), Math.round(y));
    }
}
