"""Drive Replay in a real browser (Playwright + Chromium) with the sample drive.

Map imagery and terrain come from the internet; the checks here don't depend on them.
"""

import threading

import pytest

pytest.importorskip("playwright")

from playwright.sync_api import Page, expect  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from bmw_service_manager.web import create_app  # noqa: E402


@pytest.fixture
def replay(page: Page):
    web = make_server("127.0.0.1", 0, create_app(), threaded=True)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(f"http://127.0.0.1:{web.server_port}/replay")
    yield page
    web.shutdown()
    assert not errors, f"JavaScript errors: {errors}"


def test_sample_drive_plays(replay: Page):
    page = replay
    expect(page.locator("#empty")).to_be_visible()
    page.click("#sample2")
    page.wait_for_function("window.replay?.state.drive", timeout=20000)
    expect(page.locator("#player")).to_be_visible()
    expect(page.locator("#drive-name")).to_contain_text("Mount Panorama")
    # It plays: the clock moves.
    page.wait_for_function("window.replay.state.t > 1", timeout=10000)
    page.click("#play")  # pause
    # Two laps of Mount Panorama, the flying one the best, a little over three minutes.
    page.click('.tabs button[data-tab="laps"]')
    rows = page.locator("#laps tr[data-lap]")
    expect(rows).to_have_count(2)
    expect(page.locator("#laps tr.best")).to_contain_text("3:0")
    # Seek: down the hill on Conrod Straight, the HUD and values follow.
    page.evaluate("window.replay.seek(152)")
    page.wait_for_timeout(300)
    assert int(page.locator("#hud-speed").inner_text()) > 180
    expect(page.locator("#hud-lap-n")).to_contain_text("Lap 1/2")
    # Pulling away from the line, xDrive sends hundreds of Nm to the rear axle.
    page.evaluate("window.replay.seek(5.5)")
    page.wait_for_timeout(300)
    assert int(page.locator("#hud-xdrive").inner_text().split()[0]) > 400
    # Lap 2 from the table.
    rows.nth(1).click()
    page.wait_for_timeout(300)
    expect(page.locator("#hud-lap-n")).to_contain_text("Lap 2/2")
    # Exports.
    with page.expect_download() as kml:
        page.click("#export-kml")
    assert kml.value.suggested_filename.endswith(".kml")
    text = open(kml.value.path(), encoding="utf-8").read()
    assert "<gx:Track>" in text and "<gx:angles>" in text and "Lap 2" in text
    with page.expect_download() as csv:
        page.click("#export-csv")
    header = open(csv.value.path(), encoding="utf-8").readline()
    assert header.startswith("time_s,lat,lon") and "Rear axle (Nm)" in header


def test_not_a_drive_log(replay: Page, tmp_path):
    bad = tmp_path / "notes.bblog"
    bad.write_text('{"format": "stampbook-history"}\n')
    replay.set_input_files("#open2", str(bad))
    expect(replay.locator("#load-error")).to_contain_text("isn't a Boostbook drive log")
