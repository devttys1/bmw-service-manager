#!/bin/bash
# Double-click to start BMW Service Manager. Leave this window open while you use it.
cd "$(dirname "$0")" || exit 1
# macOS marks downloaded files as quarantined. You've allowed this launcher to open,
# so clear the mark from the rest of this folder (its own copy of Python).
xattr -dr com.apple.quarantine . 2>/dev/null
# Apple silicon (M1 and later), even in a Terminal running under Rosetta, or Intel.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
    PY="runtime/macos-arm64/python/bin/python3"
else
    PY="runtime/macos-x86_64/python/bin/python3"
fi
"$PY" -I -u app/start.py "$@"
status=$?
if [ $status -ne 0 ]; then
    echo
    echo "BMW Service Manager stopped with an error (above)."
    read -r -p "Press Return to close this window. " _
fi
exit $status
