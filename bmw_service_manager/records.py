"""Service history records: the binary layout the head unit stores, plus text formats.

The binary layout is the payload of UDS ``31 01 A0 81`` as built by SHM.exe:
a 19-byte header followed by one 8-byte block per service item, all
multi-byte fields big-endian.
"""

from __future__ import annotations

import datetime as dt
import struct
from dataclasses import dataclass, field

ITEM_TYPES = {
    1: "Engine oil",
    2: "Front brakes",
    3: "Brake fluid",
    4: "Micro-filter",
    5: "Recirculating air filter",
    6: "Rear brakes",
    10: "Spark plugs",
    11: "Air filter element",
    12: "Fuel filter",
    100: "Vehicle check",
    20: "Pre-delivery inspection",
    21: "Running-in check",
    32: "Statutory vehicle inspection",
    33: "Statutory emissions test",
}

RECORD_STATUSES = {1: "Carried out", 2: "Carried out late", 3: "Incomplete"}
ITEM_STATUSES = {1: "Carried out", 2: "Carried out late", 3: "Overdue"}

MAX_ITEMS = 13
DEALER_NUMBER_LEN = 7

# day, month, year, correction counter, km, BMW-dealer flag, dealer number, status, item count
HEADER = struct.Struct(">BBHBIB7sBB")
# item code, item status, remaining distance (km), remaining time (months).
# iDrive shows the distance as unsigned and takes "late"/"overdue" from the status,
# e.g. status 2 + time 5 displays "late 5 months" (verified on an NBT Evo).
ITEM = struct.Struct(">BBIH")


class RecordError(ValueError):
    pass


@dataclass
class ServiceItem:
    code: int
    status: int = 1
    remaining_distance: int = 0
    remaining_time: int = 0

    @property
    def name(self) -> str:
        return ITEM_TYPES.get(self.code, f"Unknown ({self.code})")

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "status": self.status,
            "remaining_distance": self.remaining_distance,
            "remaining_time": self.remaining_time,
        }

    @classmethod
    def from_dict(cls, d: dict) -> ServiceItem:
        return cls(
            code=int(d["code"]),
            status=int(d.get("status", 1)),
            remaining_distance=int(d.get("remaining_distance", 0)),
            remaining_time=int(d.get("remaining_time", 0)),
        )


@dataclass
class ServiceRecord:
    date: dt.date
    mileage_km: int
    bmw_dealer: bool
    dealer_number: str
    status: int = 1
    items: list[ServiceItem] = field(default_factory=list)
    correction: int = 0

    def validate(self) -> None:
        if not 1 <= len(self.items) <= MAX_ITEMS:
            raise RecordError(f"a record needs 1 to {MAX_ITEMS} service items")
        if not 0 <= self.mileage_km <= 0xFFFFFFFF:
            raise RecordError("mileage out of range")
        if not 0 <= self.date.year <= 0xFFFF:
            raise RecordError("year out of range")
        if not 0 <= self.correction <= 0xFF:
            raise RecordError("correction counter out of range")
        if self.status not in RECORD_STATUSES:
            raise RecordError(f"record status must be one of {sorted(RECORD_STATUSES)}")
        dealer = self.dealer_number.encode("ascii", errors="strict")
        if len(dealer) > DEALER_NUMBER_LEN:
            raise RecordError(f"dealer number is at most {DEALER_NUMBER_LEN} ASCII characters")
        for item in self.items:
            if not 0 <= item.code <= 0xFF:
                raise RecordError(f"item code {item.code} out of range")
            if item.status not in ITEM_STATUSES:
                raise RecordError(f"item status must be one of {sorted(ITEM_STATUSES)}")
            if not 0 <= item.remaining_distance <= 0xFFFFFFFF:
                raise RecordError("remaining distance must be 0 or more km")
            if not 0 <= item.remaining_time <= 0xFFFF:
                raise RecordError("remaining time must be 0 to 65535 months")

    def encode(self) -> bytes:
        self.validate()
        out = HEADER.pack(
            self.date.day,
            self.date.month,
            self.date.year,
            self.correction,
            self.mileage_km,
            1 if self.bmw_dealer else 0,
            self.dealer_number.encode("ascii"),
            self.status,
            len(self.items),
        )
        for item in self.items:
            out += ITEM.pack(item.code, item.status, item.remaining_distance, item.remaining_time)
        return out

    @classmethod
    def decode(cls, data: bytes) -> ServiceRecord:
        if len(data) < HEADER.size:
            raise RecordError("record shorter than its header")
        day, month, year, corr, km, flag, dealer, status, count = HEADER.unpack_from(data)
        if len(data) < HEADER.size + count * ITEM.size:
            raise RecordError(f"record declares {count} items but is only {len(data)} bytes")
        items = [
            ServiceItem(*ITEM.unpack_from(data, HEADER.size + i * ITEM.size)) for i in range(count)
        ]
        return cls(
            date=dt.date(year, month, day),
            mileage_km=km,
            bmw_dealer=flag == 1,
            dealer_number=dealer.rstrip(b"\0").decode("ascii", errors="replace"),
            status=status,
            items=items,
            correction=corr,
        )

    def to_ediabas_args(self) -> str:
        """Argument string for EDIABAS job STEUERN_SERVICEHISTORY_ADD."""
        self.validate()
        parts = [
            self.date.day,
            self.date.month,
            self.date.year,
            self.correction,
            self.mileage_km,
            1 if self.bmw_dealer else 0,
            self.dealer_number,
            f"0x{self.status:X}",
            len(self.items),
        ]
        for item in self.items:
            parts += [item.code, f"0x{item.status:X}", item.remaining_distance, item.remaining_time]
        return ";".join(str(p) for p in parts)

    @classmethod
    def from_ediabas_args(cls, args: str) -> ServiceRecord:
        p = [x.strip() for x in args.strip().split(";")]
        if len(p) < 9:
            raise RecordError("too few arguments for STEUERN_SERVICEHISTORY_ADD")
        count = int(p[8], 0)
        items = []
        for i in range(count):
            base = 9 + i * 4
            chunk = p[base : base + 4]
            if not chunk:
                raise RecordError(f"argument list ends before item {i + 1}")
            chunk += ["0"] * (4 - len(chunk))
            items.append(ServiceItem(int(chunk[0], 0), int(chunk[1], 0), int(chunk[2], 0), int(chunk[3], 0)))
        return cls(
            date=dt.date(int(p[2], 0), int(p[1], 0), int(p[0], 0)),
            correction=int(p[3], 0),
            mileage_km=int(p[4], 0),
            bmw_dealer=int(p[5], 0) == 1,
            dealer_number=p[6],
            status=int(p[7], 0),
            items=items,
        )

    def to_dict(self) -> dict:
        return {
            "date": self.date.isoformat(),
            "mileage_km": self.mileage_km,
            "bmw_dealer": self.bmw_dealer,
            "dealer_number": self.dealer_number,
            "status": self.status,
            "correction": self.correction,
            "items": [i.to_dict() for i in self.items],
        }

    @classmethod
    def from_dict(cls, d: dict) -> ServiceRecord:
        return cls(
            date=dt.date.fromisoformat(d["date"]),
            mileage_km=int(d["mileage_km"]),
            bmw_dealer=bool(d.get("bmw_dealer", False)),
            dealer_number=str(d.get("dealer_number", "")),
            status=int(d.get("status", 1)),
            correction=int(d.get("correction", 0)),
            items=[ServiceItem.from_dict(i) for i in d.get("items", [])],
        )


