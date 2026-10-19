"""BMW ENET (HSFZ) transport: vehicle discovery over UDP and UDS requests over TCP.

Frame: 4-byte big-endian length, 2-byte big-endian control word, payload.
For diagnostic frames (control 0x0001) the payload is source address,
target address, then the UDS message, and the length counts all of it.
"""

from __future__ import annotations

import ipaddress
import select
import socket
import struct
import time
from dataclasses import dataclass, field

import ifaddr

DIAG_PORT = 6801
DISCOVERY_PORT = 6811
TESTER_ADDRESS = 0xF4

CTRL_DIAG = 0x0001
CTRL_ACK = 0x0002
CTRL_VEHICLE_IDENT = 0x0011
CTRL_ALIVE_CHECK = 0x0012
CTRL_ALIVE_CHECK_RESPONSE = 0x0013

CTRL_ERRORS = {
    0x0040: "incorrect tester address",
    0x0041: "incorrect control word",
    0x0042: "incorrect format",
    0x0043: "incorrect destination address",
    0x0044: "message too large",
    0x0045: "diagnostic application not ready",
    0x00FF: "out of memory",
}

NRC_NAMES = {
    0x10: "generalReject",
    0x11: "serviceNotSupported",
    0x12: "subFunctionNotSupported",
    0x13: "incorrectMessageLengthOrInvalidFormat",
    0x14: "responseTooLong",
    0x21: "busyRepeatRequest",
    0x22: "conditionsNotCorrect",
    0x24: "requestSequenceError",
    0x31: "requestOutOfRange",
    0x33: "securityAccessDenied",
    0x72: "generalProgrammingFailure",
    0x78: "responsePending",
    0x7E: "subFunctionNotSupportedInActiveSession",
    0x7F: "serviceNotSupportedInActiveSession",
}

HEADER = struct.Struct(">IH")


class HsfzError(Exception):
    pass


class NegativeResponse(HsfzError):
    def __init__(self, sid: int, nrc: int):
        self.sid = sid
        self.nrc = nrc
        super().__init__(f"negative response to 0x{sid:02X}: 0x{nrc:02X} {NRC_NAMES.get(nrc, 'unknown')}")


@dataclass
class Vehicle:
    ip: str
    vin: str = ""
    mac: str = ""
    diag_address: str = ""

    def to_dict(self) -> dict:
        return {"ip": self.ip, "vin": self.vin, "mac": self.mac, "diag_address": self.diag_address}


def _field(text: str, key: str, length: int) -> str:
    i = text.find(key)
    return text[i + len(key) : i + len(key) + length] if i >= 0 else ""


def parse_ident_reply(ip: str, data: bytes) -> Vehicle:
    text = data[HEADER.size :].decode("ascii", errors="replace")
    return Vehicle(
        ip=ip,
        vin=_field(text, "BMWVIN", 17),
        mac=_field(text, "BMWMAC", 12),
        diag_address=_field(text, "DIAGADR", 2),
    )


def _interface_broadcasts() -> list[tuple[str, str]]:
    """(local address, subnet broadcast) for every non-loopback IPv4 interface."""
    pairs = []
    for adapter in ifaddr.get_adapters():
        for ip in adapter.ips:
            if not isinstance(ip.ip, str) or ip.ip.startswith("127.") or ip.network_prefix >= 31:
                continue
            net = ipaddress.ip_network(f"{ip.ip}/{ip.network_prefix}", strict=False)
            pairs.append((ip.ip, str(net.broadcast_address)))
    return pairs


