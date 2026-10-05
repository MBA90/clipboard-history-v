// SPDX-License-Identifier: GPL-2.0-or-later
// Asynchronous file reading, so the shell never blocks on disk IO.

import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

/**
 * @param {string} path
 * @returns {Promise<Uint8Array|null>} the file contents, or null if it can't be read
 */
export async function readBytes(path) {
    try {
        const [contents] = await Gio.File.new_for_path(path).load_contents_async(null);
        return contents;
    } catch {
        return null;
    }
}

/**
 * @param {string} path
 * @returns {Promise<any|null>} the parsed JSON, or null
 */
export async function readJson(path) {
    const bytes = await readBytes(path);
    if (!bytes)
        return null;
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}
