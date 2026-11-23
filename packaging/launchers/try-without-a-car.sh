#!/bin/sh
# Try Boostbook for Desktop with a pretend car (no cable needed).
exec "$(dirname "$0")/start-boostbook.sh" --simulate "$@"
