#!/bin/bash
# Double-click to try BMW Service Manager with a pretend car (no cable needed).
exec "$(dirname "$0")/Start BMW Service Manager.command" --simulate "$@"
