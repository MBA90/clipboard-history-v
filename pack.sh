#!/usr/bin/env bash
# Builds the zip to upload to extensions.gnome.org.
set -euo pipefail
cd "$(dirname "$0")"
UUID=$(python3 -c 'import json; print(json.load(open("metadata.json"))["uuid"])')
OUT="$UUID.shell-extension.zip"
rm -f "$OUT"
zip -q "$OUT" metadata.json extension.js historyStore.js popup.js prefs.js shortcuts.js fileUtils.js \
    stylesheet.css stylesheet-dark.css stylesheet-light.css \
    schemas/org.gnome.shell.extensions.clipboard-history-v.gschema.xml
echo "Created $OUT"
