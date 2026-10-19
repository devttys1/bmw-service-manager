import datetime as dt

import pytest

from bmw_service_manager.records import (
    RecordError,
    ServiceItem,
    ServiceRecord,
    dump_tst,
    find_records,
    known_entry_patterns,
    parse_tst,
)

# Example file from theDeniZ/ServiceManager's README.
TST = (
    "1|g_mmi|steuern_servicehistory_erase\r\n"
    "2|g_mmi|steuern_servicehistory_add||8;11;2020;0;175021;0;00181;0x1;5;1;0x1;0;0;4;0x1;0;0;11;0x1;0;0;12;0x1;0;0;100;0x1;0;0\r\n"
    "3|g_mmi|steuern_servicehistory_add||8;3;2019;0;151690;0;00181;0x1;2;1;0x1;0;0;4;0x1;0;0\r\n"
)


def record():
    return ServiceRecord(
        date=dt.date(2026, 10, 13),
        mileage_km=85000,
        bmw_dealer=True,
        dealer_number="1234567",
        status=1,
        items=[ServiceItem(1, 1), ServiceItem(3, 2)],
    )


def test_encode_matches_shm_layout():
    data = record().encode()
    assert data == bytes.fromhex(
        "0d 0a 07ea 00 00014c08 01 31323334353637 01 02"  # header: date, corr, km, flag, dealer, status, count
        "01 01 00000000 0000"  # engine oil, carried out
        "03 02 00000000 0000"  # brake fluid, late
    )
    assert len(data) == 19 + 2 * 8


def test_short_dealer_number_is_zero_padded():
    r = record()
    r.dealer_number = "181"
    assert r.encode()[10:17] == b"181\0\0\0\0"


def test_decode_round_trip():
    r = record()
    assert ServiceRecord.decode(r.encode()) == r


def test_ediabas_args_round_trip():
    r = record()
    assert r.to_ediabas_args() == "13;10;2026;0;85000;1;1234567;0x1;2;1;0x1;0;0;3;0x2;0;0"
    assert ServiceRecord.from_ediabas_args(r.to_ediabas_args()) == r


def test_parse_servicemanager_tst():
    erase, records = parse_tst(TST)
    assert erase
    assert [r.date for r in records] == [dt.date(2020, 11, 8), dt.date(2019, 3, 8)]
    assert records[0].mileage_km == 175021
    assert records[0].dealer_number == "00181"
    assert not records[0].bmw_dealer
    assert [i.code for i in records[0].items] == [1, 4, 11, 12, 100]


def test_tst_round_trip():
    erase, records = parse_tst(TST)
    assert parse_tst(dump_tst(records, erase)) == (erase, records)


@pytest.mark.parametrize(
    "change",
    [
        lambda r: setattr(r, "dealer_number", "12345678"),
        lambda r: setattr(r, "items", []),
        lambda r: setattr(r, "items", [ServiceItem(1)] * 14),
        lambda r: setattr(r, "status", 4),
        lambda r: setattr(r, "mileage_km", -1),
        lambda r: setattr(r, "items", [ServiceItem(1, 2, -5000)]),
    ],
)
def test_validation(change):
    r = record()
    change(r)
    with pytest.raises(RecordError):
        r.encode()


def test_find_records_in_noise():
    a, b = record(), ServiceRecord(dt.date(2024, 1, 5), 41000, False, "181", 2, [ServiceItem(100)])
    blob = b"\xff\x00\x13" + a.encode() + b"\x00" * 5 + b.encode() + b"\xaa"
    found = find_records(blob)
    assert [(off, rec) for off, rec in found] == [(3, a), (3 + len(a.encode()) + 5, b)]


def test_find_records_ignores_random_bytes():
    assert find_records(bytes(range(256)) * 4) == []


def test_known_entry_patterns_hit_encoded_record():
    data = record().encode()
    hits = [k for k, p in known_entry_patterns(dt.date(2026, 10, 13), 85000).items() if p in data]
    assert hits == ["date d/m/yyyy BE", "km u32 BE"]


def test_remaining_fields_big_endian_unsigned():
    # Verified on an NBT Evo: time 5 -> "late 5 months", distance 5000 -> "overdue 5000 km".
    r = record()
    r.items = [ServiceItem(3, 2, 0, 5), ServiceItem(10, 3, 5000, 0)]
    assert r.encode()[19:] == bytes.fromhex("0302 00000000 0005" "0a03 00001388 0000")
