"""Drive Replay's page and its sample drive (a log from the iOS app's Logger, simulated)."""

import gzip
import json
from pathlib import Path

from bmw_service_manager.web import create_app

STATIC = Path(__file__).parent.parent / "bmw_service_manager" / "static"


def test_replay_page_is_served():
    client = create_app().test_client()
    page = client.get("/replay")
    assert page.status_code == 200 and b"Drive Replay" in page.data
    for path in ["/static/replay/replay.js", "/static/replay/drivelog.js", "/static/vendor/three.module.min.js",
                 "/static/vendor/maplibre-gl.js", "/static/vendor/OrbitControls.js"]:
        assert client.get(path).status_code == 200, path
    assert b'href="/replay"' in client.get("/").data, "the service history page links to it"


def test_sample_drive_is_a_drive_log():
    lines = gzip.decompress((STATIC / "sample-drive.bblog.gz").read_bytes()).decode().splitlines()
    header = json.loads(lines[0])
    assert header["format"] == "boostbook-drive" and header["version"] == 1
    assert header["car"]["xdrive"] == "rear" and header["car"]["driven"] == "front"
    rows = [json.loads(line) for line in lines[1:]]
    kinds = {k for r in rows for k in r if k != "t"}
    assert {"m", "gps", "baro", "channels", "car", "end"} <= kinds
    assert all(len(r["m"]) == len(header["fields"]["motion"]) for r in rows if "m" in r)
    assert all(len(r["gps"]) == len(header["fields"]["gps"]) for r in rows if "gps" in r)
    channels = next(r["channels"] for r in rows if "channels" in r)
    assert all(len(r["car"]) == len(channels) for r in rows if "car" in r)
    assert rows[-1]["t"] > 400, "two laps and more"
    assert "vin" not in lines[0].lower()
