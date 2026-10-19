#!/bin/bash
# Builds the standalone downloads, each with its own Python, into dist/:
#   BMW-Service-Manager-macOS.zip       Apple silicon and Intel
#   BMW-Service-Manager-Windows.zip     64-bit (x64; also runs on Windows on ARM)
#   BMW-Service-Manager-Linux.tar.gz    x86_64 and aarch64 (glibc)
# Runs on a Mac or Linux (x86_64 or arm64) with curl, tar and zip; no Python needed.
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
    cp "packaging/launchers/README-$os.txt" "$dir/READ ME FIRST.txt"
    case "$os" in
        macOS) cp packaging/launchers/*.command "$dir/" ;;
        Windows) cp packaging/launchers/*.bat "$dir/" ;;
        Linux) cp packaging/launchers/*.sh "$dir/" ;;
    esac
    (cd "$WORK/out/$os" && case "$os" in
        Linux) rm -f "$OLDPWD/dist/BMW-Service-Manager-Linux.tar.gz"; COPYFILE_DISABLE=1 tar --no-xattrs $TAR_ANON -czf "$OLDPWD/dist/BMW-Service-Manager-Linux.tar.gz" "BMW Service Manager" ;;
        *) rm -f "$OLDPWD/dist/BMW-Service-Manager-$os.zip"; zip -qryX "$OLDPWD/dist/BMW-Service-Manager-$os.zip" "BMW Service Manager" ;;
    esac)
    ls -l dist/BMW-Service-Manager-"$os".*
}

app
for t in $TARGETS; do
    case "$t" in
        macOS) bundle macOS macos-arm64 macos-x86_64 ;;
        Windows) bundle Windows windows-x86_64 ;;
        Linux) bundle Linux linux-x86_64 linux-aarch64 ;;
        *) echo "unknown target $t (macOS, Windows or Linux)"; exit 1 ;;
    esac
done