def find_records(data: bytes) -> list[tuple[int, ServiceRecord]]:
    """Find byte runs that parse as plausible service records in the write layout.

    Used to spot stored history in read responses whose format is unknown.
    """
    found = []
    i = 0
    while i + HEADER.size <= len(data):
        day, month, year, _corr, km, flag, _dealer, status, count = HEADER.unpack_from(data, i)
        end = i + HEADER.size + count * ITEM.size
        plausible = (
            1 <= day <= 31
            and 1 <= month <= 12
            and 1990 <= year <= 2100
            and km < 2_000_000
            and flag in (0, 1)
            and status in RECORD_STATUSES
            and 1 <= count <= MAX_ITEMS
            and end <= len(data)
            and all(
                data[i + HEADER.size + n * ITEM.size] in ITEM_TYPES
                and data[i + HEADER.size + n * ITEM.size + 1] in ITEM_STATUSES
                for n in range(count)
            )
        )
        if plausible:
            try:
                found.append((i, ServiceRecord.decode(data[i:end])))
                i = end
                continue
            except (RecordError, ValueError):
                pass
        i += 1
    return found


def known_entry_patterns(date: dt.date, mileage_km: int | None) -> dict[str, bytes]:
    """Byte patterns for an entry visible in iDrive, in the byte orders a read might use."""
    patterns = {
        "date d/m/yyyy BE": bytes([date.day, date.month]) + date.year.to_bytes(2, "big"),
        "date d/m/yyyy LE": bytes([date.day, date.month]) + date.year.to_bytes(2, "little"),
        "date yyyy/m/d BE": date.year.to_bytes(2, "big") + bytes([date.month, date.day]),
    }
    if mileage_km is not None:
        patterns["km u32 BE"] = mileage_km.to_bytes(4, "big")
        patterns["km u32 LE"] = mileage_km.to_bytes(4, "little")
    return patterns


def parse_tst(text: str) -> tuple[bool, list[ServiceRecord]]:
    """Parse an EDIABAS Toolset32 test file as written by theDeniZ/ServiceManager.

    Lines look like ``2|g_mmi|steuern_servicehistory_add||8;11;2020;0;...``.
    Returns (erase_first, records).
    """
    erase = False
    records = []
    for line in text.splitlines():
        cols = line.strip().split("|")
        if len(cols) < 3:
            continue
        job = cols[2].strip().lower()
        if job == "steuern_servicehistory_erase":
            erase = True
        elif job == "steuern_servicehistory_add":
            args = cols[4] if len(cols) > 4 else ""
            records.append(ServiceRecord.from_ediabas_args(args))
    return erase, records


def dump_tst(records: list[ServiceRecord], erase: bool) -> str:
    lines = []
    if erase:
        lines.append("g_mmi|steuern_servicehistory_erase")
    lines += [f"g_mmi|steuern_servicehistory_add||{r.to_ediabas_args()}" for r in records]
    return "".join(f"{i}|{line}\r\n" for i, line in enumerate(lines, 1))
