#!/bin/bash
# Builds the standalone downloads, each with its own Python, into dist/:
#   BMW-Service-Manager-<version>-macOS.zip       BMW Service Manager.app, Apple silicon and Intel
#   install-mac.sh                                 the one-line installer for that zip
#   BMW-Service-Manager-<version>-Windows.zip     64-bit (x64; also runs on Windows on ARM)
#   BMW-Service-Manager-<version>-Linux.tar.gz    x86_64 and aarch64 (glibc)
# <version> is bmw_service_manager.__version__, e.g. 1.0.1.
# Runs on a Mac or Linux (x86_64 or arm64) with curl, tar and zip; no Python needed. The macOS
# download needs a Mac with the Xcode command line tools (swiftc, lipo, codesign).
#   packaging/build.sh                  all three
#   packaging/build.sh macOS            just one
set -euo pipefail
cd "$(dirname "$0")/.."

# Portable CPython builds: https://github.com/astral-sh/python-build-standalone
PBS_RELEASE=20261013
PY_VERSION=3.13.16
PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE"
CACHE="${CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/bmw-service-manager-build}"
TARGETS="${*:-macOS Windows Linux}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$CACHE" dist
VERSION="$(sed -n 's/^__version__ = "\(.*\)"/\1/p' bmw_service_manager/__init__.py)"
NAME="BMW-Service-Manager-$VERSION"
# Archives don't name the builder's account: owner root, no extra uid/gid fields in zips (-X).
if tar --version 2>/dev/null | grep -q GNU; then TAR_ANON="--owner=0 --group=0 --numeric-owner"
else TAR_ANON="--uid 0 --gid 0 --uname root --gname root"; fi

triple() {  # runtime folder name -> python-build-standalone target
    case "$1" in
        macos-arm64) echo aarch64-apple-darwin ;;
        macos-x86_64) echo x86_64-apple-darwin ;;
        windows-x86_64) echo x86_64-pc-windows-msvc ;;
        linux-x86_64) echo x86_64-unknown-linux-gnu ;;
        linux-aarch64) echo aarch64-unknown-linux-gnu ;;
    esac
}

download() {  # runtime name -> its archive in $CACHE (downloaded once)
    local file
    file="$CACHE/cpython-$PY_VERSION+$PBS_RELEASE-$(triple "$1")-install_only_stripped.tar.gz"
    if [ ! -s "$file" ]; then
        echo "Downloading $(basename "$file")" >&2
        curl -fsSL --retry 3 -o "$file.part" "$PBS_URL/$(basename "$file")"
        mv "$file.part" "$file"
    fi
    echo "$file"
}

fetch() {  # runtime name -> unpacked and trimmed into $WORK/runtimes/<name>/python
    local archive
    archive="$(download "$1")"
    mkdir -p "$WORK/runtimes/$1"
    tar -xzf "$archive" -C "$WORK/runtimes/$1"
    trim "$WORK/runtimes/$1/python"
}

