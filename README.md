# Clipboard History V

A GNOME Shell extension that shows your clipboard history in a popup next to the text cursor, in the style of the Win+V panel.

<p align="center"><img src="screenshots/dark/image.png" alt="Clipboard History V, dark style" width="380"> &nbsp; <img src="screenshots/light/image.png" alt="Clipboard History V, light style" width="380"></p>

## Features

- Keeps the last 25 text and image items you copied
- Opens next to the text cursor (or the mouse pointer if there is no cursor)
- Click an item, or press **Enter**, to paste it into the app you were using
- Hold the shortcut's modifier and tap the key again to move down the list; release the modifier to paste
- **…** on each item: Delete, Pin, Clear all
- Pinned items stay at the top and survive restarts
- Follows the system light/dark style
- Works in terminals (pastes with Ctrl+Shift+V there)

## Setup

No keyboard shortcut is set by default. After enabling the extension, open its preferences and choose one. Super+V is a good choice.

![Preferences](screenshots/preferences/image.png)

## Privacy

This extension reads the clipboard to build the history.

- Unpinned items are kept only in `$XDG_RUNTIME_DIR` (memory), which is cleared when you log out or restart.
- Pinned items are stored in `~/.local/share/clipboard-history-v/`.
- Items that password managers mark as secret (`x-kde-passwordManagerHint`) are never saved.
- Nothing is ever sent over the network.

## Install

### From GitHub (works now, before the GNOME Extensions review)

**Step 1.** Download **[clipboard-history-v.zip](https://github.com/MBA90/clipboard-history-v/releases/latest/download/clipboard-history-v.zip)** (latest release).

**Step 2.** Open a terminal in the folder where you saved it and run:

```bash
gnome-extensions install --force clipboard-history-v.zip
```

**Step 3.** Log out and log back in, so GNOME Shell loads the new extension.

**Step 4.** Turn it on in the **Extensions** app, or run:

```bash
gnome-extensions enable clipboard-history-v@mba90.github.io
```

**Step 5.** Open its preferences and choose a shortcut (Super+V is a good choice):

```bash
gnome-extensions prefs clipboard-history-v@mba90.github.io
```

Or do steps 1 and 2 in one go:

```bash
cd /tmp && wget -O clipboard-history-v.zip https://github.com/MBA90/clipboard-history-v/releases/latest/download/clipboard-history-v.zip && gnome-extensions install --force clipboard-history-v.zip
```

### From extensions.gnome.org

Once the review is finished, install it from [extensions.gnome.org](https://extensions.gnome.org/extension/11151/clipboard-history-v/) or search for "Clipboard History V" in the **Extension Manager** app.

### Update or remove

To update, download the new zip and repeat steps 2 and 3. To remove:

```bash
gnome-extensions uninstall clipboard-history-v@mba90.github.io
```

### Build from source

```bash
git clone https://github.com/MBA90/clipboard-history-v.git
cd clipboard-history-v
./pack.sh
gnome-extensions install --force clipboard-history-v@mba90.github.io.shell-extension.zip
```

Supports GNOME Shell 46 to 50.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
