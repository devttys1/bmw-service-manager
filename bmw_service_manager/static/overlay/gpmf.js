// GoPro's telemetry (GPMF, github.com/gopro/gpmf-parser), from the "gpmd" track of a GoPro
// video: its GPS (with UTC time) and accelerometer, on the video's own clock. That's what lines
// a GoPro video up with a drive log: the GPS's UTC time against the log's start, then the GPS's
// speed against the drive's.
//
// GPMF is key-length-value: a 4-character key, a type character, the size of one sample, and how
// many there are; the data padded to 4 bytes. Type 0 holds more KLVs (DEVC → STRM → GPS5 …).

import { readSamples, sampleTime } from "./mp4.js";

const SIZES = { b: 1, B: 1, c: 1, s: 2, S: 2, l: 4, L: 4, f: 4, d: 8, j: 8, J: 8, q: 4, Q: 8, U: 16, F: 4, G: 16 };

/** The KLVs in bytes [start, end): {key, type, size, repeat, body}. */
function* klvs(dv, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const key = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos + 1), dv.getUint8(pos + 2), dv.getUint8(pos + 3));
    const type = String.fromCharCode(dv.getUint8(pos + 4));
    const size = dv.getUint8(pos + 5), repeat = dv.getUint16(pos + 6);
    const len = size * repeat;
    if (key === "\0\0\0\0") return;
    if (pos + 8 + len > end) return;
    yield { key, type: dv.getUint8(pos + 4) === 0 ? "\0" : type, size, repeat, body: pos + 8 };
    pos += 8 + ((len + 3) & ~3);
  }
}

/** One value of a basic type at o. */
function read(dv, type, o) {
  switch (type) {
    case "b": return dv.getInt8(o);
    case "B": return dv.getUint8(o);
    case "s": return dv.getInt16(o);
    case "S": return dv.getUint16(o);
    case "l": return dv.getInt32(o);
    case "L": return dv.getUint32(o);
    case "f": return dv.getFloat32(o);
    case "d": return dv.getFloat64(o);
    case "j": return Number(dv.getBigInt64(o));
    case "J": return Number(dv.getBigUint64(o));
    default: return NaN;
  }
}

/** A KLV's numbers as rows (one per repeat), each `size / typeSize` values; `types` for complex ('?') ones. */
function rows(dv, k, types) {
  const out = [];
  const each = types ? [...types] : null;
  const width = each ? each.reduce((s, t) => s + SIZES[t], 0) : SIZES[k.type];
  if (!width) return out;
  const per = each ? each.length : k.size / width;
  for (let r = 0; r < k.repeat; r++) {
    const row = [];
    let o = k.body + r * k.size;
    for (let c = 0; c < per; c++) {
      const t = each ? each[c] : k.type;
      row.push(read(dv, t, o));
      o += SIZES[t];
    }
    out.push(row);
  }
  return out;
}

const text = (dv, k) => {
  let s = "";
  for (let i = 0; i < k.size * k.repeat; i++) { const c = dv.getUint8(k.body + i); if (c) s += String.fromCharCode(c); }
  return s;
};

/** GPSU's "yymmddhhmmss.sss" as a Date (UTC). */
function gpsu(s) {
  const m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  const sec = parseFloat(m[6]);
  return new Date(Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0) + sec * 1000);
}

/** The streams in one gpmd sample: [{key (GPS5, GPS9, ACCL, …), rows, scale, gpsu, fix, dop}]. */
export function parsePayload(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  for (const devc of klvs(dv, 0, bytes.byteLength)) {
    if (devc.key !== "DEVC" || devc.type !== "\0") continue;
    for (const strm of klvs(dv, devc.body, devc.body + devc.size * devc.repeat)) {
      if (strm.key !== "STRM" || strm.type !== "\0") continue;
      // Sticky values (SCAL, TYPE, GPSU …) come before the data they apply to.
      const meta = { scale: null, types: null, gpsu: null, fix: null, dop: null, tick: null };
      for (const k of klvs(dv, strm.body, strm.body + strm.size * strm.repeat)) {
        if (k.key === "SCAL") meta.scale = rows(dv, k).map((r) => r[0]);
        else if (k.key === "TYPE") meta.types = text(dv, k);
        else if (k.key === "GPSU") meta.gpsu = gpsu(text(dv, k));
        else if (k.key === "GPSF") meta.fix = read(dv, k.type, k.body);
        else if (k.key === "GPSP") meta.dop = read(dv, k.type, k.body) / 100;
        else if (k.key === "TSMP" || k.key === "STMP") meta.tick = read(dv, k.type, k.body);
        else if (["GPS5", "GPS9", "ACCL", "GYRO", "GRAV"].includes(k.key)) {
          const data = rows(dv, k, k.type === "?" ? meta.types : null);
          out.push({ key: k.key, rows: data, scale: meta.scale, gpsu: meta.gpsu, fix: meta.fix, dop: meta.dop });
        }
      }
    }
  }
  return out;
}

/** Rows divided by their SCAL (one per column, or one for all). */
const scaled = (s) => s.rows.map((r) => r.map((v, i) => v / (s.scale ? s.scale[Math.min(i, s.scale.length - 1)] || 1 : 1)));

/**
 * A GoPro video's telemetry on the video's clock (seconds):
 * gps: [{t, lat, lon, alt, speed (m/s, 2D), fix}], utc: [{t, date}] (from GPSU or GPS9),
 * accel: [{t, x, y, z}] m/s². Empty when the video has no gpmd track.
 */
export async function readTelemetry(mp4, onProgress) {
  const track = mp4.tracks.find((t) => t.format === "gpmd");
  const out = { gps: [], utc: [], accel: [], found: !!track };
  if (!track) return out;
  const n = track.table.n;
  await readSamples(mp4.file, track, 0, n, async (i, bytes) => {
    const t0 = sampleTime(track, i), dur = track.table.durations[i] / track.timescale;
    for (const s of parsePayload(bytes)) {
      const v = scaled(s);
      const at = (k) => t0 + dur * k / v.length;
      if (s.key === "GPS5") {
        // GPSU is the time of the payload's first fix (GoPro rounds it to the millisecond).
        if (s.gpsu && (s.fix ?? 3) >= 2) out.utc.push({ t: t0, date: s.gpsu });
        if ((s.fix ?? 3) < 2) continue;
        v.forEach((r, k) => out.gps.push({ t: at(k), lat: r[0], lon: r[1], alt: r[2], speed: r[3], fix: s.fix }));
      } else if (s.key === "GPS9") {
        // lat, lon, alt, speed 2D, speed 3D, days since 2000, seconds since midnight, DOP, fix.
        v.forEach((r, k) => {
          if (r[8] < 2) return;
          out.gps.push({ t: at(k), lat: r[0], lon: r[1], alt: r[2], speed: r[3], fix: r[8] });
          if (k === 0) out.utc.push({ t: at(k), date: new Date(Date.UTC(2000, 0, 1) + (r[5] * 86400 + r[6]) * 1000) });
        });
      } else if (s.key === "ACCL") {
        v.forEach((r, k) => out.accel.push({ t: at(k), x: r[0], y: r[1], z: r[2] }));
      }
    }
    onProgress?.((i + 1) / n);
  });
  return out;
}
