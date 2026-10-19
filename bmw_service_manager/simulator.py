"""A fake ENET gateway + head unit for development without a car.

It implements only what this tool sends: erase/add routines, ECU reset,
session changes, CBS reads and the DME and cluster CBS resets, and negative responses for everything else. It does NOT model how a real head unit
answers read requests, because that is unknown.
"""

from __future__ import annotations

import socketserver
import threading

from .hsfz import CTRL_ACK, CTRL_DIAG, HEADER
from .records import RecordError, ServiceRecord

HEAD_UNIT = 0x63
KOMBI = 0x60
DME = 0x12
DSC = 0x29

# CBS slots as read from a real F-series cluster (oil overdue by 3000 km), plus
# made-up wear-sensor brake-pad slots (0x4102, 0x4106) in the documented layout.
CBS_SAMPLE = {
    0x4101: "0001 0006 000f 000c fed4 0019 000c 0b03 00000000",
    0x4102: "0002 fd05 001e 0000 7d00 0000 0000 0903 00000000",
    0x4106: "0006 fd03 001e 0000 7d00 0000 0000 0903 00000000",
    0x4103: "0003 0003 0000 0018 0000 0019 000b 0a03 00000000",
    0x4120: "0020 0088 0000 0000 0000 001a 0001 0a03 00000000",
    0x4164: "0064 1e02 003c 0030 0a8c 001b 000c 0b03 00000000",
    0x4104: "ffff ffff ffff ffff ffff ffff ffff ffff ffffffff",
}


class SimulatedKombi:
    """CBS slots from CBS_SAMPLE; a CBS reset write updates availability and the reset count."""

    def __init__(self) -> None:
        self.cbs = {did: bytes.fromhex(data.replace(" ", "")) for did, data in CBS_SAMPLE.items()}
        self.writes: list[bytes] = []

    def handle(self, uds: bytes) -> bytes:
        if uds[0] == 0x22 and len(uds) == 3:
            did = int.from_bytes(uds[1:3], "big")
            if did in self.cbs:
                return bytes([0x62]) + uds[1:3] + self.cbs[did]
        if uds[:3] == bytes.fromhex("2E1001") and len(uds) == 15:
            self.writes.append(uds[3:])
            self.mirror(uds)
            return bytes.fromhex("6E1001")
        return bytes([0x7F, uds[0], 0x31])

    def mirror(self, uds: bytes) -> None:
        """Apply a CBS reset write (`2E 10 01 …`) to the item's slot."""
        slot = 0x4100 + uds[4]
        if slot in self.cbs:
            record = bytearray(self.cbs[slot])
            if uds[5] <= 150:
                record[2] = uds[5]
            if uds[6] == 31:
                record[3] = (record[3] & 0x80) | ((record[3] & 0x7F) + 1)
            self.cbs[slot] = bytes(record)


class SimulatedDme:
    """Accepts writes to DID 0x1001 and reads back the last one (the real read format is unknown)."""

    def __init__(self) -> None:
        self.cbs = bytes.fromhex("01 01 00 00 00 00 06 00 00 00 00 ff")
        self.writes: list[bytes] = []

    def handle(self, uds: bytes) -> bytes:
        if uds == bytes.fromhex("221001"):
            return bytes.fromhex("621001") + self.cbs
        if uds[:3] == bytes.fromhex("2E1001") and len(uds) > 3:
            self.writes.append(uds[3:])
            self.cbs = uds[3:]
            return bytes.fromhex("6E1001")
        return bytes([0x7F, uds[0], 0x31])


class SimulatedDsc:
    """Accepts the CBS reset for the brake pads it owns."""

    def __init__(self) -> None:
        self.writes: list[bytes] = []

    def handle(self, uds: bytes) -> bytes:
        if uds[:3] == bytes.fromhex("2E1001") and len(uds) == 15:
            self.writes.append(uds[3:])
            return bytes.fromhex("6E1001")
        return bytes([0x7F, uds[0], 0x31])


class SimulatedHeadUnit:
    def __init__(self) -> None:
        self.records: list[ServiceRecord] = []
        self.resets = 0
        self.session = 0x01
        self.sessions: list[int] = []
        self.lock = threading.Lock()

    def handle(self, uds: bytes) -> bytes:
        with self.lock:
            if uds[:4] == bytes.fromhex("3101A080"):
                self.records.clear()
                return bytes.fromhex("7101A08001")
            if uds[:4] == bytes.fromhex("3101A081"):
                try:
                    self.records.append(ServiceRecord.decode(uds[4:]))
                except (RecordError, ValueError):
                    return bytes.fromhex("7101A08103")
                return bytes.fromhex("7101A08101")
            if uds[0] == 0x10 and len(uds) == 2 and uds[1] in (0x01, 0x03, 0x42):
                if uds[1] == 0x42 and self.session != 0x03:
                    return bytes.fromhex("7F1022")
                self.session = uds[1]
                self.sessions.append(uds[1])
                return bytes([0x50, uds[1]]) + bytes.fromhex("012B01F4")
            if uds == bytes.fromhex("3E00"):
                return bytes.fromhex("7E00")
            if uds == bytes.fromhex("1101"):
                self.resets += 1
                return bytes.fromhex("5101")
            return bytes([0x7F, uds[0], 0x11 if uds[0] not in (0x22, 0x31) else 0x31])


class _Handler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        sock = self.request
        hu: SimulatedHeadUnit = self.server.head_unit
        while True:
            header = _recv_exact(sock, HEADER.size)
            if not header:
                return
            length, control = HEADER.unpack(header)
            payload = _recv_exact(sock, length)
            if payload is None or control != CTRL_DIAG or len(payload) < 3:
                continue
            tester, target, uds = payload[0], payload[1], payload[2:]
            sock.sendall(HEADER.pack(len(payload), CTRL_ACK) + payload)
            ecu = {HEAD_UNIT: hu, KOMBI: self.server.kombi, DME: self.server.dme, DSC: self.server.dsc}.get(target)
            if ecu is None:
                continue
            reply = ecu.handle(uds)
            if target in (DME, DSC) and reply[:1] == b"\x6e":
                self.server.kombi.mirror(uds)  # the cluster displays items other ECUs own
            response = bytes([target, tester]) + reply
            sock.sendall(HEADER.pack(len(response), CTRL_DIAG) + response)


def _recv_exact(sock, n: int) -> bytes | None:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start(host: str = "127.0.0.1", port: int = 0) -> tuple[_Server, SimulatedHeadUnit]:
    """Start the simulator in a background thread; returns (server, head_unit)."""
    server = _Server((host, port), _Handler)
    server.head_unit = SimulatedHeadUnit()
    server.kombi = SimulatedKombi()
    server.dme = SimulatedDme()
    server.dsc = SimulatedDsc()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.head_unit
