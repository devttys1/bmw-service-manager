"""Drive Replay as a static site: no Python server, any plain file host (WP-C1).

    python3 tools/build_replay_site.py [options] OUT

The page (static/replay.html) and everything it fetches, copied into OUT with its links made
relative. Nothing the page uses comes from web.py's API:

    what /replay fetches from web.py            on the static site
    /replay (the page)                          replay/index.html, its /static/ links made relative (./static/)
    /static/replay/*.js, style.css, replay.css   replay/static/…, as they are (they use relative URLs)
    /static/vendor/… (three.js, MapLibre, fonts) replay/static/vendor/…, with their licences
    /static/cars/models.json, *.glb, thumbs      replay/static/cars/…, only the models --car-models allows
    /static/sample-drive.bblog.gz                replay/static/sample-drive.bblog.gz
    / (service history), /overlay               not there: the links are taken off the page (HOSTED)
    /api/…                                       never used by the replay page

The page reads `window.REPLAY_SITE` (static/replay/site.js) for what this copy may show.

Options (the licences: docs/master-plan/workpacks/WP-C1-licences.md; the owner decides):
    --car-models all|by|none   the 32 models (all), only those under CC BY (by), or the drawn car
                               only (none). Default: none (most are CC BY-NC-SA, non-commercial).
    --aerial NSW,Queensland    the states' imagery it may use; "none" for Esri's only.
                               Default: NSW,Queensland (Tasmania's is non-commercial, no derivatives).
    --layout pages|folder      pages: OUT is a site root (index.html sends you to replay/, .nojekyll
                               for GitHub Pages). folder: OUT is only the replay/ folder, for the
                               store to serve at /replay/. Default: pages.
    --local                    every model and state, as the local app shows them (for comparing).
    --app                      the copy inside the iOS app (ios-app/tools/replay-site.sh): only the
                               player, no header or page to drop a file on (site.js EMBEDDED); the
                               app opens drives itself. The licence-safe set unless told otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "bmw_service_manager" / "static"
STATES = ["NSW", "Queensland", "Tasmania"]

# The page's files, relative to static/: what replay.html and its scripts load.
FILES = [
    "style.css", "replay.css", "boostbook-icon.svg", "sample-drive.bblog.gz",
    "vendor/three.module.min.js", "vendor/maplibre-gl.js", "vendor/maplibre-gl.css", "vendor/OrbitControls.js",
    "vendor/GLTFLoader.js", "vendor/BufferGeometryUtils.js", "vendor/RoomEnvironment.js", "vendor/meshopt_decoder.module.js",
    "vendor/LICENSE-three.txt", "vendor/LICENSE-maplibre.txt",
    "vendor/fonts/inter.woff2", "vendor/fonts/archivo.woff2", "vendor/fonts/ibm-plex-mono-500.woff2",
    "vendor/fonts/LICENSE-inter.txt", "vendor/fonts/LICENSE-archivo.txt", "vendor/fonts/LICENSE-ibmplexmono.txt",
    "cars/thumbs/simple.webp",
]


def model_licence(glb: Path) -> str:
    """The licence in a model's own extras (tools/car_model.py writes it on the `car` node)."""
    blob = glb.read_bytes()
    n = struct.unpack("<I", blob[12:16])[0]
    gltf = json.loads(blob[20:20 + n])
    car = next(node for node in gltf["nodes"] if node.get("name") == "car")
    return car["extras"]["license"]


