"""Drive Replay in a real browser (Playwright + Chromium) with the sample drive.

Map imagery and terrain come from the internet; the checks here don't depend on them.
"""

import gzip
import json
import threading
from pathlib import Path

import pytest

pytest.importorskip("playwright")

from playwright.sync_api import Page, expect  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from bmw_service_manager.web import create_app  # noqa: E402

# A BLE CAN Logger session, as on its USB drive (tests/fixtures/README.md).
BLR = Path(__file__).parent.parent / "fixtures/LOG_00042_20261111-0805.BLR"


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
    # The simulator's X1 (F48, Alpine White) is drawn as the X1 model, credited.
    expect(page.locator("#car-credit")).to_contain_text("2020 BMW X1 xDrive 18d by Ddiaz Design, CC BY-NC-SA 4.0", timeout=20000)
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


def test_opens_a_logger_session(replay: Page, tmp_path):
    """A .BLR straight from the logger plays as the iOS app imports it (#31)."""
    replay.set_input_files("#open2", str(BLR))
    replay.wait_for_function("window.replay?.state.drive", timeout=20000)
    expect(replay.locator("#player")).to_be_visible()
    expect(replay.locator("#drive-name")).to_contain_text("(logger)")
    drive = replay.evaluate("""() => { const d = window.replay.state.drive;
        return { fixes: d.raw.gps.length, duration: d.duration, started: d.started.toISOString(), source: d.header.source,
                 channels: d.raw.channels.map((c) => c.name), readings: d.raw.car.length, notes: d.raw.notes.map((n) => n.text) }; }""")
    assert drive["fixes"] == 20 and abs(drive["duration"] - 21) < 0.1
    assert drive["started"] == "2026-11-11T08:05:00.000Z", "the GPS's time"
    assert drive["source"] == {"device": "ble-can-logger", "file": BLR.name, "session": 42, "firmware": "0.1.0"}
    assert set(drive["channels"]) == {"RPM", "Speed", "Coolant", "Throttle", "Battery"} and 100 <= drive["readings"] <= 120
    assert "Part of the log was lost (a bad storage block)" in drive["notes"]
    assert "3 of the logger's records are missing" in drive["notes"] and "6 damaged bytes in the logger's file were skipped" in drive["notes"]
    # Saved as a drive log: gzipped, and it opens again as the same drive.
    with replay.expect_download() as saved:
        replay.click("#export-bblog")
    assert saved.value.suggested_filename.endswith("(logger).bblog.gz")
    lines = gzip.decompress(Path(saved.value.path()).read_bytes()).decode().splitlines()
    assert json.loads(lines[0])["source"]["device"] == "ble-can-logger" and sum('"gps"' in line for line in lines[1:]) == 20
    assert "SAMPLE001" not in "".join(lines), "no VIN"
    copy = tmp_path / saved.value.suggested_filename
    copy.write_bytes(Path(saved.value.path()).read_bytes())
    replay.set_input_files("#open", str(copy))
    replay.wait_for_function("window.replay.state.drive.raw.gps.length === 20 && window.replay.state.drive.raw.car.length > 99")
    # Without the session header (its first page lost), by its name: the same drive.
    cut = tmp_path / BLR.name.lower()
    cut.write_bytes(BLR.read_bytes()[64:])
    replay.set_input_files("#open", str(cut))
    replay.wait_for_function("window.replay.state.drive.header.source.file !== " + repr(BLR.name), timeout=20000)
    assert replay.evaluate("window.replay.state.drive.raw.gps.length") == 20
    # A session with no fix says so.
    nofix = tmp_path / "LOG_00043_NOTIME.BLR"
    nofix.write_bytes(BLR.read_bytes()[:64])
    replay.set_input_files("#open", str(nofix))
    expect(replay.locator("#load-error")).to_contain_text("logger session has no GPS fixes")


def test_cars_get_their_own_model(replay: Page):
    """A log's chassis picks the model: its own, else the nearest, else its series."""
    picks = replay.evaluate("""async () => {
        const m = await import("/static/replay/car3d.js");
        const cars = [{ model: "X5 xDrive30d (G05)" }, { model: "X3", chassis: "G045" }, { model: "3 Series 320d (F30 LCI)" },
                      { model: "X1 sDrive18i (U11)" }, { model: "5 Series" }, { model: "i3 (I01)" }, {}];
        return Promise.all(cars.map(async (c) => { const e = await m.modelFor(c); return e && [e.file, e.exact]; }));
    }""")
    assert picks == [["x5-g05.glb", True], ["x3-g01.glb", False], ["m3-f80.glb", False], ["x1-f48.glb", False],
                     ["m5-f90.glb", False], None, None]


