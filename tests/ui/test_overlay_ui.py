"""Video Overlay in a real browser (Playwright + Chromium): reading videos and GoPro telemetry,
lining a video up with a drive, and exporting it with the gauges burnt in.

The GoPro clip in tests/fixtures is cut from gopro/gpmf-parser's HERO6 sample (see its README).
The other test videos are made with ffmpeg as the tests run; those tests are skipped without it.
"""

import json
import re
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

pytest.importorskip("playwright")

from playwright.sync_api import Page, expect  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from bmw_service_manager.web import create_app  # noqa: E402

FIXTURES = Path(__file__).parent.parent / "fixtures"
GOPRO = FIXTURES / "gopro-hero6-gps.mp4"
BLR = FIXTURES / "LOG_00042_20261111-0805.BLR"
FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
needs_ffmpeg = pytest.mark.skipif(not (FFMPEG and FFPROBE), reason="needs ffmpeg and ffprobe")


@pytest.fixture
def overlay(page: Page):
    web = make_server("127.0.0.1", 0, create_app(), threaded=True)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(f"http://127.0.0.1:{web.server_port}/overlay")
    yield page
    web.shutdown()
    assert not errors, f"JavaScript errors: {errors}"


def make_video(path: Path, *, seconds=8, size="640x360", created="2026-10-24T00:02:20Z", codec="libx264", rotate=None):
    """A test-pattern video with a tone, made by ffmpeg; `created` is the file's creation time."""
    flat = path.with_suffix(".flat" + path.suffix) if rotate else path
    subprocess.run([
        FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", str(seconds),
        "-c:v", codec, *(["-tag:v", "hvc1"] if codec == "libx265" else []), "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-metadata", f"creation_time={created}", str(flat),
    ], check=True)
    if rotate:
        subprocess.run([FFMPEG, "-v", "error", "-y", "-display_rotation", str(rotate), "-i", str(flat), "-map", "0", "-c", "copy",
                        "-metadata", f"creation_time={created}", str(path)], check=True)
    return path


def probe(path) -> dict:
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames:format=duration",
                          "-of", "json", str(path)], check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def open_both(page: Page, video):
    page.set_input_files("#open-video2", str(video))
    page.click("#sample-drive")
    page.wait_for_selector("#editor:not([hidden])", timeout=20000)


def test_reads_a_gopros_telemetry(overlay: Page):
    """The GoPro's GPS (with its UTC time) and accelerometer, on the video's clock."""
    overlay.route("**/fixture/gopro", lambda route: route.fulfill(path=str(GOPRO), content_type="video/mp4"))
    result = overlay.evaluate("""async (url) => {
      const { readMp4, videoCodec } = await import('/static/overlay/mp4.js');
      const { readTelemetry } = await import('/static/overlay/gpmf.js');
      const file = await (await fetch(url)).blob();
      const mp4 = await readMp4(file);
      const tel = await readTelemetry(mp4);
      const v = mp4.tracks.find((t) => t.handler === 'vide');
      return { tracks: mp4.tracks.map((t) => t.format), codec: videoCodec(v), gps: tel.gps.length, first: tel.gps[0],
               utc: tel.utc[0].date.toISOString(), accel: tel.accel.length, skip: v.skip };
    }""", "/fixture/gopro")
    assert {"avc1", "mp4a", "gpmd"} <= set(result["tracks"])
    assert result["codec"].startswith("avc1.64")
    assert result["gps"] > 30 and result["accel"] > 1000
    assert result["first"]["lat"] == pytest.approx(33.1265, abs=1e-3) and result["first"]["lon"] == pytest.approx(-117.327, abs=1e-3)
    assert result["utc"] == "2018-01-24T19:27:58.674Z"
    assert result["skip"] > 0, "the edit list (B-frames) is read"


