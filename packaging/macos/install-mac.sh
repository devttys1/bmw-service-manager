#!/bin/bash
# Installs BMW Service Manager {{VERSION}} into Applications and opens it:
#   curl -fsSL https://github.com/devttys1/bmw-service-manager/releases/latest/download/install-mac.sh | bash
# Downloaded this way, macOS doesn't stop the app from opening.
set -euo pipefail
VERSION="{{VERSION}}"
URL="${BSM_ZIP_URL:-https://github.com/devttys1/bmw-service-manager/releases/download/v$VERSION/BMW-Service-Manager-$VERSION-macOS.zip}"
APP="BMW Service Manager.app"
DEST="${BSM_DEST:-/Applications}"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading BMW Service Manager $VERSION..."
curl -fL --progress-bar -o "$TMP/download.zip" "$URL"
ditto -x -k "$TMP/download.zip" "$TMP/x"
osascript -e 'quit app id "io.github.devttys1.bmw-service-manager"' 2>/dev/null || true
rm -rf "$DEST/$APP"
ditto "$TMP/x/$APP" "$DEST/$APP"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
echo "Installed in $DEST. Opening it..."
open "$DEST/$APP"