def test_pick_another_car(replay: Page):
    """The log's car by default; any model from the list, with its picture; the log's again."""
    page = replay
    page.click("#sample2")
    expect(page.locator("#car-pick-btn")).to_contain_text("X1 F48", timeout=20000)
    page.click("#play")  # pause
    page.click("#car-pick-btn")
    options = page.locator("#car-list li")
    expect(options).to_have_count(34)  # the log's car, 32 models, the simple car
    expect(options.first).to_contain_text("X1 xDrive18d (F48): X1 F48")
    expect(options.first).to_have_attribute("aria-selected", "true")
    page.wait_for_function("[...document.querySelectorAll('#car-list img')].slice(0, 8).every((i) => i.complete && i.naturalWidth > 0)")
    page.locator("#car-list li", has_text="2023 BMW M2 G87").click()
    expect(page.locator("#car-list")).to_be_hidden()
    expect(page.locator("#car-pick-btn")).to_contain_text("M2 G87")
    expect(page.locator("#car-credit")).to_contain_text("2023 BMW M2 G87 Coupé by Ddiaz Design", timeout=20000)
    page.wait_for_function("window.replay.state.view.car.model?.chassis === 'G87'")
    # The dials show its outline: a coupé is long and low from the side.
    side = page.evaluate("(({ width, height }) => [width, height])(window.replay.state.view.shapes.side)")
    assert 4.3 < side[0] < 4.8 and 1.2 < side[1] < 1.6, side
    # By keyboard, back to the log's car.
    page.focus("#car-pick-btn")
    page.keyboard.press("ArrowDown")
    page.keyboard.press("Home")
    page.keyboard.press("Enter")
    expect(page.locator("#car-pick-btn")).to_contain_text("X1 F48")
    page.wait_for_function("window.replay.state.view.car.model?.chassis === 'F48'")


def test_panes_resize(replay: Page):
    """Drag the side panel, the chart and the car view; the sizes are kept; double-click resets."""
    page = replay
    page.click("#sample2")
    page.wait_for_function("window.replay?.state.drive", timeout=20000)
    page.click("#play")  # pause

    def drag(handle, dx, dy):
        box = page.locator(handle).bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        page.mouse.move(x, y)
        page.mouse.down()
        page.mouse.move(x + dx / 2, y + dy / 2)
        page.mouse.move(x + dx, y + dy)
        page.mouse.up()

    width = lambda s: page.locator(s).bounding_box()["width"]  # noqa: E731
    height = lambda s: page.locator(s).bounding_box()["height"]  # noqa: E731
    side, chart, car, stage = width(".side"), height("#chart"), height(".car-panel"), height(".stage")
    drag("#split-side", -100, 0)
    drag("#split-chart", 0, -80)
    drag("#split-car", 0, 60)
    assert abs(width(".side") - (side + 100)) < 3
    assert abs(height("#chart") - (chart + 80)) < 3 and height(".stage") < stage - 70
    assert abs(height(".car-panel") - (car + 60)) < 3
    page.reload()
    page.click("#sample2")
    page.wait_for_function("window.replay?.state.drive", timeout=20000)
    assert abs(width(".side") - (side + 100)) < 3, "kept"
    page.dblclick("#split-side")
    assert abs(width(".side") - side) < 3


