// SPDX-License-Identifier: GPL-2.0-or-later
// Accelerator helpers shared by the extension and its preferences, plus a
// scan for other shortcuts (GNOME's own, custom ones and other enabled
// extensions') that use the same keys.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readJson} from './fileUtils.js';

const MOD_ALIASES = {
    primary: 'control', ctrl: 'control', control: 'control', ctl: 'control',
    shift: 'shift', alt: 'alt', mod1: 'alt',
    super: 'super', mod4: 'super', meta: 'super', hyper: 'super',
};

// GNOME's notification list shortcut is handed over by the extension itself.
const HANDLED_KEYS = new Set(['org.gnome.shell.keybindings/toggle-message-tray']);

const BUILTIN_SCHEMAS = [
    ['org.gnome.shell.keybindings', 'GNOME Shell'],
    ['org.gnome.desktop.wm.keybindings', 'GNOME window shortcuts'],
    ['org.gnome.mutter.keybindings', 'GNOME window shortcuts'],
    ['org.gnome.mutter.wayland.keybindings', 'GNOME window shortcuts'],
    ['org.gnome.settings-daemon.plugins.media-keys', 'GNOME keyboard shortcuts'],
];

export function parseAccel(accel) {
    const mods = new Set();
    const key = accel.replace(/\s+/g, '').replace(/<([^>]+)>/g, (m, mod) => {
        const name = MOD_ALIASES[mod.toLowerCase()];
        if (name)
            mods.add(name);
        return '';
    }).toLowerCase();
    return {mods, key};
}

export function normalizeAccel(accel) {
    const {mods, key} = parseAccel(accel);
    return [...[...mods].sort(), key].join('+');
}

function accelsOf(settings, schema, key) {
    const type = schema.get_key(key).get_value_type().dup_string();
    if (type === 'as')
        return settings.get_strv(key);
    if (type === 's')
        return [settings.get_string(key)];
    return [];
}

function scanSchema(schema, owner, target, out) {
    const settings = new Gio.Settings({settings_schema: schema});
    for (const key of schema.list_keys()) {
        if (HANDLED_KEYS.has(`${schema.get_id()}/${key}`))
            continue;
        if (accelsOf(settings, schema, key).some(a => a.includes('<') && normalizeAccel(a) === target))
            out.push({owner, key});
    }
}

function extensionSchemas(dir, metadata) {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    const schemaDir = GLib.build_filenamev([dir, 'schemas']);
    if (GLib.file_test(GLib.build_filenamev([schemaDir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
        const source = Gio.SettingsSchemaSource.new_from_directory(schemaDir, defaultSource, false);
        const [ids] = source.list_schemas(false);
        return ids.map(id => source.lookup(id, false)).filter(Boolean);
    }
    // Installed system-wide: schemas live in the default location.
    const base = metadata['settings-schema'];
    if (!base)
        return [];
    const [ids] = defaultSource.list_schemas(true);
    return ids.filter(id => id === base || id.startsWith(`${base}.`))
        .map(id => defaultSource.lookup(id, true)).filter(Boolean);
}

/**
 * Lists other shortcuts that use the same keys as `accel`.
 *
 * @param {string} accel accelerator, e.g. "<Super>v"
 * @param {string} ownUuid this extension's UUID (skipped)
 * @returns {Promise<{owner: string, key: string}[]>}
 */
export async function findConflicts(accel, ownUuid) {
    const target = accel ? normalizeAccel(accel) : '';
    if (!target)
        return [];
    const out = [];
    const defaultSource = Gio.SettingsSchemaSource.get_default();

    for (const [id, owner] of BUILTIN_SCHEMAS) {
        const schema = defaultSource.lookup(id, true);
        if (schema)
            scanSchema(schema, owner, target, out);
    }

    try {
        const mediaKeys = new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.media-keys'});
        for (const path of mediaKeys.get_strv('custom-keybindings')) {
            const custom = new Gio.Settings({
                schema_id: 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
                path,
            });
            if (normalizeAccel(custom.get_string('binding')) === target)
                out.push({owner: 'Custom shortcut', key: custom.get_string('name')});
        }
    } catch {
        // custom shortcuts not available
    }

    const enabled = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('enabled-extensions');
    const roots = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
        .map(d => GLib.build_filenamev([d, 'gnome-shell', 'extensions']));
    for (const uuid of enabled) {
        if (uuid === ownUuid)
            continue;
        const dir = roots.map(r => GLib.build_filenamev([r, uuid]))
            .find(d => GLib.file_test(GLib.build_filenamev([d, 'metadata.json']), GLib.FileTest.EXISTS));
        const metadata = dir ? await readJson(GLib.build_filenamev([dir, 'metadata.json'])) : null;
        if (!metadata)
            continue;
        try {
            for (const schema of extensionSchemas(dir, metadata))
                scanSchema(schema, metadata.name ?? uuid, target, out);
        } catch {
            // unreadable schemas; skip this extension
        }
    }
    return out;
}

export function describeConflicts(conflicts) {
    return conflicts.map(c => `${c.owner} (${c.key})`).join(', ');
}
