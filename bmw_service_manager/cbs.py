"""Condition Based Service (CBS): read from the instrument cluster, reset in the ECU that owns each item.

Layout of DID 0x41xx (xx = CBS item code), decoded on an F-series cluster and
checked against what the car displayed (oil -3000 km due 12/2025, brake fluid
due 11/2025, statutory inspection due 01/2026):

    item u16 | availability % u8 | flag bit + reset count (7 bits) u8
    | distance interval u16 (x1000 km) | time interval u16 (months)
    | remaining distance s16 (x10 km) | due year u16 (since 2000, 0 = none)
    | due month u16 | status 2 bytes | 4 bytes

Availability, reset count and intervals were identified by reading engine oil
before and after a reset from the cluster menu (0% -> 100%, count 6 -> 7,
15,000 km / 12 months unchanged). The top flag bit (set after that reset) and
the status bytes are not identified. Unused slots return all 0xFF.

DME (0x12) DID 0x1001 is its CBS block: read it for status (22 10 01), write
it to reset (2E 10 01). The layout comes from ISTA+'s CBS_RESET /
CBS_DATEN_LESEN jobs. The F48 B47 DDE (D83BX7C0) is CBS version 6, which adds a
"show service" flag (0 = show), presumably in the high nibble of the unit byte:

    write: count | item | availability % | services (31 = +1) | remaining u16
           (0x8000 = no change) | unit (0xF = no change) | forecast km/1000
           (0xFF = no change) | due month (0x0F = no change) | due year - 2000
           (0x3F = no change) | forecast months (0xFF = no change) | reserved
    read:  item | remaining u16 | unit (1 = x10 km) | services | availability %
           | forecast km/1000 | due month | due year - 2000 | forecast months
           | status | reserved

A reset sends ISTA+'s default CBS_RESET request for one item: 100%, service
count +1, everything else unchanged. For engine oil that is the write BimmerLink's
reset got 6E 10 01 for. The cluster (KOMBRDCT) resets its own items, such as
brake fluid, with the identical job and request at its own address.
"""

from __future__ import annotations

import datetime as dt
import struct
from dataclasses import dataclass

from .hsfz import HsfzClient, NegativeResponse
from .records import ITEM_TYPES

KOMBI = 0x60
DME = 0x12
DSC = 0x29
CBS_DID = 0x1001
OIL = 0x01
BRAKE_FLUID = 0x03
# Which ECU owns each item's reset, from the CBS_RESET job comments ("Kombi-Umfaenge"
# vs "externe Umfaenge") and the BimmerLink capture. All take the same request.
RESET_ECU = {
    OIL: DME, 0x0D: DME,  # engine oil, NOx additive
    0x02: DSC, 0x06: DSC,  # front / rear brake pads
    BRAKE_FLUID: KOMBI, 0x11: KOMBI, 0x14: KOMBI, 0x15: KOMBI,
    0x20: KOMBI, 0x21: KOMBI, 0x64: KOMBI,  # inspections and checks
}
ECU_NAMES = {KOMBI: "cluster", DME: "DME", DSC: "DSC"}
# CBS codes (the CbsKennung table) that differ from or are missing in ITEM_TYPES.
CBS_NAMES = {
    0x02: "Front brake pads", 0x05: "Service Inclusive", 0x06: "Rear brake pads",
    0x0D: "NOx additive", 0x11: "Vehicle check", 0x20: "Statutory inspection",
    0x21: "Emissions test", 0x64: "Vehicle check",
}
CBS_DID_BASE = 0x4100
RECORD = struct.Struct(">HBBHHhHH")
NO_DISTANCE = 32000  # x10 km; shown for wear-sensor items (brakes) without a distance limit