def test_turning_the_close_up_while_paused(replay: Page):
    """Dragging the close-up turns its camera and draws it again, paused or not."""
    page = replay
    page.click("#sample2")
    page.wait_for_function("window.replay?.state.drive", timeout=20000)
    page.click("#play")  # pause
    page.wait_for_function("window.replay.state.view.car.model && window.replay.state.mapReady", timeout=20000)
    page.evaluate("""() => {
        const v = window.replay.state.view;
        window.renders = 0;
        const render = v.render.bind(v);
        v.render = (...a) => { window.renders++; return render(...a); };
    }""")
    # Idle while paused: nothing draws it until something changes.
    page.wait_for_timeout(500)
    assert page.evaluate("window.renders") == 0
    before = page.evaluate("window.replay.state.view.camera.position.toArray()")
    box = page.locator("#car-view canvas").bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + 40, y + 10)
    page.mouse.move(x + 80, y + 20)
    page.mouse.up()
    page.wait_for_timeout(100)
    assert page.evaluate("window.replay.state.view.camera.position.toArray()") != before
    assert page.evaluate("window.renders") > 0, "drawn again while paused"


def test_gps_lag_is_taken_off(replay: Page):
    """An iPhone's GPS gives each fix out late: found against the gyro and the car's speed."""
    lags = replay.evaluate("""async () => {
        const m = await import("/static/replay/drivelog.js");
        const text = await m.readLog(await fetch("/static/sample-drive.bblog.gz"));
        const late = (s, drop) => {
            const raw = m.parseLog(text);
            raw.gps.forEach((g) => { g[0] += s; });
            if (drop === "car") raw.car = [];
            if (drop === "motion") raw.motion = [];
            return m.processLog(raw).gpsLag;
        };
        return [late(0), late(1.9), late(1.9, "car"), late(1.2, "motion"), late(0, "motion")];
    }""")
    assert lags == [0, 1.9, 1.9, 1.2, 0], lags


def test_old_iphone_logs_turn_the_acceleration_round(replay: Page):
    """A real iPhone's log from before "accel": "car" has Core Motion's acceleration, the other way round."""
    signs = replay.evaluate("""async () => {
        const m = await import("/static/replay/drivelog.js");
        const text = await m.readLog(await fetch("/static/sample-drive.bblog.gz"));
        const lines = text.split("\\n"), header = JSON.parse(lines[0]);
        const as = (h) => m.parseLog([JSON.stringify({ ...header, ...h }), ...lines.slice(1)].join("\\n"));
        const sample = m.parseLog(text), old = as({ simulated: false }), fixed = as({ simulated: false, accel: "car" });
        const k = sample.motion.findIndex((r) => Math.abs(r[4]) > 0.01);
        return [old.motion[k][4] / sample.motion[k][4], fixed.motion[k][4] / sample.motion[k][4],
                old.end.forward[0] / sample.end.forward[0], old.motion[k][1] / sample.motion[k][1]];
    }""")
    assert signs == [-1, 1, -1, 1]


def test_xdrive_torque_is_worked_out(replay: Page):
    """xDrive passes the smaller of what its clutch is set to carry and its axle's share of the road's torque."""
    result = replay.evaluate("""async () => {
        const m = await import("/static/replay/drivelog.js");
        const text = await m.readLog(await fetch("/static/sample-drive.bblog.gz"));
        const run = (fixed) => {
            const raw = m.parseLog(text);
            if (fixed) raw.car.forEach(([, v]) => { if (v["Rear axle"] !== undefined) v["Rear axle"] = fixed; });
            const d = m.processLog(raw);
            const set = d.byName["Rear axle"].values, est = d.byName["xDrive (est.)"].values, all = d.byName["All wheels (est.)"].values;
            let kept = 0, n = 0, over = 0;
            for (let i = 0; i < d.n; i++) {
                if (!(set[i] > 50) || !Number.isFinite(est[i])) continue;
                n++; kept += est[i] / set[i];
                if (est[i] > set[i] + 0.5 || est[i] > Math.max(0, all[i]) * 0.8 + 0.5) over++;
            }
            return { kept: kept / n, over, chassis: d.figures.chassis };
        };
        return [run(), run(3000)];
    }""")
    real, high = result
    assert real["chassis"] == "F48"
    # The simulator's figure is what its clutch passes: the estimate keeps it.
    assert real["kept"] > 0.95 and real["over"] == 0, real
    # Set to 3,000 Nm, far more than the road could take: the axle's share of it is what passes.
    assert high["kept"] < 0.2 and high["over"] == 0, high


