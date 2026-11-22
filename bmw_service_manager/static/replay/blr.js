// The BLE CAN Logger's session files (.BLR), read in the browser and turned into a drive log, so
// Drive Replay and Video Overlay open them straight from the logger's USB drive (#31).
//
// The same reading as the Boostbook iOS app's import, which follows the logger's record schema
// (format version 1): a 64-byte session header ("DLOG"), then
// records: 0xA5, type, length, sequence, device time (µs), payload, CRC-16/CCITT-FALSE. Bytes that
// aren't a record with a good CRC are skipped, so a file with a NAND gap or a torn page still
// reads around the damage.
//
// The session becomes the `.bblog` text the iOS app writes for it: the logger's GPS fixes as
// `gps` (with `sv`), its OBD values as `car`, its events as `note`, its accelerometer as `acc`.
// The VIN isn't written: logs get shared.

const SYNC = 0xa5, HEADER = 64, RECORD = 16, CRC = 2, MAX_PAYLOAD = 512;
const T = { GNSS_PVT: 1, OBD_PID: 2, UDS_DID: 3, CAN_RAW: 4, EVENT: 5, TIME_SYNC: 6, IMU: 7, VBAT: 8 };

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), as the logger's records use. */
export function crc16(bytes, from, to) {
  let crc = 0xffff;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Whether these bytes are a logger session: its header, or a .BLR file name (the first page lost). */
export function isBlr(bytes, name = "") {
  return (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === "DLOG") || /\.blr$/i.test(name);
}

function readRecords(bytes, pos) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let skipped = 0, missing = 0, lastSeq = null;
  while (pos + RECORD + CRC <= bytes.length) {
    if (bytes[pos] === SYNC) {
      const n = dv.getUint16(pos + 2, true), end = pos + RECORD + n;
      if (n <= MAX_PAYLOAD && end + CRC <= bytes.length && crc16(bytes, pos + 1, end) === dv.getUint16(end, true)) {
        const seq = dv.getUint32(pos + 4, true);
        if (lastSeq !== null && seq > lastSeq + 1) missing += seq - lastSeq - 1;
        lastSeq = seq;
        records.push({ type: bytes[pos + 1], seq, tUs: dv.getBigUint64(pos + 8, true), payload: bytes.subarray(pos + RECORD, end) });
        pos = end + CRC;
        continue;
      }
    }
    skipped++;
    pos++;
  }
  skipped += Math.max(0, bytes.length - pos);
  return { records, skipped, missing };
}

/** A .BLR file, read: its header (null if it has none) and its good records. */
export function readBlr(bytes) {
  let header = null, pos = 0;
  if (bytes.length >= HEADER && String.fromCharCode(...bytes.subarray(0, 4)) === "DLOG") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const vin = [...bytes.subarray(28, 45)].filter((b) => b !== 0);
    header = {
      version: dv.getUint16(4, true), fwVersion: dv.getUint32(16, true), sessionId: dv.getUint32(20, true),
      vin: vin.length === 17 ? String.fromCharCode(...vin) : null,
    };
    pos = Math.max(dv.getUint16(6, true), HEADER);
  }
  return { header, ...readRecords(bytes, pos) };
}

/** "LOG_00042_20261111-0805.BLR": the session's start, UTC, to the minute. */
export function startInName(name) {
  const m = /(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)/.exec(name || "");
  return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : null;
}

/** u-blox UBX-NAV-PVT, the GNSS record's payload. */
export function navPvt(p) {
  if (p.length < 92) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const valid = p[11], fixType = p[20], flags = p[21];
  let date = null;
  if ((valid & 3) === 3) {
    date = new Date(Date.UTC(dv.getUint16(4, true), p[6] - 1, p[7], p[8], p[9], p[10]) + Math.max(0, dv.getInt32(16, true)) / 1e6);
  }
  return {
    fixType, satellites: p[23], date,
    usable: fixType >= 2 && fixType <= 4 && (flags & 1) !== 0,
    lon: dv.getInt32(24, true) * 1e-7, lat: dv.getInt32(28, true) * 1e-7, alt: dv.getInt32(36, true) / 1000,
    hacc: dv.getUint32(40, true) / 1000, vacc: fixType === 2 ? -1 : dv.getUint32(44, true) / 1000,
    speed: dv.getInt32(60, true) / 1000, course: dv.getInt32(64, true) * 1e-5,
    sacc: dv.getUint32(68, true) / 1000, cacc: dv.getUint32(72, true) * 1e-5,
  };
}