def discover(timeout: float = 2.0) -> list[Vehicle]:
    """Broadcast a vehicle identification request on every interface and collect replies.

    Each interface gets its own socket bound to its address; otherwise macOS
    sends broadcasts out of the primary interface (usually Wi-Fi) only.
    """
    request = HEADER.pack(0, CTRL_VEHICLE_IDENT)
    found: dict[str, Vehicle] = {}
    sockets = []
    try:
        for local, broadcast in _interface_broadcasts() or [("", "255.255.255.255")]:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sockets.append(s)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                s.bind((local, 0))
                s.setblocking(False)
                for target in (broadcast, "255.255.255.255"):
                    s.sendto(request, (target, DISCOVERY_PORT))
            except OSError:
                continue
        deadline = time.monotonic() + timeout
        while (remaining := deadline - time.monotonic()) > 0:
            readable, _, _ = select.select(sockets, [], [], remaining)
            if not readable:
                break
            for s in readable:
                try:
                    data, (ip, _port) = s.recvfrom(4096)
                except OSError:
                    continue
                if len(data) > HEADER.size and HEADER.unpack_from(data)[1] == CTRL_VEHICLE_IDENT:
                    found[ip] = parse_ident_reply(ip, data)
    finally:
        for s in sockets:
            s.close()
    return list(found.values())


def identify(host: str, timeout: float = 1.0) -> Vehicle | None:
    """Ask one gateway for its identity (VIN) with a unicast identification request; None if it doesn't answer."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.settimeout(timeout)
            s.sendto(HEADER.pack(0, CTRL_VEHICLE_IDENT), (host, DISCOVERY_PORT))
            deadline = time.monotonic() + timeout
            while (remaining := deadline - time.monotonic()) > 0:
                s.settimeout(remaining)
                data, (ip, _port) = s.recvfrom(4096)
                if len(data) > HEADER.size and HEADER.unpack_from(data)[1] == CTRL_VEHICLE_IDENT:
                    return parse_ident_reply(ip, data)
        except OSError:
            pass
    return None


def reachable(host: str, port: int = DIAG_PORT, timeout: float = 1.0) -> bool:
    """True if something accepts a TCP connection on the diagnostic port."""
    try:
        socket.create_connection((host, port), timeout=timeout).close()
        return True
    except OSError:
        return False


@dataclass
class HsfzClient:
    host: str
    port: int = DIAG_PORT
    tester: int = TESTER_ADDRESS
    timeout: float = 5.0
    pending_timeout: float = 30.0
    log: list[tuple[str, str]] = field(default_factory=list)
    _sock: socket.socket | None = None

    def __enter__(self) -> HsfzClient:
        self.connect()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def connect(self) -> None:
        self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def close(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            finally:
                self._sock = None

    def _send(self, control: int, payload: bytes) -> None:
        frame = HEADER.pack(len(payload), control) + payload
        self.log.append(("tx", frame.hex(" ")))
        self._sock.sendall(frame)

    def _recv_exact(self, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = self._sock.recv(n - len(buf))
            if not chunk:
                raise HsfzError("connection closed by gateway")
            buf += chunk
        return buf

    def _recv(self, timeout: float) -> tuple[int, bytes]:
        self._sock.settimeout(timeout)
        try:
            header = self._recv_exact(HEADER.size)
            length, control = HEADER.unpack(header)
            payload = self._recv_exact(length)
        except (TimeoutError, socket.timeout) as e:
            raise HsfzError("timed out waiting for the gateway") from e
        self.log.append(("rx", (header + payload).hex(" ")))
        return control, payload

    def request(self, target: int, uds: bytes) -> bytes:
        """Send one UDS request and return the positive response (starting with SID + 0x40)."""
        if self._sock is None:
            raise HsfzError("not connected")
        self._send(CTRL_DIAG, bytes([self.tester, target]) + uds)
        timeout = self.timeout
        while True:
            control, payload = self._recv(timeout)
            if control == CTRL_ACK:
                continue
            if control == CTRL_ALIVE_CHECK:
                self._send(CTRL_ALIVE_CHECK_RESPONSE, bytes([0x00, self.tester]))
                continue
            if control in CTRL_ERRORS:
                raise HsfzError(f"gateway error 0x{control:04X}: {CTRL_ERRORS[control]}")
            if control != CTRL_DIAG or len(payload) < 3:
                continue
            src, dst, response = payload[0], payload[1], payload[2:]
            if src != target or dst != self.tester:
                continue
            if response[0] == 0x7F and len(response) >= 3:
                if response[2] == 0x78:
                    timeout = self.pending_timeout
                    continue
                raise NegativeResponse(response[1], response[2])
            if response[0] == uds[0] + 0x40:
                return response
            raise HsfzError(f"unexpected response {response.hex(' ')}")