def test_phone_layout(replay: Page):
    """#39: on a phone either way up, one screen that doesn't scroll: the map, play and the
    timeline, and a panel of tabs; the chart moves into its tab and back on a wide window."""
    page = replay
    page.set_viewport_size({"width": 390, "height": 760})
    page.click("#sample2")
    page.wait_for_function("window.replay?.state.drive", timeout=20000)
    page.click("#play")  # pause
    no_scroll = "document.scrollingElement.scrollHeight <= innerHeight + 1 && document.scrollingElement.scrollWidth <= innerWidth + 1"
    assert page.evaluate("document.body.classList.contains('compact')")
    assert page.evaluate(no_scroll), "nothing to scroll"
    # The chart's tab first, with the chart and its values to pick in it.
    expect(page.locator('.tabs button[data-tab="chart"]')).to_have_attribute("aria-selected", "true")
    expect(page.locator("#tab-chart #chart")).to_be_visible()
    expect(page.locator("#tab-chart #chips .chip.on").first).to_be_visible()
    expect(page.locator(".car-panel")).to_be_hidden()
    # The map's settings fold away.
    expect(page.locator("#basemap")).to_be_hidden()
    page.click("#map-more")
    expect(page.locator("#basemap")).to_be_visible()
    # The car's tab: the close-up and its dials, and the chart hidden.
    page.click('.tabs button[data-tab="car"]')
    expect(page.locator(".car-panel")).to_be_visible()
    expect(page.locator("#incline")).to_be_visible()
    expect(page.locator("#chart")).to_be_hidden()
    assert page.locator(".car-view canvas").bounding_box()["height"] > 100
    # Laps play from their row, as on a computer.
    page.click('.tabs button[data-tab="laps"]')
    page.locator("#laps tr[data-lap]").nth(1).click()
    page.wait_for_timeout(300)
    expect(page.locator("#hud-lap-n")).to_contain_text("Lap 2/2")
    page.click("#play")
    # On its side: the panel beside the map, still one screen; the tab kept.
    page.set_viewport_size({"width": 844, "height": 390})
    page.wait_for_timeout(200)
    assert page.evaluate("document.body.classList.contains('landscape')")
    assert page.evaluate(no_scroll)
    side, stage = page.locator(".side").bounding_box(), page.locator(".stage").bounding_box()
    assert side["x"] >= stage["x"] + stage["width"] - 1, "the panel is to the right of the map"
    expect(page.locator('.tabs button[data-tab="laps"]')).to_have_attribute("aria-selected", "true")
    # A wide window again: the desktop's layout, the chart back under the timeline.
    page.set_viewport_size({"width": 1400, "height": 900})
    page.wait_for_timeout(200)
    assert not page.evaluate("document.body.classList.contains('compact')")
    expect(page.locator(".transport #chart")).to_be_visible()
    expect(page.locator(".car-panel")).to_be_visible()
    expect(page.locator('.tabs button[data-tab="chart"]')).to_be_hidden()
    expect(page.locator('.tabs button[data-tab="laps"]')).to_have_attribute("aria-selected", "true")


def test_app_copy_shows_only_the_player(page: Page, tmp_path):
    """#39: the iOS app's copy (build_replay_site.py --app): no header or drop page, no car models
    to pick, no sample until the app asks; the app reads exports as text."""
    import functools
    import http.server
    import sys

    sys.path.insert(0, str(Path(__file__).parent.parent.parent / "tools"))
    import build_replay_site

    build_replay_site.build(tmp_path / "app", car_models="none", aerial=["NSW", "Queensland"], layout="folder",
                            hosted=True, embedded=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(tmp_path / "app"))
    handler.func.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.set_viewport_size({"width": 402, "height": 760})
    page.goto(f"http://127.0.0.1:{server.server_port}/index.html?demo=none")
    page.wait_for_function("window.replay")
    expect(page.locator(".replay-bar")).to_be_hidden()
    expect(page.locator("#sample2")).to_be_hidden()
    assert not page.evaluate("window.replay.state.drive"), "nothing opened by itself"
    page.evaluate("window.replay.sample()")
    page.wait_for_function("window.replay.state.drive && window.replay.state.playing", timeout=20000)
    expect(page.locator("#car-pick")).to_be_hidden()
    assert page.evaluate("window.replay.exportText('csv')").startswith("time_s,lat,lon")
    assert "<gx:Track>" in page.evaluate("window.replay.exportText('kml')")
    server.shutdown()
    assert not errors, f"JavaScript errors: {errors}"