def test_finds_the_offset_from_a_gopros_gps_and_accelerometer(overlay: Page):
    """A pretend GoPro on the sample drive: 2 minutes from 37.37 s in, its clock 0.6 s out and its
    GPS 0.3 s late, mounted at an angle. Each way of syncing finds it within a frame."""
    result = overlay.evaluate("""async () => {
      const { readLog, parseLog, processLog, at } = await import('/static/replay/drivelog.js');
      const { autoSync } = await import('/static/overlay/sync.js');
      const drive = processLog(parseLog(await readLog(await fetch('/static/sample-drive.bblog.gz'))));
      const truth = 37.37, dur = 120;
      let seed = 1;
      const noise = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      const R = [[0.2, 0.97, 0.1], [-0.95, 0.2, 0.2], [0.17, -0.12, 0.97]];
      const tel = (gps, utc) => {
        const t = { gps: [], utc: [], accel: [], found: true };
        if (gps) for (let s = 0; s < dur; s += 1 / 18) t.gps.push({ t: s, speed: at(drive, drive.speed, s + truth - 0.3) + noise() * 0.3, fix: 3 });
        if (utc) for (let s = 0; s < dur; s += 1) t.utc.push({ t: s, date: new Date(drive.started.getTime() + (s + truth + 0.6) * 1000) });
        for (let s = 0; s < dur; s += 1 / 200) {
          const f = at(drive, drive.longG, s + truth), l = at(drive, drive.latG, s + truth);
          const v = [f * 9.81 + noise() * 3, l * 9.81 + noise() * 3, 9.81 + noise() * 3];
          const c = R.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
          t.accel.push({ t: s, x: c[0], y: c[1], z: c[2] });
        }
        return t;
      };
      const mp4 = { duration: dur, created: null };
      return [[true, true], [true, false], [false, false]].map(([g, u]) => {
        const r = autoSync(drive, mp4, tel(g, u));
        return { method: r.method, error: r.offset - truth, good: r.good };
      });
    }""")
    assert [r["method"] for r in result] == ["gps", "gps-search", "accel"]
    for r in result:
        assert abs(r["error"]) < 0.05, r
        assert r["good"], r


@needs_ffmpeg
def test_lines_up_by_the_clock_and_by_hand(overlay: Page, tmp_path):
    # Made 2 min 20 s after the sample drive started (by its creation time).
    open_both(overlay, make_video(tmp_path / "phone.mp4"))
    expect(overlay.locator("#sync-status")).to_contain_text("creation time")
    expect(overlay.locator("#offset")).to_have_text("2:20.00")
    overlay.evaluate("window.overlay.seek(4)")
    expect(overlay.locator("#drive-clock")).to_have_text("2:24.0")
    # Nudges.
    overlay.click('[data-nudge="1"]')
    overlay.click('[data-nudge="-0.1"]')
    expect(overlay.locator("#offset")).to_have_text("2:20.90")
    # By hand: this frame (4 s in) was 2:31.4 into the drive.
    overlay.click(".by-hand summary")
    overlay.fill("#mark-time", "2:31.4")
    overlay.click("#mark-apply")
    expect(overlay.locator("#offset")).to_have_text("2:27.40")
    expect(overlay.locator("#mark-help")).to_contain_text("Lined up")
    # Auto puts it back.
    overlay.click("#auto-sync")
    expect(overlay.locator("#offset")).to_have_text("2:20.00")


def test_opens_a_logger_session(overlay: Page):
    """The logger's .BLR is a drive log here too (#31)."""
    overlay.set_input_files("#open-drive2", str(BLR))
    expect(overlay.locator("#slot-drive-name")).to_contain_text("(logger)")
    expect(overlay.locator("#slot-drive")).to_have_class(re.compile(r"\bdone\b"))


@needs_ffmpeg
def test_gauges_draw_and_move(overlay: Page, tmp_path):
    open_both(overlay, make_video(tmp_path / "clip.mp4"))
    overlay.evaluate("window.overlay.seek(2)")
    boxes = overlay.evaluate("window.overlay.state.boxes")
    assert {"dial", "pedal", "boost", "gg", "map", "lap"} <= set(boxes), "the sample drive has all of these"
    # Drag the dial to the middle of the frame.
    canvas = overlay.locator("#overlay").bounding_box()
    scale = overlay.evaluate("document.querySelector('#overlay').width") / canvas["width"]
    x, y, w, h = boxes["dial"]
    sx, sy = canvas["x"] + (x + w / 2) / scale, canvas["y"] + (y + h / 2) / scale
    overlay.mouse.move(sx, sy)
    overlay.mouse.down()
    overlay.mouse.move(canvas["x"] + canvas["width"] / 2, canvas["y"] + canvas["height"] / 2, steps=5)
    overlay.mouse.up()
    moved = overlay.evaluate("window.overlay.state.layout.widgets.dial")
    assert 0.35 < moved["x"] < 0.5 and 0.25 < moved["y"] < 0.5
    # Kept in the browser.
    saved = json.loads(overlay.evaluate("localStorage.getItem('boostbook.overlay.layout')"))
    assert saved["widgets"]["dial"]["x"] == pytest.approx(moved["x"])
    # Turn a gauge off; pick values.
    overlay.uncheck('[data-widget="map"]')
    assert "map" not in overlay.evaluate("window.overlay.state.boxes")
    overlay.click('#value-chips button:has-text("Oil temp")')
    assert overlay.evaluate("window.overlay.state.layout.widgets.values.on")
    assert "values" in overlay.evaluate("window.overlay.state.boxes")
    # Reset.
    overlay.click("#reset-layout")
    assert "map" in overlay.evaluate("window.overlay.state.boxes")


