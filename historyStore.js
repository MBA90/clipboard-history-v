// SPDX-License-Identifier: GPL-2.0-or-later
// Clipboard history storage.
//
// Storage rules:
//  * Unpinned items live only for the current session. They are kept in
//    $XDG_RUNTIME_DIR (a RAM-backed tmpfs that is wiped on logout/reboot), so
//    the history survives the screen locking (which disables extensions)
//    but never hits the disk.
//  * Pinned items are kept in ~/.local/share and survive restarts.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readJson} from './fileUtils.js';

const APP_DIR = 'clipboard-history-v';
const SAVE_DELAY_MS = 400;

const IMAGE_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/webp': 'webp',
    'image/tiff': 'tiff',
};

function ensureDir(path) {
    GLib.mkdir_with_parents(path, 0o700);
}

function writeBytes(path, bytes, sync = false) {
    const file = Gio.File.new_for_path(path);
    const flags = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;
    if (sync) {
        file.replace_contents(bytes, null, false, flags, null);
        return;
    }
    file.replace_contents_bytes_async(bytes, null, false, flags, null, (f, res) => {
        try {
            f.replace_contents_finish(res);
        } catch (e) {
            console.warn(`[clipboard-history-v] Could not write ${path}: ${e.message}`);
        }
    });
}

function deleteFile(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
    } catch {
        // already gone
    }
}

function listFiles(dir) {
    const out = [];
    try {
        const enumerator = Gio.File.new_for_path(dir).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)))
            out.push(GLib.build_filenamev([dir, info.get_name()]));
        enumerator.close(null);
    } catch {
        // directory missing
    }
    return out;
}

