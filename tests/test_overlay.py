"""Video Overlay's page and the files it needs (its workings are tested in tests/ui/test_overlay_ui.py)."""

from pathlib import Path

from bmw_service_manager.web import create_app

FIXTURES = Path(__file__).parent / "fixtures"


def test_overlay_page_is_served_and_linked():
    client = create_app().test_client()
    page = client.get("/overlay")
    assert page.status_code == 200 and b"Video Overlay" in page.data
    for path in ["/static/overlay/overlay.js", "/static/overlay/mp4.js", "/static/overlay/gpmf.js", "/static/overlay/sync.js",
                 "/static/overlay/render.js", "/static/overlay/export.js", "/static/vendor/mp4-muxer.mjs",
                 "/static/vendor/LICENSE-mp4-muxer.txt", "/static/overlay.css"]:
        assert client.get(path).status_code == 200, path
    assert b'href="/overlay"' in client.get("/").data
    assert b'href="/overlay"' in client.get("/replay").data


def test_gopro_fixture_has_its_telemetry_track():
    data = (FIXTURES / "gopro-hero6-gps.mp4").read_bytes()
    assert len(data) < 200_000, "keep the fixture small"
    assert b"gpmd" in data and b"GPS5" in data and b"GPSU" in data