def build(out: Path, *, car_models: str, aerial: list[str], layout: str, hosted: bool, embedded: bool = False) -> dict:
    site = out / "replay" if layout == "pages" else out
    if out.exists():
        shutil.rmtree(out)
    (site / "static" / "replay").mkdir(parents=True)

    for name in FILES:
        dest = site / "static" / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(STATIC / name, dest)
    for js in sorted((STATIC / "replay").glob("*.js")):
        shutil.copy2(js, site / "static" / "replay" / js.name)

    # The car models this copy may draw, and their credits (the README lists every model's licence).
    index = json.loads((STATIC / "cars" / "models.json").read_text())
    if car_models == "none":
        index = []
    elif car_models == "by":
        index = [e for e in index if re.fullmatch(r"CC BY \d\.\d", model_licence(STATIC / "cars" / e["file"]))]
    (site / "static" / "cars" / "models.json").write_text(json.dumps(index, indent=1) + "\n")
    for e in index:
        shutil.copy2(STATIC / "cars" / e["file"], site / "static" / "cars" / e["file"])
        thumb = Path("thumbs") / e["file"].replace(".glb", ".webp")
        shutil.copy2(STATIC / "cars" / thumb, site / "static" / "cars" / thumb)
    if index:
        shutil.copy2(STATIC / "cars" / "README.md", site / "static" / "cars" / "README.md")

    config = {"hosted": hosted, "carModels": bool(index), "aerial": aerial, "models": len(index)}
    if embedded:
        config["embedded"] = True
    page = (STATIC / "replay.html").read_text()
    # "./": an import map's addresses must start with /, ./ or ../ (a bare "static/…" is ignored).
    page = page.replace('"/static/', '"./static/').replace('href="/replay"', 'href="./"')
    marker = '<script type="importmap">'
    assert marker in page, "replay.html's import map moved"
    page = page.replace(marker, f"<script>window.REPLAY_SITE = {json.dumps(config)};</script>\n  {marker}", 1)
    # The credits on the first screen name only the imagery this copy uses.
    credit = "the NSW, Queensland and Tasmanian governments' aerial photos"
    assert credit in page, "replay.html's imagery credit moved"
    names = {"NSW": "NSW", "Queensland": "Queensland", "Tasmania": "Tasmanian"}
    states = [names[s] for s in STATES if s in aerial]
    said = (" and ".join([", ".join(states[:-1]), states[-1]] if len(states) > 1 else states))
    page = page.replace(credit + ", ", f"the {said} governments' aerial photos, " if states else "")
    if re.search(r'["\'(`]/(static|api)/', page):
        sys.exit("replay.html still has a server path after the rewrite")
    (site / "index.html").write_text(page)

    if layout == "pages":
        (out / ".nojekyll").write_text("")
        (out / "index.html").write_text(
            '<!doctype html><meta charset="utf-8"><title>Drive Replay</title>'
            '<meta http-equiv="refresh" content="0; url=replay/"><a href="replay/">Drive Replay</a>\n')
    check(site)
    return config


def check(site: Path) -> None:
    """No call to the Python server anywhere in what's built, and every file the page names is there."""
    for f in site.rglob("*"):
        if f.suffix in {".js", ".css", ".html"}:
            text = f.read_text(errors="replace")
            for bad in ('"/static/', "'/static/", "`/static/", "url(/static/", '"/api/', "`/api/", "'/api/"):
                if bad in text:
                    sys.exit(f"{f.relative_to(site)} calls the Python server ({bad})")
    page = (site / "index.html").read_text()
    for ref in re.findall(r'(?:href|src)="\./(static/[^"]+)"', page) + re.findall(r'"three": "\./(static/[^"]+)"', page):
        if not (site / ref).exists():
            sys.exit(f"index.html names {ref}, which isn't in the build")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("out", type=Path)
    p.add_argument("--car-models", choices=["all", "by", "none"], default="none")
    p.add_argument("--aerial", default="NSW,Queensland")
    p.add_argument("--layout", choices=["pages", "folder"], default="pages")
    p.add_argument("--local", action="store_true")
    p.add_argument("--app", action="store_true")
    a = p.parse_args(argv)
    aerial = [] if a.aerial == "none" else [s.strip() for s in a.aerial.split(",") if s.strip()]
    if unknown := set(aerial) - set(STATES):
        p.error(f"--aerial: {', '.join(sorted(unknown))}; choose from {', '.join(STATES)}")
    if a.local:
        a.car_models, aerial = "all", STATES
    if a.app:
        a.layout = "folder"
    config = build(a.out, car_models=a.car_models, aerial=aerial, layout=a.layout, hosted=True, embedded=a.app)
    size = sum(f.stat().st_size for f in a.out.rglob("*") if f.is_file())
    print(f"built {a.out} ({size / 1e6:.1f} MB): {config['models']} car models, imagery {', '.join(aerial) or 'Esri only'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
