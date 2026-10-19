import datetime as dt
import time

import pytest

from bmw_service_manager import simulator
from bmw_service_manager.headunit import HeadUnit, write_plan
from bmw_service_manager.hsfz import HsfzClient, NegativeResponse
from bmw_service_manager.records import ServiceItem, ServiceRecord
from bmw_service_manager.web import create_app


@pytest.fixture
def sim():
    server, hu = simulator.start()
    yield server.server_address, hu
    server.shutdown()
    server.server_close()


def wait_for_scan(client, scan_id, timeout=30.0):
    """Poll a DID scan until it finishes. Generous: CI runners are several times slower than a laptop."""
    deadline = time.monotonic() + timeout
    while True:
        status = client.get(f"/api/probe/dids/{scan_id}").get_json()
        if status["done"] or time.monotonic() > deadline:
            return status
        time.sleep(0.02)


def records():
    return [
        ServiceRecord(dt.date(2026, 10, 13), 85000, True, "1234567", 1, [ServiceItem(1), ServiceItem(3)]),
        ServiceRecord(dt.date(2025, 4, 2), 62000, False, "181", 2, [ServiceItem(100)]),
    ]


def test_write_plan_matches_shm_sequence():
    plan = write_plan(records(), erase=True, reset=True)
    assert plan[0][1].hex() == "3101a080"
    assert plan[1][1][:4].hex() == "3101a081"
    assert plan[-1][1].hex() == "1101"
    assert len(plan) == 4


def test_hsfz_frames(sim):
    (host, port), _ = sim
    with HsfzClient(host, port) as client:
        HeadUnit(client).write_history(records()[:1], erase=True, reset=False)
    # length 6 = tester + target + 4-byte request; control 0x0001; F4 -> 63
    assert client.log[0] == ("tx", "00 00 00 06 00 01 f4 63 31 01 a0 80")
    assert client.log[1][1].startswith("00 00 00 06 00 02")  # gateway ack
    assert client.log[2] == ("rx", "00 00 00 07 00 01 63 f4 71 01 a0 80 01")


def test_write_history_end_to_end(sim):
    (host, port), hu = sim
    hu.records.append(records()[1])
    with HsfzClient(host, port) as client:
        results = HeadUnit(client).write_history(records(), erase=True, reset=True)
    assert all(r.ok for r in results), results
    assert hu.records == records()
    assert hu.resets == 1


def test_negative_response_raises(sim):
    (host, port), _ = sim
    with HsfzClient(host, port) as client, pytest.raises(NegativeResponse) as e:
        client.request(0x63, bytes.fromhex("22F190"))
    assert e.value.nrc == 0x31


def test_probes_are_read_only(sim):
    (host, port), hu = sim
    hu.records.extend(records())
    with HsfzClient(host, port) as client:
        unit = HeadUnit(client)
        assert [r.ok for r in unit.probe_routine_results()] == [False, False]
        assert unit.probe_dids(0x1000, 0x1010) == []
    assert hu.records == records()
    assert hu.resets == 0


def test_web_api_write(sim):
    (host, port), hu = sim
    client = create_app(default_host=host, default_port=port).test_client()
    body = {"records": [r.to_dict() for r in records()], "erase": True, "reset": True}
    plan = client.post("/api/plan", json=body).get_json()
    assert [s["request"][:11] for s in plan["steps"]] == ["31 01 a0 80", "31 01 a0 81", "31 01 a0 81", "11 01"]
    res = client.post("/api/write", json=body).get_json()
    assert all(r["ok"] for r in res["results"])
    assert hu.records == records()


def test_web_api_rejects_bad_record():
    client = create_app().test_client()
    bad = records()[0].to_dict() | {"dealer_number": "TOO-LONG-1"}
    res = client.post("/api/plan", json={"records": [bad]})
    assert res.status_code == 400
    assert "dealer number" in res.get_json()["error"]


