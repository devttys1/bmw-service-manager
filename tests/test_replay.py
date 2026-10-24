"""Drive Replay's page and its sample drive (a log from the iOS app's Logger, simulated)."""

import gzip
import json
import struct
from pathlib import Path

from bmw_service_manager.web import create_app

STATIC = Path(__file__).parent.parent / "bmw_service_manager" / "static"


def test_replay_page_is_served():
    client = create_app().test_client()
    page = client.get("/replay")
    assert page.status_code == 200 and b"Drive Replay" in page.data
    for path in ["/static/replay/replay.js", "/static/replay/drivelog.js", "/static/vendor/three.module.min.js",
                 "/static/vendor/maplibre-gl.js", "/static/vendor/OrbitControls.js", "/static/vendor/GLTFLoader.js",
                 "/static/vendor/BufferGeometryUtils.js", "/static/vendor/RoomEnvironment.js",
                 "/static/vendor/meshopt_decoder.module.js", "/static/cars/models.json", "/static/cars/x1-f48.glb",
                 "/static/cars/thumbs/x1-f48.webp", "/static/cars/thumbs/simple.webp"]:
        assert client.get(path).status_code == 200, path
    assert b'href="/replay"' in client.get("/").data, "the service history page links to it"


def test_sample_drive_is_a_drive_log():
    lines = gzip.decompress((STATIC / "sample-drive.bblog.gz").read_bytes()).decode().splitlines()
    header = json.loads(lines[0])
    assert header["format"] == "boostbook-drive" and header["version"] == 1
    assert header["car"]["xdrive"] == "rear" and header["car"]["driven"] == "front"
    assert header["car"]["chassis"] == "F48" and header["car"]["paint"] == "300", "the page draws its own car"
    rows = [json.loads(line) for line in lines[1:]]
    kinds = {k for r in rows for k in r if k != "t"}
    assert {"m", "gps", "baro", "channels", "car", "end"} <= kinds
    assert all(len(r["m"]) == len(header["fields"]["motion"]) for r in rows if "m" in r)
    assert all(len(r["gps"]) == len(header["fields"]["gps"]) for r in rows if "gps" in r)
    channels = next(r["channels"] for r in rows if "channels" in r)
    assert all(len(r["car"]) == len(channels) for r in rows if "car" in r)
    assert rows[-1]["t"] > 400, "two laps and more"
    assert "vin" not in lines[0].lower()


def test_car_models_are_in_the_cars_axes_and_credited():
    """Every model in models.json (what car3d.js picks from): the nodes it looks for, its size,
    the roles of its materials, and its credit (their CC licences ask for it)."""
    index = json.loads((STATIC / "cars/models.json").read_text())
    assert len(index) > 30
    readme = (STATIC / "cars/README.md").read_text()
    codes = [c for entry in index for c in entry["chassis"] + entry["near"]]
    assert len(codes) == len(set(codes)), "each chassis picks one model"
    for entry in index:
        name = entry["file"]
        blob = (STATIC / "cars" / name).read_bytes()
        n = struct.unpack("<I", blob[12:16])[0]
        gltf = json.loads(blob[20:20 + n])
        nodes = {node.get("name"): node for node in gltf["nodes"]}
        car = nodes["car"]["extras"]
        assert {"title", "author", "source", "license", "chassis"} <= set(car), name
        assert car["title"] == entry["title"] and name in readme and entry["title"] in readme
        assert 2.4 < car["wheelbase"] < 3.3 and 1.4 < car["track"] < 1.8 and 0.3 < car["wheelRadius"] < 0.42, name
        for corner, (fx, ly) in {"FL": (1, 1), "FR": (1, -1), "RL": (-1, 1), "RR": (-1, -1)}.items():
            x, y, z = nodes[f"wheel_{corner}"]["translation"]
            assert x * fx > 1 and y * ly > 0.6 and abs(z - car["wheelRadius"]) < 0.03, (name, corner)
        roles = {m.get("extras", {}).get("role") for m in gltf["materials"]}
        assert {"paint", "tyre"} <= roles, name
        assert "EXT_meshopt_compression" in gltf["extensionsRequired"], name
        thumb = STATIC / "cars/thumbs" / name.replace(".glb", ".webp")
        assert thumb.read_bytes()[8:12] == b"WEBP", f"{name} has its picture for the car list (tools/car_thumbs.py)"
    assert sum((STATIC / "cars" / e["file"]).stat().st_size for e in index) < 40e6, "the web app download stays small"
