#!/bin/sh
# Starts Boostbook for Desktop. Leave the terminal open while you use it.
cd "$(dirname "$0")" || exit 1
case "$(uname -m)" in
    aarch64|arm64) PY="runtime/linux-aarch64/python/bin/python3" ;;
    *)             PY="runtime/linux-x86_64/python/bin/python3" ;;
esac
exec "$PY" -I -u app/start.py "$@"