def test_web_api_did_scan_flags_stored_records(sim):
    (host, port), hu = sim
    stored = records()
    blob = b"".join(r.encode() for r in stored)
    original = hu.handle
    # Test fixture only: pretend DID 0x1234 holds the history. Real head units are unverified.
    hu.handle = lambda uds: bytes.fromhex("621234") + blob if uds == bytes.fromhex("221234") else original(uds)
    client = create_app(default_host=host, default_port=port).test_client()
    res = client.post("/api/probe/dids", json={"start": "1200", "end": "12FF", "known_date": "2025-04-02", "known_km": "62000"})
    scan_id = res.get_json()["id"]
    status = wait_for_scan(client, scan_id)
    assert status["done"]
    (hit,) = status["hits"]
    assert hit["did"] == "0x1234"
    assert hit["matches"] == ["date d/m/yyyy BE", "km u32 BE"]
    assert [r["date"] for r in hit["records"]] == ["2026-10-13", "2025-04-02"]
    assert hu.records == [] and hu.resets == 0


def test_nbt_status_zero_counts_as_success(sim):
    (host, port), hu = sim
    original = hu.handle
    # An NBT Evo answered 71 01 A0 81 00 to an accepted record.
    hu.handle = lambda uds: bytes.fromhex("7101A08100") if uds[:4] == bytes.fromhex("3101A081") else original(uds)
    with HsfzClient(host, port) as client:
        results = HeadUnit(client).write_history(records()[:1], erase=False, reset=True)
    assert [r.ok for r in results] == [True, True]
    assert results[0].detail == "0x00 OK (NBT)"


def test_read_cbs(sim):
    (host, port), _ = sim
    client = create_app(default_host=host, default_port=port).test_client()
    items = client.post("/api/cbs", json={}).get_json()["items"]
    by_code = {i["code"]: i for i in items}
    assert sorted(by_code) == [1, 2, 3, 6, 32, 100]  # the all-FF slot is skipped
    assert by_code[1] | {"raw": ""} == {
        "code": 1, "name": "Engine oil", "owner": "DME", "availability": 0, "resets": 6, "flag": False,
        "interval_km": 15000, "interval_months": 12, "remaining_km": -3000, "due": "12/2025",
        "overdue": True, "raw": "",
    }
    assert by_code[100]["availability"] == 30 and by_code[100]["interval_months"] == 48
    assert by_code[3]["due"] == "11/2025" and by_code[3]["remaining_km"] is None
    assert by_code[100]["remaining_km"] == 27000 and by_code[100]["due"] == "12/2027"
    assert by_code[2]["name"] == "Front brake pads" and by_code[2]["owner"] == "DSC"
    assert by_code[2]["availability"] is None and by_code[2]["remaining_km"] is None  # wear sensor
    assert by_code[32]["owner"] == "cluster"


@pytest.fixture
def dme_sim():
    server, _ = simulator.start()
    yield server.server_address, server.dme
    server.shutdown()
    server.server_close()


def test_cbs_reset_sends_captured_writes_to_dme(dme_sim):
    (host, port), dme = dme_sim
    client = create_app(default_host=host, default_port=port).test_client()
    res = client.post("/api/cbs/reset", json={}).get_json()
    tx = [hex for direction, hex in res["frames"] if direction == "tx"]
    assert tx[0].endswith("f4 12 22 10 01")
    # Only the write BimmerLink's reset was acknowledged for (oil, 100%, count +1, rest unchanged)
    assert tx[1].endswith("f4 12 2e 10 01 01 01 64 1f 80 00 0f ff 0f 3f ff 00")
    assert tx[2].endswith("f4 12 22 10 01")
    assert res["before"] == {"raw": "01 01 00 00 00 00 06 00 00 00 00 ff"}
    assert res["after"] == {"raw": "01 01 64 1f 80 00 0f ff 0f 3f ff 00"}
    assert len(dme.writes) == 1 and len(res["items"]) == 6


def test_cbs_reset_stops_on_negative_response(dme_sim):
    (host, port), dme = dme_sim
    dme.handle = lambda uds: bytes([0x7F, uds[0], 0x22])
    client = create_app(default_host=host, default_port=port).test_client()
    res = client.post("/api/cbs/reset", json={})
    assert res.status_code == 400
    assert "conditionsNotCorrect" in res.get_json()["error"]


def test_web_api_did_scan_targets_chosen_ecu(sim):
    (host, port), _ = sim
    client = create_app(default_host=host, default_port=port).test_client()
    scan_id = client.post("/api/probe/dids", json={"ecu": "60", "start": "4100", "end": "4105"}).get_json()["id"]
    status = wait_for_scan(client, scan_id)
    assert status["ecu"] == 0x60
    assert [h["did"] for h in status["hits"]] == ["0x4101", "0x4102", "0x4103", "0x4104"]
    assert client.post("/api/probe/dids", json={"ecu": "100", "start": "0", "end": "1"}).status_code == 400


