"""Drive Replay as a static site (tools/build_replay_site.py, WP-C1), and its .BLR reader in the
browser (static/replay/blr.js, tested in Node by tests/js)."""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build_replay_site  # noqa: E402


def test_hosted_build_has_no_server_calls_and_only_safe_assets(tmp_path):
    out = tmp_path / "site"
    config = build_replay_site.build(out, car_models="none", aerial=["NSW", "Queensland"], layout="pages", hosted=True)
    site = out / "replay"
    page = (site / "index.html").read_text()
    assert config == {"hosted": True, "carModels": False, "aerial": ["NSW", "Queensland"], "models": 0}
    assert "window.REPLAY_SITE = " in page and '"three": "./static/vendor/three.module.min.js"' in page
    assert not re.search(r'["\'(`]/(static|api)/', page), "no absolute server paths"
    assert "Tasmanian" not in page, "the credits name only the imagery used"
    assert not list((site / "static" / "cars").glob("*.glb")), "no non-commercial car models"
    assert json.loads((site / "static" / "cars" / "models.json").read_text()) == []
    assert (out / ".nojekyll").exists() and "url=replay/" in (out / "index.html").read_text()
    assert sum(f.stat().st_size for f in out.rglob("*") if f.is_file()) < 5e6
    for js in (site / "static" / "replay").glob("*.js"):
        assert "/static/" not in js.read_text(), f"{js.name} must use relative URLs (site.js asset())"


def test_app_copy_is_embedded(tmp_path):
    """#39: the iOS app's copy says so (site.js EMBEDDED) and has the licence-safe set."""
    config = build_replay_site.build(tmp_path / "a", car_models="none", aerial=["NSW", "Queensland"], layout="folder",
                                     hosted=True, embedded=True)
    assert config["embedded"] is True and config["models"] == 0
    assert '"embedded": true' in (tmp_path / "a" / "index.html").read_text()
    assert (tmp_path / "a" / "static" / "sample-drive.bblog.gz").exists(), "the sample, for Watch the sample drive"


def test_cc_by_models_only(tmp_path):
    config = build_replay_site.build(tmp_path / "f", car_models="by", aerial=[], layout="folder", hosted=True)
    index = json.loads((tmp_path / "f" / "static" / "cars" / "models.json").read_text())
    assert config["models"] == len(index) >= 1
    for e in index:
        assert build_replay_site.model_licence(tmp_path / "f" / "static" / "cars" / e["file"]).startswith("CC BY ")
    assert "governments' aerial photos" not in (tmp_path / "f" / "index.html").read_text()


# The schema and the shared fixture live with the iOS app; the public web app's copy has neither
# (tools/publish-web.sh copies only the web app), so these two run here only.
IOS = ROOT / "ios-app" / "tools"


@pytest.mark.skipif(not IOS.exists(), reason="needs the iOS app's tools (not in the public copy)")
def test_blr_schema_js_is_current():
    subprocess.run([sys.executable, "-I", str(ROOT / "ios-app/tools/blr/gen_blr.py"), "--check"], check=True)


@pytest.mark.skipif(shutil.which("node") is None or not IOS.exists(), reason="needs Node.js and the shared .BLR fixture")
def test_blr_reader_in_node():
    tests = sorted(str(p) for p in (ROOT / "tests" / "js").glob("*.test.mjs"))
    r = subprocess.run(["node", "--test", *tests], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-2000:]


def test_update_check_asks_at_most_once_a_day(tmp_path, monkeypatch):
    from bmw_service_manager import updates

    monkeypatch.delenv("BOOSTBOOK_NO_UPDATE_CHECK", raising=False)
    asked = []
    fetch = lambda current: asked.append(current) or "v1.5.0"  # noqa: E731
    cache = tmp_path / "update.json"
    first = updates.check("1.4.0", path=cache, now=1000, fetch=fetch)
    assert first["state"] == "newer" and first["latest"] == "1.5.0" and first["url"].startswith("https://github.com/")
    assert updates.check("1.4.0", path=cache, now=1000 + 3600, fetch=fetch)["state"] == "newer"
    assert len(asked) == 1, "the second check within a day uses the cached answer"
    updates.check("1.4.0", path=cache, now=1000 + updates.DAY + 1, fetch=fetch)
    assert len(asked) == 2
    assert updates.check("1.5.0", path=cache, now=1000 + updates.DAY + 2, fetch=fetch)["state"] == "current"
    assert updates.version_tuple("v1.10.0") > updates.version_tuple("1.9.3")

    def offline(_):
        raise OSError("no network")
    assert updates.check("1.4.0", path=tmp_path / "other.json", now=0, fetch=offline)["state"] == "unknown"
    monkeypatch.setenv("BOOSTBOOK_NO_UPDATE_CHECK", "1")
    assert updates.check("1.4.0", path=cache, fetch=fetch)["state"] == "off"