def test_needle_gauges_draw_in_every_style(overlay: Page):
    """#62: the speedometer, rev counter, boost and value needles, in each style, at 1080p and 4K.
    Each style draws something of its own, and the needle moves with the value."""
    result = overlay.evaluate("""async () => {
      const { readLog, parseLog, processLog } = await import('/static/replay/drivelog.js');
      const R = await import('/static/overlay/render.js');
      const drive = processLog(parseLog(await readLog(await fetch('/static/sample-drive.bblog.gz'))));
      const prep = R.prepare(drive);
      const ids = ['speedo', 'tacho', 'boostNeedle', 'needle'];
      const out = {};
      for (const H of [1080, 2160]) {
        const W = Math.round(H * 16 / 9);
        for (const style of Object.keys(R.NEEDLE_STYLES)) {
          const layout = R.defaultLayout(W / H);
          for (const id of Object.keys(layout.widgets)) layout.widgets[id].on = ids.includes(id);
          layout.needleStyle = style;
          const grab = (t) => {
            const c = new OffscreenCanvas(W, H), g = c.getContext('2d');
            const boxes = R.drawOverlay(g, W, H, t, { drive, prep, layout });
            const [x, y, w, h] = boxes.speedo;
            return { boxes, pixels: Array.from(g.getImageData(x, y, w, h).data) };
          };
          const a = grab(40), b = grab(5);
          const opaque = a.pixels.filter((v, i) => i % 4 === 3 && v > 0).length;
          let diff = 0;
          for (let i = 0; i < a.pixels.length; i++) diff += Math.abs(a.pixels[i] - b.pixels[i]);
          out[`${style}@${H}`] = { boxes: Object.keys(a.boxes), w: a.boxes.speedo[2], opaque: opaque / (a.pixels.length / 4), diff,
                                   sum: a.pixels.reduce((s, v) => s + v, 0) };
        }
      }
      return { out, value: R.needleValue({ needleValue: null }, drive), choices: R.needleChoices(drive), engine: prep.engine };
    }""")
    out = result["out"]
    assert set(k.split("@")[0] for k in out) == {"classic", "sport", "minimal", "digital", "vintage"}
    for key, r in out.items():
        assert sorted(r["boxes"]) == sorted(["speedo", "tacho", "boostNeedle", "needle"]), key
        assert r["opaque"] > 0.7, f"{key}: the dial is drawn"
        assert r["diff"] > 0, f"{key}: the needle moves"
    assert out["classic@2160"]["w"] == pytest.approx(2 * out["classic@1080"]["w"], abs=1), "the same at 4K, twice the pixels"
    assert len({r["sum"] for k, r in out.items() if k.endswith("@1080")}) == 5, "each style looks different"
    assert result["value"] == "Oil temp" and "Coolant" in result["choices"]
    assert result["engine"] == {"fuel": "diesel", "redline": 5000, "said": False}, "the sample X1 xDrive18d is a diesel"


