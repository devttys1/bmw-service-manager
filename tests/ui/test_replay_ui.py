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
