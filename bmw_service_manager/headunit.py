"""Head-unit service history operations over HSFZ.

Write path (observed in SHM.exe): erase ``31 01 A0 80``, one ``31 01 A0 81 <record>``
per record, then ECU reset ``11 01``. All requests go to diagnostic address 0x63.

There is no known read command. ``probe_*`` methods are read-only experiments to
look for one.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from .hsfz import HsfzClient, HsfzError, NegativeResponse
from .records import ServiceRecord, find_records

HEAD_UNIT = 0x63
# DiagnosticSessionControl steps to reach each session. BimmerLink enters the
# BMW-specific session 0x42 on the head unit by way of extended (0x03).
SESSION_PATHS = {0x01: (0x01,), 0x03: (0x03,), 0x42: (0x03, 0x42)}
ROUTINE_ERASE = 0xA080
ROUTINE_ADD = 0xA081

RESULT_TEXTS = {
    # Not in the PRG result table, but what an NBT Evo returns for an accepted
    # record (observed live; BimmerManager 1.0.5 fixed NBT uploads "incorrectly
    # showing as failed", which matches).
    0x00: "OK (NBT)",
    0x01: "Everything OK",
    0x02: "Out of memory",
    0x03: "Data inconsistency",
    0x04: "No writing permission",
    0x05: "Unknown error",
}


def routine_start(routine: int, data: bytes = b"") -> bytes:
    return bytes([0x31, 0x01]) + routine.to_bytes(2, "big") + data


def erase_request() -> bytes:
    return routine_start(ROUTINE_ERASE)


def add_request(record: ServiceRecord) -> bytes:
    return routine_start(ROUTINE_ADD, record.encode())


def reset_request() -> bytes:
    return bytes([0x11, 0x01])


def write_plan(records: Iterable[ServiceRecord], erase: bool, reset: bool) -> list[tuple[str, bytes]]:
    """The UDS requests a write would send, in order, without touching the car."""
    plan = [("Erase service history", erase_request())] if erase else []
    plan += [(f"Add record {r.date.isoformat()} / {r.mileage_km} km", add_request(r)) for r in records]
    if reset:
        plan.append(("Restart head unit", reset_request()))
    return plan


@dataclass
class StepResult:
    label: str
    request: str
    ok: bool
    response: str = ""
    detail: str = ""

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def _routine_status(response: bytes) -> tuple[bool, str]:
    if len(response) < 5:
        return True, "positive response (no status byte)"
    code = response[4]
    return code in (0x00, 0x01), f"0x{code:02X} {RESULT_TEXTS.get(code, 'unknown')}"


class HeadUnit:
    def __init__(self, client: HsfzClient, address: int = HEAD_UNIT):
        self.client = client
        self.address = address

    def _step(self, label: str, request: bytes) -> StepResult:
        try:
            response = self.client.request(self.address, request)
        except (HsfzError, OSError) as e:
            return StepResult(label, request.hex(" "), False, detail=str(e))
        ok, detail = (True, "OK") if request[0] == 0x11 else _routine_status(response)
        return StepResult(label, request.hex(" "), ok, response.hex(" "), detail)

    def write_history(
        self,
        records: list[ServiceRecord],
        erase: bool = True,
        reset: bool = True,
        on_step: Callable[[StepResult], None] | None = None,
    ) -> list[StepResult]:
        results = []
        for label, request in write_plan(records, erase, reset):
            result = self._step(label, request)
            results.append(result)
            if on_step:
                on_step(result)
            if not result.ok:
                break
            # SHM pauses 200 ms after the erase and 100 ms after each add.
            time.sleep(0.2 if request[:4] == erase_request() else 0.1)
        return results

    def enter_session(self, session: int) -> None:
        for step in SESSION_PATHS[session]:
            self.client.request(self.address, bytes([0x10, step]))

    def tester_present(self) -> None:
        try:
            self.client.request(self.address, bytes([0x3E, 0x00]))
        except NegativeResponse:
            pass

    def probe_routine_results(self) -> list[StepResult]:
        """Ask for the results of the service-history routines (UDS 31 03). Read-only."""
        results = []
        for routine in (ROUTINE_ADD, ROUTINE_ERASE):
            request = bytes([0x31, 0x03]) + routine.to_bytes(2, "big")
            try:
                response = self.client.request(self.address, request)
                results.append(StepResult(f"Results of 0x{routine:04X}", request.hex(" "), True, response.hex(" ")))
            except (HsfzError, OSError) as e:
                results.append(StepResult(f"Results of 0x{routine:04X}", request.hex(" "), False, detail=str(e)))
        return results

    def probe_dids(
        self,
        start: int,
        end: int,
        patterns: dict[str, bytes] | None = None,
        on_hit: Callable[[dict], None] | None = None,
        on_progress: Callable[[int], None] | None = None,
        should_stop: Callable[[], bool] = lambda: False,
        keep_alive: float | None = None,
    ) -> list[dict]:
        """ReadDataByIdentifier (0x22) over a DID range. Read-only.

        Returns every DID that answered positively, flagging data that contains
        any of ``patterns`` (e.g. a known entry's date and mileage) or that
        parses as service records in the write layout. ``keep_alive`` sends
        tester-present at that interval (seconds) so a non-default session holds.
        """
        hits = []
        last_alive = time.monotonic()
        for did in range(start, end + 1):
            if should_stop():
                break
            if keep_alive and time.monotonic() - last_alive >= keep_alive:
                self.tester_present()
                last_alive = time.monotonic()
            if on_progress:
                on_progress(did)
            request = bytes([0x22]) + did.to_bytes(2, "big")
            try:
                response = self.client.request(self.address, request)
            except NegativeResponse:
                continue
            except (HsfzError, OSError) as e:
                hit = {"did": f"0x{did:04X}", "error": str(e)}
                hits.append(hit)
                if on_hit:
                    on_hit(hit)
                break
            data = response[3:]
            hit = {
                "did": f"0x{did:04X}",
                "length": len(data),
                "data": data.hex(" "),
                "matches": [name for name, pat in (patterns or {}).items() if pat in data],
                "records": [
                    {"offset": off, **rec.to_dict()} for off, rec in find_records(data)
                ],
            }
            hits.append(hit)
            if on_hit:
                on_hit(hit)
        return hits