def test_web_api_did_scan_in_bmw_session(sim):
    (host, port), hu = sim
    original = hu.handle
    # Test fixture only: a DID that answers only in session 0x42.
    hu.handle = lambda uds: (
        bytes.fromhex("62abcd01") if uds == bytes.fromhex("22abcd") and hu.session == 0x42 else original(uds)
    )
    client = create_app(default_host=host, default_port=port).test_client()
    scan_id = client.post("/api/probe/dids", json={"session": "42", "start": "ABC0", "end": "ABCF"}).get_json()["id"]
    status = wait_for_scan(client, scan_id)
    assert status["session"] == 0x42
    assert [h["did"] for h in status["hits"]] == ["0xABCD"]
    assert hu.sessions == [0x03, 0x42, 0x01]  # via extended, back to default afterwards
    assert client.post("/api/probe/dids", json={"session": "02", "start": "0", "end": "1"}).status_code == 400


def test_brake_fluid_reset_goes_to_cluster(dme_sim):
    (host, port), dme = dme_sim
    client = create_app(default_host=host, default_port=port).test_client()
    res = client.post("/api/cbs/reset", json={"item": "brake_fluid"}).get_json()
    tx = [hex for direction, hex in res["frames"] if direction == "tx"]
    assert tx[1].endswith("f4 60 2e 10 01 01 03 64 1f 80 00 0f ff 0f 3f ff 00")
    assert (res["before"]["availability"], res["before"]["resets"]) == (0, 3)
    assert (res["after"]["availability"], res["after"]["resets"]) == (100, 4)
    assert dme.writes == []  # nothing sent to the DME
    assert client.post("/api/cbs/reset", json={"item": "brakes"}).status_code == 400


def test_reset_by_item_code_goes_to_owner_ecu(dme_sim):
    (host, port), dme = dme_sim
    client = create_app(default_host=host, default_port=port).test_client()
    sent_to = {}
    for code in (0x01, 0x02, 0x03, 0x06, 0x20, 0x64):
        res = client.post("/api/cbs/reset", json={"item": code}).get_json()
        write = next(h for d, h in res["frames"] if d == "tx" and " 2e 10 01 " in h)
        sent_to[code] = write.split()[7]  # target address after the 6-byte header and tester
        assert write.endswith(f"2e 10 01 01 {code:02x} 64 1f 80 00 0f ff 0f 3f ff 00")
    assert sent_to == {0x01: "12", 0x02: "29", 0x03: "60", 0x06: "29", 0x20: "60", 0x64: "60"}
    by_code = {i["code"]: i for i in res["items"]}
    assert by_code[2]["availability"] == 100 and by_code[2]["resets"] == 6  # DSC reset shows in the cluster
    assert client.post("/api/cbs/reset", json={"item": 0}).status_code == 400


def test_status_of_a_car(sim):
    (host, port), _ = sim
    client = create_app(host, port).test_client()
    assert client.get("/api/status").get_json() == {"state": "not_set"}
    # The simulator has no UDP identity: it's reached by TCP.
    assert client.get(f"/api/status?host={host}&port={port}").get_json()["state"] == "connected"
    assert client.get(f"/api/status?host={host}&port=1").get_json()["state"] == "no_answer"
    simulated = create_app(host, port, simulated=True).test_client()
    assert simulated.get(f"/api/status?host={host}&port={port}").get_json()["state"] == "simulator"


def test_identify_reads_the_vin_from_a_gateway():
    import socket
    import threading

    from bmw_service_manager import hsfz

    gw = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    gw.bind(("127.0.0.1", hsfz.DISCOVERY_PORT))

    def answer():
        _, addr = gw.recvfrom(64)
        text = b"DIAGADR10BMWMACAABBCCDDEEFFBMWVINWBA00000SAMPLE001"
        gw.sendto(hsfz.HEADER.pack(len(text), hsfz.CTRL_VEHICLE_IDENT) + text, addr)

    threading.Thread(target=answer, daemon=True).start()
    try:
        vehicle = hsfz.identify("127.0.0.1")
        assert vehicle and vehicle.vin == "WBA00000SAMPLE001"
    finally:
        gw.close()
