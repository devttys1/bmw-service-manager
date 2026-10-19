"""Service history in QR codes (bmw_service_manager.transfer), as Stampbook reads them."""

import datetime as dt
import json
from pathlib import Path

import pytest

from bmw_service_manager import transfer
from bmw_service_manager.records import MAX_ITEMS, RecordError, ServiceItem, ServiceRecord
from bmw_service_manager.web import create_app

from .test_combinations import all_records

VIN = "WBA00000SAMPLE001"
# Stampbook's tests decode this (ios-app/tools/tests): the web app's QR text and image.
FIXTURES = Path(__file__).resolve().parents[1] / "ios-app" / "tools" / "tests" / "fixtures"


def sample() -> list[ServiceRecord]:
    return [
        ServiceRecord(dt.date(2026, 10, 3), 4_294_967_295, False, "1234567", 1,
                      [ServiceItem(1, 1, 4_294_967_295, 65_535), ServiceItem(100)]),
        ServiceRecord(dt.date(2025, 8, 9), 65_536, True, "54321", 2, [ServiceItem(3, 2, 2400, 3)]),
        ServiceRecord(dt.date(2017, 6, 30), 65_535, True, "", 3, [ServiceItem(c) for c in range(1, MAX_ITEMS + 1)]),
    ]


def test_base45_rfc_9285_examples():
    assert transfer.b45encode(b"AB") == "BB8"
    assert transfer.b45encode(b"Hello!!") == "%69 VD92EX0"
    assert transfer.b45encode(b"base-45") == "UJCLQE7W581"
    assert transfer.b45decode("QED8WEX0") == b"ietf!"
    for bad in ["GGW", "A", "abc"]:
        with pytest.raises(RecordError):
            transfer.b45decode(bad)


def test_round_trip_with_vin_and_name():
    parts = transfer.to_parts(sample(), VIN, "Daily driver ✓")
    assert len(parts) == 1 and parts[0].startswith("SB1:") and parts[0][10:15] == ":1:1:"
    assert set(parts[0]) <= set(transfer.B45), "alphanumeric QR mode only"
    assert transfer.from_parts(parts) == (VIN, "Daily driver ✓", sample())


def test_without_a_vin():
    assert transfer.from_parts(transfer.to_parts(sample())) == ("", "", sample())


def test_every_combination_in_several_codes_any_order():
    records = all_records()[:400]  # 400 records, up to 13 items each: far more than a head unit keeps
    parts = transfer.to_parts(records, VIN)
    assert len(parts) > 1 and all(len(p) <= transfer.PART_CHARS + 20 for p in parts)
    assert transfer.from_parts(list(reversed(parts))) == (VIN, "", records)
    with pytest.raises(RecordError, match=f"{len(parts) - 1} of {len(parts)}"):
        transfer.from_parts(parts[:-1])


def test_a_whole_head_unit_history_fits_one_code():
    records = [ServiceRecord(dt.date(2010 + i % 15, 1 + i % 12, 1), 15_000 * i, i % 2 == 0, "54321", 1,
                             [ServiceItem(1), ServiceItem(100), ServiceItem(4), ServiceItem(5)]) for i in range(1, 21)]
    assert len(transfer.to_parts(records, VIN)) == 1


def test_damaged_or_foreign_codes_are_refused():
    part = transfer.to_parts(sample(), VIN)[0]
    tag, data = part[4:10], part[15:]
    flipped = data[:20] + ("1" if data[20] != "1" else "2") + data[21:]
    for bad in ["https://example.com", f"SB1:{tag}:1:1:" + "0" * 30, part[:-6], f"SB1:{tag}:2:1:{data}",
                f"SB1:{tag}:1:1:{flipped}", f"SB1:000000:1:1:{data}"]:
        with pytest.raises(RecordError):
            transfer.from_parts([bad])
    # A part from another history with the same number of parts is refused.
    mine, theirs = transfer.to_parts(all_records()[:400]), transfer.to_parts(all_records()[:401])
    assert len(mine) == len(theirs)
    with pytest.raises(RecordError, match="different transfers"):
        transfer.from_parts([theirs[0]] + mine[1:])


def test_api_returns_scannable_svg():
    client = create_app().test_client()
    body = {"records": [r.to_dict() for r in sample()], "vin": VIN.lower()}
    res = client.post("/api/qr", json=body).get_json()
    assert res["parts"] == transfer.to_parts(sample(), VIN) and res["svgs"][0].startswith("<svg")
    assert client.post("/api/qr", json={**body, "vin": "WBA123"}).status_code == 400
    assert client.post("/api/qr", json={"records": []}).status_code == 400


def test_stampbook_fixture_matches():
    """The fixture Stampbook's tests decode must be what this code makes today."""
    if not FIXTURES.exists():
        pytest.skip("Stampbook's sources aren't here")
    for name in ["qr-transfer.json", "qr-transfer-parts.json"]:
        expected = json.loads((FIXTURES / name).read_text())
        assert transfer.to_parts([ServiceRecord.from_dict(r) for r in expected["records"]], expected["vin"]) == expected["parts"]
