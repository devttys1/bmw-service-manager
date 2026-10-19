"""Every combination of service record the head unit stores, with 32-bit numbers at their edges."""

import datetime as dt
import itertools

import pytest

from bmw_service_manager import simulator
from bmw_service_manager.headunit import HeadUnit, write_plan
from bmw_service_manager.hsfz import HsfzClient
from bmw_service_manager.records import (
    ITEM_STATUSES,
    ITEM_TYPES,
    MAX_ITEMS,
    RECORD_STATUSES,
    RecordError,
    ServiceItem,
    ServiceRecord,
    dump_tst,
    parse_tst,
)

# Edges of a 32-bit unsigned field (byte and 16-bit boundaries, the maximum) and of a 16-bit one.
U32_EDGES = [0, 1, 255, 256, 65_535, 65_536, 16_777_215, 16_777_216, 0xFFFF_FFFE, 0xFFFF_FFFF]
U16_EDGES = [0, 1, 255, 256, 65_535]
# Every item code the editor offers, plus unnamed codes an import can bring.
CODES = sorted(ITEM_TYPES) + [0, 7, 255]
DEALERS = ["", "1", "1234567", "AB-12 Z"]
DATES = [dt.date(1, 1, 1), dt.date(1999, 12, 31), dt.date(2024, 2, 29), dt.date(2026, 6, 15), dt.date(9999, 11, 30)]
CORRECTIONS = [0, 1, 127, 255]
ITEM_COUNTS = [1, 2, 12, MAX_ITEMS]

# Every item: code x status x remaining distance x remaining time.
ALL_ITEMS = [ServiceItem(c, s, km, m) for c, s, km, m in itertools.product(CODES, sorted(ITEM_STATUSES), U32_EDGES, U16_EDGES)]


def all_records() -> list[ServiceRecord]:
    """Every header combination, with the dates and the items cycled through."""
    out, nxt = [], 0
    for status, bmw, dealer, km, corr, count in itertools.product(
        sorted(RECORD_STATUSES), [False, True], DEALERS, U32_EDGES, CORRECTIONS, ITEM_COUNTS
    ):
        items = [ALL_ITEMS[(nxt + i) % len(ALL_ITEMS)] for i in range(count)]
        nxt += count
        out.append(ServiceRecord(DATES[len(out) % len(DATES)], km, bmw, dealer, status, items, corr))
    return out


def write_records() -> list[ServiceRecord]:
    """Every item exactly once, 13 to a record, header values cycled: one write's worth."""
    statuses = sorted(RECORD_STATUSES)
    return [
        ServiceRecord(DATES[n % len(DATES)], U32_EDGES[n % len(U32_EDGES)], n % 2 == 1, DEALERS[n % len(DEALERS)],
                      statuses[n % len(statuses)], ALL_ITEMS[start : start + MAX_ITEMS], CORRECTIONS[n % len(CORRECTIONS)])
        for n, start in enumerate(range(0, len(ALL_ITEMS), MAX_ITEMS))
    ]


def test_every_combination_round_trips():
    records = all_records()
    assert len(records) == 3840
    assert {(i.code, i.status, i.remaining_distance, i.remaining_time) for r in records for i in r.items} == {
        (i.code, i.status, i.remaining_distance, i.remaining_time) for i in ALL_ITEMS
    }
    for r in records:
        data = r.encode()
        assert len(data) == 19 + 8 * len(r.items)
        assert data[5:9] == r.mileage_km.to_bytes(4, "big")
        assert ServiceRecord.decode(data) == r
        assert ServiceRecord.from_dict(r.to_dict()) == r
    assert parse_tst(dump_tst(records, erase=True)) == (True, records)
    assert len(write_plan(records, erase=True, reset=True)) == len(records) + 2


def test_every_item_written_to_the_simulated_head_unit():
    server, hu = simulator.start()
    try:
        records = write_records()
        with HsfzClient(*server.server_address) as client:
            results = HeadUnit(client).write_history(records, erase=True, reset=False)
        assert all(r.ok for r in results) and len(results) == len(records) + 1
        assert hu.records == records
    finally:
        server.shutdown()
        server.server_close()


def ok_record(**change) -> ServiceRecord:
    fields = dict(date=dt.date(2026, 1, 1), mileage_km=1000, bmw_dealer=True, dealer_number="1", status=1, items=[ServiceItem(1)])
    fields.update(change)
    return ServiceRecord(**fields)


@pytest.mark.parametrize("what, record", [
    ("mileage 2^32", ok_record(mileage_km=0x1_0000_0000)),
    ("negative mileage", ok_record(mileage_km=-1)),
    ("correction 256", ok_record(correction=256)),
    ("negative correction", ok_record(correction=-1)),
    ("record status 0", ok_record(status=0)),
    ("record status 4", ok_record(status=4)),
    ("dealer number of 8", ok_record(dealer_number="12345678")),
    ("no items", ok_record(items=[])),
    ("14 items", ok_record(items=[ServiceItem(1)] * (MAX_ITEMS + 1))),
    ("item code 256", ok_record(items=[ServiceItem(256)])),
    ("negative item code", ok_record(items=[ServiceItem(-1)])),
    ("item status 0", ok_record(items=[ServiceItem(1, 0)])),
    ("item status 4", ok_record(items=[ServiceItem(1, 4)])),
    ("remaining distance 2^32", ok_record(items=[ServiceItem(1, 1, 0x1_0000_0000)])),
    ("negative remaining distance", ok_record(items=[ServiceItem(1, 1, -1)])),
    ("remaining time 65536", ok_record(items=[ServiceItem(1, 1, 0, 65_536)])),
    ("negative remaining time", ok_record(items=[ServiceItem(1, 1, 0, -1)])),
])
def test_out_of_range_is_refused(what, record):
    with pytest.raises(RecordError):
        record.encode()
    with pytest.raises(RecordError):
        write_plan([record], erase=True, reset=False)


def test_non_ascii_dealer_number_is_refused():
    with pytest.raises((RecordError, UnicodeEncodeError)):
        ok_record(dealer_number="é").encode()


def test_api_refuses_bad_records_without_crashing():
    from bmw_service_manager.web import create_app

    client = create_app().test_client()
    bad = ok_record(mileage_km=0x1_0000_0000).to_dict()
    res = client.post("/api/plan", json={"records": [bad], "erase": True, "reset": False})
    assert res.status_code == 400 and "mileage" in res.get_json()["error"]
    res = client.post("/api/plan", json={"records": [{**bad, "date": "2026-13-01"}]})
    assert res.status_code == 400
    big = ok_record(mileage_km=0xFFFF_FFFF, items=[ServiceItem(1, 1, 0xFFFF_FFFF, 0xFFFF)]).to_dict()
    steps = client.post("/api/plan", json={"records": [big], "erase": False, "reset": False}).get_json()["steps"]
    assert "ff ff ff ff" in steps[0]["request"]
