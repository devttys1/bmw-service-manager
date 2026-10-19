"""The web page driven in a real browser (Playwright + Chromium) against the simulated car.

    pip install -e '.[dev,ui]' && python -m playwright install chromium
    python -m pytest tests/ui
"""

import re
import threading

import pytest

pytest.importorskip("playwright")

from playwright.sync_api import Page, expect  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

from bmw_service_manager import simulator  # noqa: E402
from bmw_service_manager.web import create_app  # noqa: E402


@pytest.fixture
def car():
    server, hu = simulator.start()
    web = make_server("127.0.0.1", 0, create_app(*server.server_address), threaded=True)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{web.server_port}/", hu
    web.shutdown()
    server.shutdown()
    server.server_close()


@pytest.fixture
def app(page: Page, car):
    url, hu = car
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(url)
    expect(page.locator("#version")).not_to_be_empty()
    yield page, hu
    assert not errors, f"JavaScript errors: {errors}"


def mileages(page: Page) -> list[int]:
    return [int(t.replace(",", "").replace(" km", "")) for t in page.locator(".record .km").all_inner_texts()]


def add_record(page: Page, km: int, remaining_km: int) -> None:
    page.click("#add-record")
    rec = page.locator(".record").last
    rec.locator('[data-act="edit"]').click()
    mileage = rec.locator('[data-f="mileage_km"]')
    expect(mileage).to_have_value("")  # empty, with a grey 0: nothing to delete first
    assert mileage.get_attribute("placeholder") == "0"
    mileage.fill(str(km))
    mileage.dispatch_event("change")
    remaining = rec.locator('[data-k="remaining_distance"]')
    expect(remaining).to_have_value("")
    remaining.fill(str(remaining_km))
    remaining.dispatch_event("change")
    rec.locator('[data-act="edit"]').click()  # Done


def test_history_with_large_mileages(app):
    page, hu = app
    page.set_viewport_size({"width": 1280, "height": 1600})  # every record on screen, to drag between
    for km in [65_536, 4_294_967_295, 12_345, 65_535]:
        add_record(page, km, 4_294_967_295)
    assert mileages(page) == [65_536, 4_294_967_295, 12_345, 65_535]

    page.click("#sort-km")
    assert mileages(page) == [4_294_967_295, 65_536, 65_535, 12_345], "highest mileage first"
    expect(page.locator("#sort-km")).to_be_disabled()

    # Drag the bottom record onto the top half of the first.
    records = page.locator(".record")
    records.nth(3).drag_to(records.nth(0), target_position={"x": 40, "y": 5})
    assert mileages(page) == [12_345, 4_294_967_295, 65_536, 65_535], "dragged to the top"
    expect(page.locator("#sort-km")).to_be_enabled()
    page.locator(".record").nth(0).locator('[data-act="down"]').click()
    assert mileages(page) == [4_294_967_295, 12_345, 65_536, 65_535], "the down button still works"

    remove = page.locator('.record [data-act="remove"]').first
    assert remove.evaluate("b => getComputedStyle(b).backgroundColor") in ("rgb(198, 40, 40)", "rgb(239, 83, 80)"), "Remove is red"
    page.locator('.record [data-act="remove"]').last.click()
    page.locator('.record [data-act="remove"]').nth(1).click()
    assert mileages(page) == [4_294_967_295, 65_536]

    page.click("#preview")
    expect(page.locator("#write-output")).to_contain_text("4294967295 km")
    assert "ff ff ff ff" in page.locator("#write-output").inner_text()

    page.click("#write")
    page.click("#write")  # the second click within 5 s confirms
    expect(page.locator("#write-output")).to_contain_text("Write complete.", timeout=30_000)
    assert [r.mileage_km for r in hu.records] == [4_294_967_295, 65_536]
    assert hu.records[0].items[0].remaining_distance == 4_294_967_295


def test_cbs_placeholder_until_read(app):
    page, _ = app
    expect(page.locator("#cbs-list")).to_contain_text("Not read yet")
    page.click("#read-cbs")
    expect(page.locator(".cbs-item").first).to_be_visible()
    expect(page.locator("#cbs-list")).not_to_contain_text("Not read yet")


def test_probe_hidden_until_turned_on(app):
    page, _ = app
    expect(page.locator("#probe-card")).to_be_hidden()
    page.check("#show-probe")
    expect(page.locator("#probe-card")).to_be_visible()
    page.reload()
    expect(page.locator("#probe-card")).to_be_visible()  # remembered
    page.uncheck("#show-probe")
    expect(page.locator("#probe-card")).to_be_hidden()


def background(page: Page) -> str:
    return page.evaluate("getComputedStyle(document.body).backgroundColor")


