"""Service history in QR codes, for Stampbook on an iPhone or iPad to scan. No URL: the
codes carry the records themselves.

A transfer is the history packed as bytes, compressed and written in QR's alphanumeric
mode with Base45 (RFC 9285), the encoding EU COVID certificates use. A long history
is split into numbered parts, one QR code each:

    SB1:<id>:<part>:<parts>:<base45 text>        e.g. "SB1:6GJ0MA:1:2:..."

<id> is the CRC-32 of the packed bytes in Base45: it ties a transfer's parts together
(a part from another transfer is refused) and is checked once they're decoded.

Packed bytes (before compression), version 1:

    01                          format version
    <n> <n bytes>               VIN, ASCII (n = 0: none)
    <n> <n bytes>               car name, UTF-8 (n = 0: none)
    <count, 2 bytes>            number of records
    <record> ...                each in the head unit's own layout (31 01 A0 81's payload),
                                which says how many items follow its 19-byte header
"""

from __future__ import annotations

import struct
import zlib

from .records import HEADER, ITEM, RecordError, ServiceRecord

PREFIX = "SB1"
VERSION = 1
# Base45 characters per QR code: small enough that a phone camera reads it off a laptop screen.
PART_CHARS = 900

B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"


def b45encode(data: bytes) -> str:
    out = []
    for i in range(0, len(data) - 1, 2):
        n = data[i] * 256 + data[i + 1]
        c, n = divmod(n, 45 * 45)
        e, d = divmod(n, 45)
        out += [B45[d], B45[e], B45[c]]
    if len(data) % 2:
        e, d = divmod(data[-1], 45)
        out += [B45[d], B45[e]]
    return "".join(out)


def b45decode(text: str) -> bytes:
    try:
        v = [B45.index(ch) for ch in text]
    except ValueError:
        raise RecordError("not Base45 text") from None
    out = bytearray()
    for i in range(0, len(v), 3):
        chunk = v[i : i + 3]
        if len(chunk) == 3:
            n = chunk[0] + chunk[1] * 45 + chunk[2] * 45 * 45
            if n > 0xFFFF:
                raise RecordError("not Base45 text")
            out += n.to_bytes(2, "big")
        elif len(chunk) == 2:
            n = chunk[0] + chunk[1] * 45
            if n > 0xFF:
                raise RecordError("not Base45 text")
            out.append(n)
        else:
            raise RecordError("not Base45 text")
    return bytes(out)


def pack(records: list[ServiceRecord], vin: str = "", name: str = "") -> bytes:
    vin_b, name_b = (vin or "").strip().upper().encode("ascii"), (name or "").strip().encode("utf-8")
    if len(vin_b) > 255 or len(name_b) > 255:
        raise RecordError("VIN or name too long")
    if len(records) > 0xFFFF:
        raise RecordError("too many records")
    out = bytes([VERSION, len(vin_b)]) + vin_b + bytes([len(name_b)]) + name_b + struct.pack(">H", len(records))
    return out + b"".join(r.encode() for r in records)


def unpack(data: bytes) -> tuple[str, str, list[ServiceRecord]]:
    try:
        if data[0] != VERSION:
            raise RecordError(f"made by a newer version (format {data[0]})")
        i = 1
        vin = data[i + 1 : i + 1 + data[i]].decode("ascii"); i += 1 + data[i]
        name = data[i + 1 : i + 1 + data[i]].decode("utf-8"); i += 1 + data[i]
        (count,) = struct.unpack_from(">H", data, i); i += 2
        records = []
        for _ in range(count):
            size = HEADER.size + data[i + HEADER.size - 1] * ITEM.size
            records.append(ServiceRecord.decode(data[i : i + size])); i += size
    except (IndexError, struct.error, UnicodeDecodeError, ValueError) as e:
        raise RecordError(f"not a complete service history ({e})") from None
    if i != len(data):
        raise RecordError("not a complete service history (extra data)")
    return vin, name, records


def to_parts(records: list[ServiceRecord], vin: str = "", name: str = "", part_chars: int = PART_CHARS) -> list[str]:
    """The QR codes' text for a history, in order."""
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)  # raw DEFLATE (RFC 1951): what Apple's COMPRESSION_ZLIB reads
    data = pack(records, vin, name)
    tag = b45encode(zlib.crc32(data).to_bytes(4, "big"))
    text = b45encode(deflate.compress(data) + deflate.flush())
    chunks = [text[i : i + part_chars] for i in range(0, len(text), part_chars)] or [""]
    return [f"{PREFIX}:{tag}:{n}:{len(chunks)}:{c}" for n, c in enumerate(chunks, 1)]


def from_parts(parts: list[str]) -> tuple[str, str, list[ServiceRecord]]:
    """A history from all of its QR codes' text, in any order."""
    found: dict[int, str] = {}
    total = tag = None
    for p in parts:
        bits = p.split(":", 4)
        if len(bits) != 5 or bits[0] != PREFIX or len(bits[1]) != 6 or not bits[2].isdigit() or not bits[3].isdigit():
            raise RecordError("not a Stampbook QR code")
        n, of = int(bits[2]), int(bits[3])
        if tag not in (None, bits[1]) or total not in (None, of) or not 1 <= n <= of:
            raise RecordError("QR codes from different transfers")
        tag, total = bits[1], of
        found[n] = bits[4]
    if total is None or len(found) != total:
        raise RecordError(f"{len(found)} of {total} QR codes")
    try:
        data = zlib.decompress(b45decode("".join(found[n] for n in range(1, total + 1))), -15)
    except zlib.error:
        raise RecordError("damaged QR code") from None
    if b45encode(zlib.crc32(data).to_bytes(4, "big")) != tag:
        raise RecordError("damaged QR code (checksum)")
    return unpack(data)


def qr_svgs(parts: list[str]) -> list[str]:
    """Each part as an SVG QR code (error correction M: survives a little screen glare)."""
    import segno

    return [segno.make_qr(p, error="m", boost_error=False).svg_inline(scale=6, border=4, dark="#000", light="#fff") for p in parts]