trim() {  # leaves out what the app never uses: Tk, IDLE, the test suite, pip, headers
    local py="$1" lib
    # Windows has python.exe (test for that, not for Lib: macOS disks ignore case).
    if [ -f "$py/python.exe" ]; then lib="$py/Lib"; rm -rf "$py/tcl" "$py/include" "$py/libs" "$py/Scripts" "$py"/DLLs/_tkinter.pyd "$py"/DLLs/tcl*.dll "$py"/DLLs/tk*.dll
    else lib="$(echo "$py"/lib/python3.*)"; rm -rf "$py/include" "$py/share" "$py"/lib/tcl* "$py"/lib/tk* "$py"/lib/itcl* "$py"/lib/thread* "$py"/lib/libtcl* "$py"/lib/libtk* "$py/lib/pkgconfig" "$lib"/config-* "$lib"/lib-dynload/_tkinter*; fi
    rm -rf "$lib"/{test,idlelib,tkinter,turtledemo,ensurepip,pydoc_data} "$lib"/site-packages/* \
        "$py"/bin/pip* "$py"/bin/idle* "$py"/DLLs/_test*.pyd
}

host_python() {  # a runtime that runs here, to install the pure-Python packages with
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64) echo macos-arm64 ;;
        Darwin-*) echo macos-x86_64 ;;
        Linux-aarch64|Linux-arm64) echo linux-aarch64 ;;
        *) echo linux-x86_64 ;;
    esac
}

app() {  # the app and its packages -> $WORK/app
    local archive; archive="$(download "$(host_python)")"
    mkdir -p "$WORK/hostpy"
    tar -xzf "$archive" -C "$WORK/hostpy"  # untrimmed: it has pip
    rm -rf "$WORK/app" && mkdir -p "$WORK/app"
    "$WORK/hostpy/python/bin/python3" -m pip install -q --disable-pip-version-check --no-compile --no-deps \
        --target "$WORK/app/vendor" -r packaging/requirements.txt
    rm -rf "$WORK"/app/vendor/markupsafe/_speedups.* "$WORK/app/vendor/bin" "$WORK/app/vendor/share"
    cp -R bmw_service_manager "$WORK/app/"
    find "$WORK/app" -name __pycache__ -prune -exec rm -rf {} +
    cp packaging/start.py "$WORK/app/"
}

bundle() {  # OS, runtimes...
    local os="$1"; shift
    local dir="$WORK/out/$os/BMW Service Manager"
    rm -rf "$WORK/out/$os" && mkdir -p "$dir/runtime"
    for r in "$@"; do
        [ -d "$WORK/runtimes/$r" ] || fetch "$r"
        cp -R "$WORK/runtimes/$r" "$dir/runtime/$r"
    done
    cp -R "$WORK/app" "$dir/app"
    sed "s/{{VERSION}}/$VERSION/g" "packaging/launchers/README-$os.txt" > "$dir/READ ME FIRST.txt"
    cp packaging/readme/LICENSE.md "$dir/LICENSE.md"
    case "$os" in
        macOS) cp packaging/launchers/*.command "$dir/" ;;
        Windows) cp packaging/launchers/*.bat "$dir/" ;;
        Linux) cp packaging/launchers/*.sh "$dir/" ;;
    esac
    (cd "$WORK/out/$os" && case "$os" in
        Linux) rm -f "$OLDPWD/dist/$NAME-Linux.tar.gz"; COPYFILE_DISABLE=1 tar --no-xattrs $TAR_ANON -czf "$OLDPWD/dist/$NAME-Linux.tar.gz" "BMW Service Manager" ;;
        *) rm -f "$OLDPWD/dist/$NAME-$os.zip"; zip -qryX "$OLDPWD/dist/$NAME-$os.zip" "BMW Service Manager" ;;
    esac)
    ls -l dist/"$NAME-$os".*
}

bundle_mac() {  # BMW Service Manager.app: a small Swift launcher, with the app and both runtimes in Resources
    command -v swiftc >/dev/null || { echo "The macOS download needs a Mac with the Xcode command line tools."; exit 1; }
    local stage="$WORK/out/macOS" app
    app="$stage/BMW Service Manager.app"
    rm -rf "$stage" && mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/runtime"
    for arch in arm64 x86_64; do
        swiftc -O -parse-as-library -target "$arch-apple-macos13" packaging/macos/Launcher.swift -o "$WORK/launcher-$arch"
    done
    lipo -create "$WORK/launcher-arm64" "$WORK/launcher-x86_64" -output "$app/Contents/MacOS/BMW Service Manager"
    sed "s/{{VERSION}}/$VERSION/g" packaging/macos/Info.plist > "$app/Contents/Info.plist"
    cp packaging/macos/AppIcon.icns "$app/Contents/Resources/"
    cp -R "$WORK/app" "$app/Contents/Resources/app"
    for r in macos-arm64 macos-x86_64; do
        [ -d "$WORK/runtimes/$r" ] || fetch "$r"
        cp -R "$WORK/runtimes/$r" "$app/Contents/Resources/runtime/$r"
    done
    codesign --force --deep --sign - "$app"  # ad hoc: Apple silicon runs only signed code
    sed "s/{{VERSION}}/$VERSION/g" packaging/launchers/README-macOS.txt > "$stage/READ ME FIRST.txt"
    cp packaging/readme/LICENSE.md "$stage/LICENSE.md"
    rm -f "dist/$NAME-macOS.zip"
    (cd "$stage" && zip -qryX "$OLDPWD/dist/$NAME-macOS.zip" "BMW Service Manager.app" "READ ME FIRST.txt" LICENSE.md)
    sed "s/{{VERSION}}/$VERSION/g" packaging/macos/install-mac.sh > dist/install-mac.sh
    chmod +x dist/install-mac.sh
    ls -l "dist/$NAME-macOS.zip" dist/install-mac.sh
}

app
for t in $TARGETS; do
    case "$t" in
        macOS) bundle_mac ;;
        Windows) bundle Windows windows-x86_64 ;;
        Linux) bundle Linux linux-x86_64 linux-aarch64 ;;
        *) echo "unknown target $t (macOS, Windows or Linux)"; exit 1 ;;
    esac
done