@needs_ffmpeg
def test_needle_settings(overlay: Page, tmp_path):
    """The needle gauges are off at first; turned on, they draw in the style picked, kept with the layout."""
    open_both(overlay, make_video(tmp_path / "clip.mp4"))
    overlay.evaluate("window.overlay.seek(2)")
    boxes = overlay.evaluate("window.overlay.state.boxes")
    assert not {"speedo", "tacho", "boostNeedle", "needle"} & set(boxes), "off until asked for"
    assert "dial" in boxes, "the gauges as they were"
    expect(overlay.locator("#widgets .group")).to_have_text("Needle gauges")
    overlay.check('[data-widget="speedo"]')
    overlay.check('[data-widget="tacho"]')
    assert {"speedo", "tacho"} <= set(overlay.evaluate("window.overlay.state.boxes"))
    assert overlay.locator("#needle-style option").count() == 5
    expect(overlay.locator("#needle-style")).to_have_value("minimal")
    overlay.select_option("#needle-style", "sport")
    overlay.select_option("#needle-value", "Coolant")
    layout = overlay.evaluate("window.overlay.state.layout")
    assert layout["needleStyle"] == "sport" and layout["needleValue"] == "Coolant" and layout["widgets"]["needle"]["on"]
    assert "needle" in overlay.evaluate("window.overlay.state.boxes")
    saved = json.loads(overlay.evaluate("localStorage.getItem('boostbook.overlay.layout')"))
    assert saved["needleStyle"] == "sport" and saved["widgets"]["speedo"]["on"]
    overlay.reload()
    open_both(overlay, make_video(tmp_path / "clip.mp4"))
    expect(overlay.locator("#needle-style")).to_have_value("sport")
    expect(overlay.locator("#needle-value")).to_have_value("Coolant")
    overlay.click("#reset-layout")
    expect(overlay.locator("#needle-style")).to_have_value("minimal")
    assert not {"speedo", "tacho", "needle"} & set(overlay.evaluate("window.overlay.state.boxes"))


@needs_ffmpeg
def test_exports_an_mp4_with_the_gauges_and_sound(overlay: Page, tmp_path):
    video = make_video(tmp_path / "clip.mp4")
    open_both(overlay, video)
    overlay.fill("#range-start", "0:02")
    overlay.dispatch_event("#range-start", "change")
    overlay.fill("#range-end", "0:05")
    overlay.dispatch_event("#range-end", "change")
    overlay.select_option("#out-size", "0")
    overlay.evaluate("window.overlay.noPicker = true")  # download, not the save dialog
    with overlay.expect_download(timeout=60000) as download:
        overlay.click("#export")
    out = tmp_path / "out.mp4"
    download.value.save_as(out)
    assert download.value.suggested_filename == "clip overlay.mp4"
    expect(overlay.locator("#progress-text")).to_contain_text("Done")
    info = probe(out)
    streams = {s["codec_type"]: s for s in info["streams"]}
    assert streams["video"]["codec_name"] == "h264" and (streams["video"]["width"], streams["video"]["height"]) == (640, 360)
    assert int(streams["video"]["nb_frames"]) == 90, "3 s at 30 frames a second"
    assert streams["audio"]["codec_name"] == "aac"
    assert float(info["format"]["duration"]) == pytest.approx(3, abs=0.1)
    # The gauges are in it: the dial's corner differs from the same frame of the source.
    def pixels(path, at):
        return subprocess.run([FFMPEG, "-v", "error", "-ss", str(at), "-i", str(path), "-frames:v", "1", "-vf", "crop=100:100:20:240",
                               "-f", "rawvideo", "-pix_fmt", "gray", "-"], check=True, capture_output=True).stdout
    a, b = pixels(out, 1), pixels(video, 3)
    assert sum(abs(p - q) for p, q in zip(a, b)) / len(a) > 10


@needs_ffmpeg
def test_exports_an_upright_hevc_phone_video_upright(overlay: Page, tmp_path):
    has_hevc = overlay.evaluate("async () => (await VideoDecoder.isConfigSupported({codec: 'hvc1.1.6.L63.90'})).supported")
    if not has_hevc:
        pytest.skip("this browser can't decode HEVC")
    open_both(overlay, make_video(tmp_path / "phone.mov", seconds=3, codec="libx265", rotate=90))
    overlay.evaluate("window.overlay.noPicker = true")
    overlay.select_option("#out-size", "0")
    with overlay.expect_download(timeout=60000) as download:
        overlay.click("#export")
    out = tmp_path / "out.mp4"
    download.value.save_as(out)
    video = next(s for s in probe(out)["streams"] if s["codec_type"] == "video")
    assert (video["width"], video["height"]) == (360, 640)