/** The OBD-II values the logger polls (its default list), by SAE J1979's formulas: [channel, value]. */
export function obdValue(pid, d) {
  const a = d.length >= 1 ? d[0] : null, ab = d.length >= 2 ? d[0] * 256 + d[1] : null;
  switch (pid) {
    case 0x04: return a === null ? null : ["Load", a * 100 / 255];
    case 0x05: return a === null ? null : ["Coolant", a - 40];
    case 0x0b: return a === null ? null : ["Manifold", a];
    case 0x0c: return ab === null ? null : ["RPM", ab / 4];
    case 0x0d: return a === null ? null : ["Speed", a];
    case 0x0f: return a === null ? null : ["Intake air", a - 40];
    case 0x11: return a === null ? null : ["Throttle", a * 100 / 255];
    case 0x42: return ab === null ? null : ["Battery", ab / 1000];
    default: return null;
  }
}

/** The channels an imported session can have, as the iOS app's gauges describe them, in its order. */
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

/** What the logger's events say, in the log's notes (null: not worth a note). */
export function eventNote(code, arg) {
  switch (code) {
    case 1: return "Logger started";
    case 2: return "Engine started";
    case 3: return "Engine stopped";
    case 4: return "Logger session ended";
    case 5: return null; // the VIN
    case 6: return "Logger reached the car over ENET";
    case 7: return "No ENET link: the logger reads the car over D-CAN";
    case 8: return "Boostbook connected to the logger";
    case 9: return "Boostbook disconnected from the logger";
    case 10: return "Low battery: the logger shut down to save it";
    case 11: return "GPS fix";
    case 12: return `Logger error ${arg}`;
    case 13: return "Part of the log was lost (a bad storage block)";
    case 14: return `GPS assistance from the phone: ${(arg >>> 8) & 0xfff} frames taken` + ((arg >>> 20) > 0 ? `, ${arg >>> 20} refused` : "");
    case 15: return `GPS first fix after ${(arg / 1000).toFixed(1)} s`;
    case 16: return arg === 50 ? "GPS at 20 Hz while logging"
      : arg > 0 ? `GPS at ${Math.trunc(1000 / arg)} Hz while logging: the module can't do 20 Hz` : `GPS rate ${arg}`;
    default: return `Logger event ${code}`;
  }
}

const num = (v, digits) => +v.toFixed(digits);
const row = (t, key, values, digits) => JSON.stringify({ t: num(t, 3), [key]: values.map((v, k) => num(v, digits[k])) });

