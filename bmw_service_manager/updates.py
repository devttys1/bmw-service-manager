"""Whether a newer Boostbook for Desktop is out: the public releases page, asked at most once a day.

Nothing is installed: the page shows a line with a link to the download. The check sends no
identifiers (no VIN, no address), only a request for the latest release with a plain user agent.
It's off when the viewer turns it off on the page (Advanced > Check for updates) or when
BOOSTBOOK_NO_UPDATE_CHECK is set.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable

RELEASES = "https://github.com/devttys1/boostbook-for-desktop/releases/latest"
LATEST_API = "https://api.github.com/repos/devttys1/boostbook-for-desktop/releases/latest"
DAY = 24 * 3600


def cache_file() -> Path:
    """Where the last answer is kept, so the check runs at most once a day."""
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "Boostbook for Desktop" / "update.json"


def version_tuple(v: str) -> tuple[int, ...]:
    """'v1.4.0' -> (1, 4, 0); anything after the numbers (1.5.0-beta) is ignored."""
    m = re.match(r"v?(\d+(?:\.\d+)*)", v.strip())
    return tuple(int(p) for p in m.group(1).split(".")) if m else ()


def fetch_latest(current: str) -> str:
    """The latest release's tag, from GitHub's API."""
    req = urllib.request.Request(LATEST_API, headers={
        "Accept": "application/vnd.github+json", "User-Agent": f"Boostbook-for-Desktop/{current}"})
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.load(res)["tag_name"]


def check(current: str, *, path: Path | None = None, now: float | None = None,
          fetch: Callable[[str], str] = fetch_latest) -> dict:
    """{state: "newer" | "current" | "off" | "unknown", current, latest, url}."""
    out = {"current": current, "latest": None, "url": RELEASES}
    if os.environ.get("BOOSTBOOK_NO_UPDATE_CHECK"):
        return {**out, "state": "off"}
    path = path or cache_file()
    now = time.time() if now is None else now
    latest = None
    try:
        cached = json.loads(path.read_text())
        if now - cached["checked"] < DAY:
            latest = cached["latest"]
    except (OSError, ValueError, KeyError, TypeError):
        pass
    if latest is None:
        try:
            latest = fetch(current)
        except Exception:  # offline, rate-limited, GitHub changed: say nothing rather than fail
            return {**out, "state": "unknown"}
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({"checked": now, "latest": latest}))
        except OSError:
            pass
    newer = version_tuple(latest) > version_tuple(current)
    return {**out, "latest": latest.lstrip("v"), "state": "newer" if newer else "current"}