def test_appearance_light_dark_and_system(app):
    page, _ = app
    light, dark = "rgb(244, 245, 247)", "rgb(20, 23, 27)"
    page.emulate_media(color_scheme="light")
    assert background(page) == light, "System follows a light computer"
    page.emulate_media(color_scheme="dark")
    assert background(page) == dark, "System follows a dark computer"
    page.select_option("#theme", "light")
    assert background(page) == light, "Light overrides a dark computer"
    page.reload()
    assert background(page) == light and page.input_value("#theme") == "light", "remembered"
    page.emulate_media(color_scheme="light")
    page.select_option("#theme", "dark")
    assert background(page) == dark, "Dark overrides a light computer"
    page.select_option("#theme", "system")
    assert background(page) == light


def test_qr_code_for_stampbook(app):
    page, _ = app
    page.fill("#vin", "wba00000sample001")
    for km in [4_294_967_295, 65_536]:
        add_record(page, km, 0)
    page.click("#show-qr")
    expect(page.locator("#qr-code svg")).to_be_visible()
    expect(page.locator("#qr-nav")).to_be_hidden()  # a short history: one code
    box = page.locator("#qr-code svg").bounding_box()
    assert box["width"] >= 250, "big enough to scan off the screen"
    # A change to the records hides the code it no longer matches.
    page.click("#add-record")
    expect(page.locator("#qr-panel")).to_be_hidden()

    # A long history: several codes, with Previous and Next.
    page.evaluate("""records = Array.from({length: 120}, (_, i) => ({date: "2020-01-01", mileage_km: 1000 * i + 7 * i * i,
        bmw_dealer: i % 2 == 0, dealer_number: String(10000 + i * 37), status: 1 + i % 3, correction: i % 256,
        items: Array.from({length: 1 + i % 13}, (_, j) => ({code: [1,2,3,4,5,6,10,11,12,100][j % 10], status: 1 + j % 3,
        remaining_distance: (i * 7919 + j * 104729) % 4294967296, remaining_time: (i * 31 + j) % 65536}))})); render();""")
    page.click("#show-qr")
    expect(page.locator("#qr-count")).to_have_text(re.compile(r"1 of ([2-9]|\d\d+)"))  # the new codes, not the last ones
    total = int(page.inner_text("#qr-count").split(" of ")[1])
    assert total > 1
    expect(page.locator("#qr-prev")).to_be_disabled()
    for n in range(2, total + 1):
        page.click("#qr-next")
        expect(page.locator("#qr-count")).to_have_text(f"{n} of {total}")
    expect(page.locator("#qr-next")).to_be_disabled()


def test_connection_light(app):
    page, _ = app
    light = page.locator("#car-status")
    # The test app's car is the simulator, reached like a real one: no UDP identity, so by TCP.
    expect(light).to_have_attribute("data-state", "connected", timeout=10_000)
    expect(light).to_contain_text("Connected")
    page.fill("#port", "1")  # nothing listens there
    page.dispatch_event("#port", "change")
    expect(light).to_have_attribute("data-state", "no_answer", timeout=10_000)
    expect(light).to_contain_text("Not responding")
    page.fill("#host", "")
    page.dispatch_event("#host", "change")
    expect(light).to_have_attribute("data-state", "not_set", timeout=10_000)


def test_dealers_remembered(app):
    page, _ = app
    page.click("#add-record")
    rec = page.locator(".record").last
    rec.locator('[data-act="edit"]').click()
    rec.locator('[data-f="bmw_dealer"]').select_option("0")
    rec.locator('[data-f="dealer_number"]').fill("TEST1")
    rec.locator('[data-f="dealer_number"]').dispatch_event("change")
    rec.locator('[data-act="edit"]').click()
    assert page.locator("#dealers option").evaluate_all("os => os.map(o => [o.value, o.textContent])") == [["TEST1", "Independent"]]

    # A new record: picking the dealer brings its type with it.
    page.click("#add-record")
    rec = page.locator(".record").last
    rec.locator('[data-act="edit"]').click()
    expect(rec.locator('[data-f="bmw_dealer"]')).to_have_value("1")
    assert rec.locator('[data-f="dealer_number"]').get_attribute("list") == "dealers"
    rec.locator('[data-f="dealer_number"]').fill("TEST1")
    rec.locator('[data-f="dealer_number"]').dispatch_event("change")
    expect(rec.locator('[data-f="bmw_dealer"]')).to_have_value("0")

    # Remembered in this browser, even with no records left.
    page.reload()
    assert page.locator("#dealers option").evaluate_all("os => os.map(o => o.value)") == ["TEST1"]