/** A logger session as a drive log's text, as the iOS app imports it. `fileName` dates a session without a GPS time. */
export function blrToLog(bytes, fileName = "") {
  const s = readBlr(bytes);
  if (!s.header && !s.records.length) throw new Error(`${fileName || "This file"} isn't a BLE CAN Logger session: it has no session header and no records.`);
  const t0 = s.records[0]?.tUs ?? 0n;
  const t = (r) => (r.tUs >= t0 ? Number(r.tUs - t0) / 1e6 : 0);
  let started = null;
  for (const r of s.records) {
    if (r.type !== T.GNSS_PVT) continue;
    const p = navPvt(r.payload);
    if (p?.date) { started = new Date(p.date.getTime() - t(r) * 1000); break; }
  }
  started ??= startInName(fileName) ?? new Date();

  const when = started.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const source = { device: "ble-can-logger", file: fileName };
  if (s.header) {
    source.session = s.header.sessionId;
    const v = s.header.fwVersion;
    if (v) source.firmware = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;
  }
  const lines = [JSON.stringify({
    accel: "car", app: "Boostbook web", car: {},
    fields: {
      acc: ["x", "y", "z"], baro: ["relalt", "kpa"],
      gps: ["lat", "lon", "alt", "hacc", "vacc", "speed", "sacc", "course", "cacc"],
      motion: ["gx", "gy", "gz", "ax", "ay", "az", "rx", "ry", "rz"],
    },
    format: "boostbook-drive", mount: { preset: "upright" }, name: `Drive ${when} (logger)`,
    simulated: false, source, started: started.toISOString().replace(/\.\d{3}Z$/, "Z"), version: 1,
  })];

  // The logger asks for one value at a time; gather a fifth of a second's into each reading.
  const order = CHANNELS.map((c) => c.name), channels = [];
  let values = {}, bucketStart = 0, lastT = 0;
  const flush = () => {
    const present = order.filter((n) => n in values);
    if (!present.length) return;
    const added = present.filter((n) => !channels.includes(n));
    if (added.length) {
      channels.push(...added);
      lines.push(JSON.stringify({ t: num(lastT, 3), channels: channels.map((n) => CHANNELS.find((c) => c.name === n)) }));
    }
    const body = channels.map((n) => (n in values ? num(values[n], CHANNELS.find((c) => c.name === n).digits + 1) : null));
    lines.push(JSON.stringify({ t: num(lastT, 3), car: body }));
    values = {};
  };
  const add = (name, v, time) => {
    if (name in values || time - bucketStart > 0.2) flush();
    if (!Object.keys(values).length) bucketStart = time;
    values[name] = v;
    lastT = time;
  };

  // The accelerometer's samples, each at its own time, in among the other lines.
  const acc = [];
  for (const r of s.records) {
    if (r.type !== T.IMU || r.payload.length < 8) continue;
    const dv = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    const rate = dv.getUint16(0, true);
    if (!rate) continue;
    const n = Math.floor((r.payload.length - 2) / 6);
    for (let k = 0; k < n; k++) {
      const o = 2 + 6 * k;
      acc.push([t(r) + k / rate, dv.getInt16(o, true) / 1000, dv.getInt16(o + 2, true) / 1000, dv.getInt16(o + 4, true) / 1000]);
    }
  }
  acc.sort((a, b) => a[0] - b[0]);
  let nextAcc = 0;
  const accUpTo = (time) => {
    for (; nextAcc < acc.length && acc[nextAcc][0] <= time; nextAcc++) {
      const a = acc[nextAcc];
      lines.push(row(a[0], "acc", a.slice(1), [3, 3, 3]));
    }
  };

  for (const r of s.records) {
    const time = t(r);
    accUpTo(time);
    const p = r.payload;
    if (r.type === T.GNSS_PVT) {
      const f = navPvt(p);
      if (f?.usable) {
        lines.push(row(time, "gps", [f.lat, f.lon, f.alt, f.hacc, f.vacc, f.speed, f.sacc, f.course, f.cacc], [7, 7, 2, 1, 1, 2, 2, 1, 1]));
        lines.push(JSON.stringify({ t: num(time, 3), sv: f.satellites }));
      }
    } else if (r.type === T.OBD_PID) {
      if (p.length >= 3 && (p[0] & 0x3f) === 0x01) {
        const v = obdValue(p[1], p.subarray(3));
        if (v) add(v[0], v[1], time);
      }
    } else if (r.type === T.VBAT) {
      if (p.length >= 2) add("Battery", (p[0] | (p[1] << 8)) / 1000, time);
    } else if (r.type === T.EVENT) {
      if (p.length >= 6) {
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const text = eventNote(dv.getUint16(0, true), dv.getUint32(2, true));
        if (text) lines.push(JSON.stringify({ t: num(time, 3), note: text }));
      }
    }
    // UDS values, raw CAN and the clock's PPS edges aren't in drive logs yet.
    lastT = Math.max(lastT, time);
  }
  accUpTo(Infinity);
  flush();
  const end = s.records.length ? t(s.records.at(-1)) : 0;
  if (s.missing > 0) lines.push(JSON.stringify({ t: num(end, 3), note: `${s.missing} of the logger's records are missing` }));
  if (s.skipped > 0) lines.push(JSON.stringify({ t: num(end, 3), note: `${s.skipped} damaged bytes in the logger's file were skipped` }));
  lines.push(JSON.stringify({ t: num(end, 3), end: { forward: [0, 0, -1], learnt: false, up: [0, 1, 0] } }));
  return lines.join("\n") + "\n";
}
