#!/bin/bash
# Installs Boostbook for Desktop {{VERSION}} into Applications and opens it:
#   curl -fsSL https://github.com/devttys1/boostbook-for-desktop/releases/latest/download/install-mac.sh | bash
# Downloaded this way, macOS doesn't stop the app from opening.
set -euo pipefail
VERSION="{{VERSION}}"
URL="${BSM_ZIP_URL:-https://github.com/devttys1/boostbook-for-desktop/releases/download/v$VERSION/Boostbook-for-Desktop-$VERSION-macOS.zip}"
APP="Boostbook for Desktop.app"
DEST="${BSM_DEST:-/Applications}"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading Boostbook for Desktop $VERSION..."
curl -fL --progress-bar -o "$TMP/download.zip" "$URL"
ditto -x -k "$TMP/download.zip" "$TMP/x"
osascript -e 'quit app id "io.github.devttys1.bmw-service-manager"' 2>/dev/null || true
rm -rf "$DEST/$APP"
# Up to 1.4 the app was called BMW Service Manager (same bundle id): this one replaces it.
for old in "/Applications/BMW Service Manager.app" "$HOME/Applications/BMW Service Manager.app"; do
    if [ -d "$old" ]; then echo "Removing the old $(basename "$old" .app) (now Boostbook for Desktop)."; rm -rf "$old"; fi
done
ditto "$TMP/x/$APP" "$DEST/$APP"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
echo "Installed in $DEST. Opening it..."
open "$DEST/$APP"
