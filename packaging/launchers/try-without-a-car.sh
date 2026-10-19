#!/bin/sh
# Try BMW Service Manager with a pretend car (no cable needed).
exec "$(dirname "$0")/start-bmw-service-manager.sh" --simulate "$@"