export class HistoryStore {
    constructor(maxItems) {
        this.items = [];
        this.maxItems = maxItems;
        this.onChanged = null;

        this._nextId = 1;
        this._saveId = 0;

        this._runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), APP_DIR]);
        this._runtimeImages = GLib.build_filenamev([this._runtimeDir, 'images']);
        this._dataDir = GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR]);
        this._dataImages = GLib.build_filenamev([this._dataDir, 'images']);
        this._sessionFile = GLib.build_filenamev([this._runtimeDir, 'history.json']);
        this._pinnedFile = GLib.build_filenamev([this._dataDir, 'pinned.json']);

        ensureDir(this._runtimeImages);
        ensureDir(this._dataImages);
    }

    async load() {
        // Same login session (e.g. after the screen was locked): restore
        // everything. Fresh session: only the pinned items come back.
        let raw = await readJson(this._sessionFile);
        if (!Array.isArray(raw))
            raw = await readJson(this._pinnedFile);
        if (this._destroyed || !Array.isArray(raw))
            return;

        const loaded = [];
        for (const r of raw) {
            if (r?.kind === 'text' && typeof r.text === 'string') {
                loaded.push({
                    id: this._nextId++, kind: 'text', text: r.text,
                    hash: r.hash ?? GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, r.text, -1),
                    pinned: !!r.pinned,
                });
            } else if (r?.kind === 'image' && typeof r.file === 'string' &&
                       GLib.file_test(r.file, GLib.FileTest.EXISTS)) {
                loaded.push({
                    id: this._nextId++, kind: 'image', file: r.file,
                    mime: r.mime ?? 'image/png', hash: r.hash, pinned: !!r.pinned,
                });
            }
        }
        // Keep anything copied while the file was being read.
        const recent = this.items.filter(it => !loaded.some(l => l.hash === it.hash));
        this.items = [...recent, ...loaded];
        this._sortPinnedFirst();
        this._trim();
        this.onChanged?.();
    }

    // ---- mutations -------------------------------------------------------

    addText(text) {
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, text, -1);
        if (this._promote(hash))
            return;
        this.items.splice(this._pinnedCount(), 0, {id: this._nextId++, kind: 'text', text, hash, pinned: false});
        this._trim();
        this._changed();
    }

    addImage(bytes, mime) {
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        if (this._promote(hash))
            return;
        const file = GLib.build_filenamev([this._runtimeImages, `${hash}.${IMAGE_EXT[mime] ?? 'img'}`]);
        const gfile = Gio.File.new_for_path(file);
        gfile.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null,
            (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`[clipboard-history-v] Could not store image: ${e.message}`);
                    return;
                }
                if (this._destroyed || this._promote(hash))
                    return;
                this.items.splice(this._pinnedCount(), 0, {id: this._nextId++, kind: 'image', file, mime, hash, pinned: false});
                this._trim();
                this._changed();
            });
    }

    remove(id) {
        const i = this.items.findIndex(it => it.id === id);
        if (i < 0)
            return;
        this.items.splice(i, 1);
        this._changed();
    }

    // Pinned items always stay at the top of the list. Pinning moves the
    // item to the very top; unpinning moves it to the top of the unpinned
    // items.
    togglePin(id) {
        const i = this.items.findIndex(it => it.id === id);
        if (i < 0)
            return;
        const [item] = this.items.splice(i, 1);
        item.pinned = !item.pinned;
        if (item.pinned)
            this.items.unshift(item);
        else
            this.items.splice(this._pinnedCount(), 0, item);
        this._trim();
        this._changed();
    }

    // "Clear all" removes everything except pinned items.
    clearUnpinned() {
        const before = this.items.length;
        this.items = this.items.filter(it => it.pinned);
        if (this.items.length !== before)
            this._changed();
    }

    // ---- internals -------------------------------------------------------

    // Copying something that's already in the history moves it to the top
    // of the unpinned items. Pinned items keep their place.
    _promote(hash) {
        const i = this.items.findIndex(it => it.hash === hash);
        if (i < 0)
            return false;
        if (this.items[i].pinned)
            return true;
        const top = this._pinnedCount();
        if (i > top) {
            const [item] = this.items.splice(i, 1);
            this.items.splice(top, 0, item);
            this._changed();
        }
        return true;
    }

    _pinnedCount() {
        let n = 0;
        while (n < this.items.length && this.items[n].pinned)
            n++;
        return n;
    }

    _sortPinnedFirst() {
        this.items = [
            ...this.items.filter(it => it.pinned),
            ...this.items.filter(it => !it.pinned),
        ];
    }

    // Drop the oldest unpinned items above the limit.
    _trim() {
        let removed = false;
        let unpinned = this.items.filter(it => !it.pinned).length;
        for (let i = this.items.length - 1; i >= 0 && unpinned > this.maxItems; i--) {
            if (!this.items[i].pinned) {
                this.items.splice(i, 1);
                unpinned--;
                removed = true;
            }
        }
        return removed;
    }

    _changed() {
        this.onChanged?.();
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _save(sync) {
        const enc = new TextEncoder();

        // An image loaded from the pinned store that got unpinned must move
        // back to the session store before the pinned copy is cleaned up.
        for (const it of this.items) {
            if (it.kind === 'image' && !it.pinned && it.file.startsWith(this._dataDir)) {
                const dest = GLib.build_filenamev([this._runtimeImages, GLib.path_get_basename(it.file)]);
                try {
                    Gio.File.new_for_path(it.file).copy(Gio.File.new_for_path(dest),
                        Gio.FileCopyFlags.OVERWRITE, null, null);
                    it.file = dest;
                } catch (e) {
                    console.warn(`[clipboard-history-v] ${e.message}`);
                }
            }
        }

        const serialize = it => it.kind === 'text'
            ? {kind: 'text', text: it.text, hash: it.hash, pinned: it.pinned}
            : {kind: 'image', file: it.file, mime: it.mime, hash: it.hash, pinned: it.pinned};

        // Session file: everything (RAM only).
        writeBytes(this._sessionFile,
            new GLib.Bytes(enc.encode(JSON.stringify(this.items.map(serialize)))), sync);

        // Pinned file: pinned items, images copied to persistent storage.
        const pinned = [];
        const keepData = new Set();
        for (const it of this.items.filter(i => i.pinned)) {
            const rec = serialize(it);
            if (it.kind === 'image') {
                const dest = GLib.build_filenamev([this._dataImages, GLib.path_get_basename(it.file)]);
                if (dest !== it.file && !GLib.file_test(dest, GLib.FileTest.EXISTS)) {
                    try {
                        Gio.File.new_for_path(it.file).copy(Gio.File.new_for_path(dest),
                            Gio.FileCopyFlags.OVERWRITE, null, null);
                    } catch (e) {
                        console.warn(`[clipboard-history-v] ${e.message}`);
                        continue;
                    }
                }
                rec.file = dest;
                keepData.add(dest);
            }
            pinned.push(rec);
        }
        writeBytes(this._pinnedFile,
            new GLib.Bytes(enc.encode(JSON.stringify(pinned))), sync);

        // Garbage-collect image files nothing refers to anymore.
        const keepRuntime = new Set(this.items.filter(i => i.kind === 'image').map(i => i.file));
        for (const f of listFiles(this._runtimeImages)) {
            if (!keepRuntime.has(f))
                deleteFile(f);
        }
        for (const f of listFiles(this._dataImages)) {
            if (!keepData.has(f) && !keepRuntime.has(f))
                deleteFile(f);
        }
    }

    destroy() {
        this._destroyed = true;
        this.onChanged = null;
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save(true);
        }
    }
}
