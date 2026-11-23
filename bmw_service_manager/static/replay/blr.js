// The BLE CAN Logger's session files (.BLR), read in the browser, and turned into a drive log
// (.bblog) for Drive Replay: the same reading and the same log as the iOS app's import
// (ios-app/Sources/BMWService/BoostbookCore/Blr.swift), so a session plays the same wherever it's opened.
//
// A .BLR file is a 64-byte session header, then records: 0xA5, type, length, sequence, device
// time (µs), payload, CRC-16. The layout is generated from the logger's schema into
// blr-schema.js (ios-app/tools/blr/gen_blr.py). Bytes that aren't a record with a good CRC are
// skipped, so a file with a NAND gap or a torn page still reads around the damage.
//
// The log has the logger's GPS fixes as `gps` (with `sv`), its OBD values as `car`, its events as
// `note` and its accelerometer as `acc`. It has no phone motion (`m`), which Drive Replay plays
// without. The file never leaves the browser.

import { SYNC, MAX_PAYLOAD, CRC_SIZE, SESSION_HEADER as H, RECORD_HEADER as R, RECORD_TYPE, PAYLOAD, ENUM } from "./blr-schema.js";

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over bytes[from, to). */
export function crc16(bytes, from = 0, to = bytes.length) {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

const MAGIC = [...H.magicText].map((c) => c.charCodeAt(0));

/** Whether `bytes` start like a logger session (its header), for telling one from a .bblog. */
export function looksLikeBlr(bytes, name = "") {
  return MAGIC.every((b, i) => bytes[i] === b) || (/\.blr$/i.test(name) && bytes[0] === SYNC);
}

/** A .BLR file, read: { header, records: [{type, seq, tUs (BigInt), payload}], skippedBytes, missingRecords }. */
export function readBlr(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (i) => view.getUint16(i, true), u32 = (i) => view.getUint32(i, true);
  let header = null, pos = 0;
  if (bytes.length >= H.size && MAGIC.every((b, i) => bytes[H.magic + i] === b)) {
    const vin = [...bytes.subarray(H.vin, H.vin + 17)].filter((b) => b !== 0);
    header = {
      version: u16(H.version), deviceId: [...bytes.subarray(H.deviceId, H.deviceId + 8)], fwVersion: u32(H.fwVersion),
      sessionId: u32(H.sessionId), wakeReasons: u32(H.wakeReasons),
      vin: vin.length === 17 ? String.fromCharCode(...vin) : null,
    };
    pos = Math.max(u16(H.headerSize), H.size);
  }
  const records = [];
  let skippedBytes = 0, missingRecords = 0, lastSeq = null;
  while (pos + R.size + CRC_SIZE <= bytes.length) {
    if (bytes[pos] === SYNC) {
      const n = u16(pos + R.len), end = pos + R.size + n;
      if (n <= MAX_PAYLOAD && end + CRC_SIZE <= bytes.length && crc16(bytes, pos + 1, end) === u16(end)) {
        const seq = u32(pos + R.seq);
        if (lastSeq !== null && seq > ((lastSeq + 1) >>> 0)) missingRecords += seq - lastSeq - 1;
        lastSeq = seq;
        records.push({ type: bytes[pos + R.type], seq, tUs: view.getBigUint64(pos + R.tUs, true), payload: bytes.slice(pos + R.size, end) });
        pos = end + CRC_SIZE;
        continue;
      }
    }
    skippedBytes++;
    pos++;
  }
  skippedBytes += bytes.length - pos;
  return { header, records, skippedBytes, missingRecords };
}

/** u-blox UBX-NAV-PVT, the GNSS record's payload; null if too short. */
export function navPvt(p) {
  if (p.length < 92) return null;
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const i32 = (i) => v.getInt32(i, true), u32 = (i) => v.getUint32(i, true);
  const valid = p[11], fixType = p[20], flags = p[21];
  let date = null;
  if ((valid & 0x03) === 0x03) {   // validDate and validTime
    const ms = Date.UTC(v.getUint16(4, true), p[6] - 1, p[7], p[8], p[9], p[10]);
    date = new Date(ms + Math.max(0, i32(16)) / 1e6);
  }
  return {
    valid, fixType, flags, satellites: p[23],
    lon: i32(24) * 1e-7, lat: i32(28) * 1e-7, altitude: i32(36) / 1000,
    horizontalAccuracy: u32(40) / 1000, verticalAccuracy: u32(44) / 1000,
    speed: i32(60) / 1000, course: i32(64) * 1e-5, speedAccuracy: u32(68) / 1000, courseAccuracy: u32(72) * 1e-5,
    date,
    /** A 2D or 3D fix (or GNSS + dead reckoning) the receiver vouches for. */
    usable: fixType >= 2 && fixType <= 4 && (flags & 1) !== 0,
  };
}

// The channels a session can have, as the app's gauges describe them (LiveData.swift's GAUGES,
// then Blr.swift's own two), in the app's order: a log's channels are listed in this order.
const CHANNELS = [
  { name: "RPM", unit: "rpm", group: "Engine", digits: 0, min: 0, max: 5000 },
  { name: "Coolant", unit: "°C", group: "Engine", digits: 0, min: 40, max: 130 },
  { name: "Intake air", unit: "°C", group: "Engine", digits: 0, min: -20, max: 80 },
  { name: "Load", unit: "%", group: "Engine", digits: 0, min: 0, max: 100 },
  { name: "Battery", unit: "V", group: "Engine", digits: 1, min: 10, max: 16 },
  { name: "Speed", unit: "km/h", group: "Chassis", digits: 0, min: 0, max: 200 },
  { name: "Throttle", unit: "%", group: "Engine", digits: 0, min: 0, max: 100 },
  { name: "Manifold", unit: "kPa", group: "Engine", digits: 0, min: 0, max: 255 },
];

/** A service 01 response's value (data: the bytes after the PID) by SAE J1979's formulas: [channel, value] or null. */
export function obdValue(pid, d) {
  const a = d.length >= 1 ? d[0] : null, ab = d.length >= 2 ? d[0] * 256 + d[1] : null;
  const one = (name, f) => (a === null ? null : [name, f(a)]), two = (name, f) => (ab === null ? null : [name, f(ab)]);
  switch (pid) {
    case 0x04: return one("Load", (x) => (x * 100) / 255);
    case 0x05: return one("Coolant", (x) => x - 40);
    case 0x0b: return one("Manifold", (x) => x);
    case 0x0c: return two("RPM", (x) => x / 4);
    case 0x0d: return one("Speed", (x) => x);
    case 0x0f: return one("Intake air", (x) => x - 40);
    case 0x11: return one("Throttle", (x) => (x * 100) / 255);
    case 0x42: return two("Battery", (x) => x / 1000);
    default: return null;
  }
}

/** What a logger event says, as a note in the log; null for the VIN (logs get shared). */
export function eventNote(code, arg) {
  switch (ENUM.EVENT_CODE[code]) {
    case "BOOT": return "Logger started";
    case "ENGINE_START": return "Engine started";
    case "ENGINE_STOP": return "Engine stopped";
    case "SESSION_END": return "Logger session ended";
    case "VIN": return null;
    case "ENET_LINK": return "Logger reached the car over ENET";
    case "DCAN_ONLY": return "No ENET link: the logger reads the car over D-CAN";
    case "TUNNEL_OPEN": return "Boostbook connected to the logger";
    case "TUNNEL_CLOSE": return "Boostbook disconnected from the logger";
    case "LOW_BATTERY": return "Low battery: the logger shut down to save it";
    case "GNSS_FIX": return "GPS fix";
    case "ERROR": return `Logger error ${arg}`;
    case "NAND_GAP": return "Part of the log was lost (a bad storage block)";
    case "GNSS_ASSIST": return `GPS assistance from the phone: ${(arg >>> 8) & 0xfff} frames taken` + (arg >>> 20 > 0 ? `, ${arg >>> 20} refused` : "");
    case "GNSS_TTFF": return `GPS first fix after ${(arg / 1000).toFixed(1)} s`;
    case "GNSS_RATE": return arg === 50 ? "GPS at 20 Hz while logging"
      : arg > 0 ? `GPS at ${Math.floor(1000 / arg)} Hz while logging: the module can't do 20 Hz` : `GPS rate ${arg}`;
    default: return `Logger event ${code}`;
  }
}

/** A JSON number with at most `digits` decimals and no trailing zeros, as the app writes them. */
export function jsonNumber(v, digits) {
  if (!Number.isFinite(v)) return "null";
  let s = v.toFixed(digits);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

/** JSON with its keys sorted, as the app's JSONSerialization(.sortedKeys) writes a header. */
function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const VIN = /^[A-Z0-9]{17}$/;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** "LOG_00042_20261111-0805.BLR": the session's start, UTC, to the minute; null if not in the name. */
export function startInName(name) {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(name);
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : null;
}

/**
 * A .BLR file (`bytes`, named `fileName`) as a drive log: { text, vin, session }. `vin` is the VIN
 * the logger read, which isn't written in the log (logs get shared). Throws if it isn't a logger
 * session at all.
 */
export function blrToLog(bytes, fileName = "session.BLR", { app = "Drive Replay (web)" } = {}) {
  const s = readBlr(bytes);
  if (!s.header && !s.records.length) throw new Error(`${fileName} isn't a BLE CAN Logger session: it has no session header and no records.`);
  const t0 = s.records.length ? s.records[0].tUs : 0n;
  const t = (r) => (r.tUs >= t0 ? Number(r.tUs - t0) / 1e6 : 0);
  let started = null;
  for (const r of s.records) {
    if (r.type !== RECORD_TYPE.GNSS_PVT) continue;
    const p = navPvt(r.payload);
    if (p?.date) { started = new Date(p.date.getTime() - t(r) * 1000); break; }
  }
  started ??= startInName(fileName) ?? new Date();
  let vin = s.header?.vin ?? null;
  if (!vin) {
    const ev = s.records.find((r) => r.type === RECORD_TYPE.EVENT && r.payload.length >= PAYLOAD.EVENT.size
      && (r.payload[PAYLOAD.EVENT.code] | (r.payload[PAYLOAD.EVENT.code + 1] << 8)) === 5);
    const text = ev ? String.fromCharCode(...ev.payload.subarray(PAYLOAD.EVENT.text).filter((b) => b !== 0)).trim().toUpperCase() : "";
    vin = VIN.test(text) ? text : null;
  }

  const source = { device: "ble-can-logger", file: fileName };
  if (s.header) {
    source.session = s.header.sessionId;
    const v = s.header.fwVersion;
    if (v) source.firmware = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;
  }
  const when = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(started);
  const lines = [sortedJson({
    format: "boostbook-drive", version: 1, name: `Drive ${when} (logger)`, started: iso(started), app, simulated: false,
    car: { name: "", model: "" }, mount: { preset: "upright" }, accel: "car",
    fields: {
      gps: ["lat", "lon", "alt", "hacc", "vacc", "speed", "sacc", "course", "cacc"],
      motion: ["gx", "gy", "gz", "ax", "ay", "az", "rx", "ry", "rz"], baro: ["relalt", "kpa"], acc: ["x", "y", "z"],
    },
    source,
  })];
  const row = (time, key, values, digits) => `{"t":${jsonNumber(time, 3)},"${key}":[${values.map((v, i) => jsonNumber(v, digits[i])).join(",")}]}`;
  const note = (text, time) => lines.push(`{"t":${jsonNumber(time, 3)},"note":${JSON.stringify(text)}}`);

  // The logger asks for one value at a time; gather a fifth of a second's into each reading.
  const channels = [];
  let values = new Map(), bucketStart = 0, lastT = 0;
  const carRow = (time) => {
    const present = CHANNELS.filter((c) => values.has(c.name));
    const added = present.filter((c) => !channels.includes(c));
    if (added.length) {
      channels.push(...added);
      lines.push(sortedJson({ t: +jsonNumber(time, 3), channels: channels.map(({ name, unit, group, digits, min, max }) => ({ name, unit, group, digits, min, max })) }));
    }
    lines.push(`{"t":${jsonNumber(time, 3)},"car":[${channels.map((c) => (values.has(c.name) ? jsonNumber(values.get(c.name), c.digits + 1) : "null")).join(",")}]}`);
  };
  const flush = () => { if (values.size) carRow(lastT); values = new Map(); };
  const add = (name, v, time) => {
    if (values.has(name) || time - bucketStart > 0.2) flush();
    if (!values.size) bucketStart = time;
    values.set(name, v);
    lastT = time;
  };

  // The accelerometer's samples, each at its own time: a record is stamped with its first sample
  // and written 0.1 s later, so they go in among the other lines by time.
  const acc = [];
  for (const r of s.records) {
    if (r.type !== RECORD_TYPE.IMU || r.payload.length < PAYLOAD.IMU.size + 6) continue;
    const v = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    const rate = v.getUint16(PAYLOAD.IMU.rateHz, true);
    if (!rate) continue;
    const n = Math.floor((r.payload.length - PAYLOAD.IMU.size) / 6);
    for (let k = 0; k < n; k++) {
      const o = PAYLOAD.IMU.size + 6 * k, g = (i) => v.getInt16(o + i, true) / 1000;
      acc.push([t(r) + k / rate, g(0), g(2), g(4)]);
    }
  }
  acc.sort((a, b) => a[0] - b[0]);
  let nextAcc = 0;
  const accUpTo = (time) => {
    for (; nextAcc < acc.length && acc[nextAcc][0] <= time; nextAcc++) {
      const [at, x, y, z] = acc[nextAcc];
      lines.push(row(at, "acc", [x, y, z], [3, 3, 3]));
    }
  };

  for (const r of s.records) {
    const time = t(r), p = r.payload;
    accUpTo(time);
    if (r.type === RECORD_TYPE.GNSS_PVT) {
      const f = navPvt(p);
      if (f?.usable) {
        const vacc = f.fixType === 2 ? -1 : f.verticalAccuracy;
        lines.push(row(time, "gps", [f.lat, f.lon, f.altitude, f.horizontalAccuracy, vacc, f.speed, f.speedAccuracy, f.course, f.courseAccuracy], [7, 7, 2, 1, 1, 2, 2, 1, 1]));
        lines.push(`{"t":${jsonNumber(time, 3)},"sv":${f.satellites}}`);
      }
    } else if (r.type === RECORD_TYPE.OBD_PID) {
      const o = PAYLOAD.OBD_PID;
      const value = p.length >= o.size && (p[o.service] & 0x3f) === 0x01 ? obdValue(p[o.pid], p.subarray(o.data)) : null;
      if (value) add(value[0], value[1], time);
    } else if (r.type === RECORD_TYPE.VBAT) {
      if (p.length >= PAYLOAD.VBAT.size) add("Battery", (p[0] | (p[1] << 8)) / 1000, time);
    } else if (r.type === RECORD_TYPE.EVENT) {
      if (p.length >= PAYLOAD.EVENT.size) {
        const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const text = eventNote(v.getUint16(PAYLOAD.EVENT.code, true), v.getUint32(PAYLOAD.EVENT.arg, true));
        if (text !== null) note(text, time);
      }
    }
    // UDS values, raw CAN and the clock's PPS edges aren't in drive logs yet.
    lastT = Math.max(lastT, time);
  }
  accUpTo(Infinity);
  flush();
  const end = s.records.length ? t(s.records[s.records.length - 1]) : 0;
  if (s.missingRecords > 0) note(`${s.missingRecords} of the logger's records are missing`, end);
  if (s.skippedBytes > 0) note(`${s.skippedBytes} damaged bytes in the logger's file were skipped`, end);
  lines.push(sortedJson({ t: +jsonNumber(end, 3), end: { forward: [0, 0, -1], up: [0, 1, 0], learnt: false } }));
  return { text: lines.join("\n") + "\n", vin, session: s };
}