@dataclass
class CbsItem:
    code: int
    availability: int | None
    resets: int
    flag: bool
    interval_km: int | None
    interval_months: int | None
    remaining_km: int | None
    due: dt.date | None
    raw: bytes

    @property
    def name(self) -> str:
        return CBS_NAMES.get(self.code) or ITEM_TYPES.get(self.code, f"Item 0x{self.code:02X}")

    def overdue(self, today: dt.date) -> bool:
        late_km = self.remaining_km is not None and self.remaining_km < 0
        late_date = self.due is not None and (self.due.year, self.due.month) < (today.year, today.month)
        return late_km or late_date

    def to_dict(self, today: dt.date | None = None) -> dict:
        today = today or dt.date.today()
        return {
            "code": self.code,
            "name": self.name,
            "owner": ECU_NAMES[owner(self.code)],
            "availability": self.availability,
            "resets": self.resets,
            "flag": self.flag,
            "interval_km": self.interval_km,
            "interval_months": self.interval_months,
            "remaining_km": self.remaining_km,
            "due": self.due.strftime("%m/%Y") if self.due else None,
            "overdue": self.overdue(today),
            "raw": self.raw.hex(" "),
        }


def decode(data: bytes) -> CbsItem | None:
    if len(data) < RECORD.size or data[:2] == b"\xff\xff":
        return None
    code, avail, count, dist_iv, time_iv, dist, year, month = RECORD.unpack_from(data)
    due = dt.date(2000 + year, month, 1) if year and 1 <= month <= 12 else None
    # Date-only items (no distance interval) report 0; wear-sensor brakes report NO_DISTANCE.
    remaining = None if dist == NO_DISTANCE or (dist_iv == 0 and dist == 0) else dist * 10
    return CbsItem(
        code=code,
        availability=avail if avail <= 100 else None,  # wear-sensor brakes report 0xFD
        resets=count & 0x7F,
        flag=bool(count & 0x80),
        interval_km=dist_iv * 1000 or None,
        interval_months=time_iv or None,
        remaining_km=remaining,
        due=due,
        raw=data,
    )


def read_cbs(client: HsfzClient, last: int = 0x7F) -> list[CbsItem]:
    """Read CBS slots 0x4100..0x41<last> from the instrument cluster."""
    items = []
    for slot in range(1, last + 1):  # 0x4100 is a summary block, not a CBS record
        did = CBS_DID_BASE + slot
        try:
            response = client.request(KOMBI, bytes([0x22]) + did.to_bytes(2, "big"))
        except NegativeResponse:
            continue
        item = decode(response[3:])
        if item and item.code == slot:
            items.append(item)
    return items


def read_dme_status(client: HsfzClient) -> bytes | None:
    """The DME's raw CBS status (22 10 01), or None if it refuses."""
    try:
        return client.request(DME, bytes([0x22]) + CBS_DID.to_bytes(2, "big"))[3:]
    except NegativeResponse:
        return None


def read_item(client: HsfzClient, code: int) -> CbsItem | None:
    """One CBS slot from the instrument cluster, or None if it's empty or refused."""
    try:
        response = client.request(KOMBI, bytes([0x22]) + (CBS_DID_BASE + code).to_bytes(2, "big"))
    except NegativeResponse:
        return None
    item = decode(response[3:])
    return item if item and item.code == code else None


def reset_payload(item: int) -> bytes:
    """ISTA+'s CBS_RESET default: one item, 100%, services +1, remaining/unit/forecast/due unchanged."""
    return bytes([0x01, item, 100, 31, 0x80, 0x00, 0x0F, 0xFF, 0x0F, 0x3F, 0xFF, 0x00])


def reset_request(item: int = OIL) -> bytes:
    return bytes([0x2E]) + CBS_DID.to_bytes(2, "big") + reset_payload(item)


def owner(item: int) -> int:
    """The ECU that resets `item`. Unlisted items go to the cluster, which stores every
    slot; it answers with a negative response if it isn't the owner."""
    return RESET_ECU.get(item, KOMBI)


def reset_cbs(client: HsfzClient, item: int = OIL) -> None:
    """Reset one CBS item in the ECU that owns it; raises on a negative response."""
    client.request(owner(item), reset_request(item))
