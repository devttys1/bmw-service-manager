#!/bin/bash
# Drive Replay as a static site (WP-C1): see tools/build_replay_site.py for the options.
#   tools/build-replay-site.sh dist/replay-site                     GitHub Pages layout, licence-safe defaults
#   tools/build-replay-site.sh --layout folder dist/store-replay    a folder the store serves at /replay/
# Then serve it with any plain file server, e.g. python3 -m http.server -d dist/replay-site
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -I tools/build_replay_site.py "$@"
