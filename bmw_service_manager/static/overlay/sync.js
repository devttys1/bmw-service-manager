// Lining a video up with a drive log: the offset in seconds from the video's clock to the log's
// (drive time = video time + offset).
//
// 1. A GoPro's GPS stamps its fixes in UTC (GPSU, GPS9), and the log says when it started
//    (header.started, to the second): that puts them within a second or two.
// 2. The GoPro's GPS speed against the drive's speed (the car's Speed, else the iPhone's GPS)
//    pins it to a tenth of a second, and finds it without (1) if it has to, by searching the
//    whole drive.
// 3. The GoPro's accelerometer against the iPhone's (how hard the car is speeding up, braking or
//    turning, whichever way the camera faces) fine-tunes it to a frame or two: the accelerometers
//    have no lag; GPS has some.
//
// Without GoPro telemetry there's the video file's creation time, which is only as good as the
// camera's clock (GoPros keep local time and call it UTC), so it's a starting point to adjust by
// hand.

import { value, at } from "../replay/drivelog.js";

const STEP = 0.1; // the speed series' spacing, s
const G = 9.80665;

/** The drive's speed every STEP s (m/s), NaN where unknown: the car's Speed, else the iPhone's GPS. */
export function driveSpeed(drive) {
  const n = Math.floor(drive.duration / STEP) + 1;
  const v = new Float32Array(n);
  const car = drive.byName.Speed;
  for (let i = 0; i < n; i++) {
    const t = i * STEP;
    const s = car ? value(drive, "Speed", t) / 3.6 : NaN;
    v[i] = Number.isFinite(s) ? s : drive.hasGps ? at(drive, drive.speed, t) : NaN;
  }
  return v;
}

/** The GoPro's GPS speed every STEP s of video (m/s), NaN between fixes more than 1.5 s apart. */
export function videoSpeed(tel, duration) {
  const n = Math.floor(duration / STEP) + 1;
  const v = new Float32Array(n).fill(NaN);
  const g = tel.gps;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = i * STEP;
    while (k + 1 < g.length && g[k + 1].t <= t) k++;
    if (!g.length || t < g[0].t || k + 1 >= g.length) continue;
    const a = g[k], b = g[k + 1];
    if (b.t - a.t > 1.5) continue;
    v[i] = a.speed + (b.speed - a.speed) * (t - a.t) / (b.t - a.t);
  }
  return v;
}

/** RMS of (video − drive) speed with the video shifted by `offset`; null if under `minOverlap` samples overlap. */
function speedMismatch(vs, ds, offset, minOverlap) {
  const shift = offset / STEP;
  let sum = 0, c = 0;
  for (let i = 0; i < vs.length; i += 2) {
    const a = vs[i];
    if (Number.isNaN(a)) continue;
    const f = i + shift, j = Math.floor(f);
    if (j < 0 || j + 1 >= ds.length) continue;
    const b = ds[j] + (ds[j + 1] - ds[j]) * (f - j);
    if (Number.isNaN(b)) continue;
    sum += (a - b) ** 2; c++;
  }
  return c >= minOverlap ? Math.sqrt(sum / c) : null;
}

/** The offset in [lo, hi] where the speeds agree best, searching at `step` then finer: {offset, rms}. */
function bestSpeedOffset(vs, ds, lo, hi, step, minOverlap) {
  let best = null;
  const scan = (a, b, s) => {
    for (let o = a; o <= b + 1e-9; o += s) {
      const rms = speedMismatch(vs, ds, o, minOverlap);
      if (rms !== null && (!best || rms < best.rms)) best = { offset: o, rms };
    }
  };
  scan(lo, hi, step);
  for (const s of [step / 5, step / 25].filter((s) => s >= 0.02)) {
    if (!best) break;
    const c = best.offset;
    scan(c - 5 * s, c + 5 * s, s);
  }
  return best;
}

/** How hard the camera is being pushed about, whichever way it faces: |acceleration − gravity| across gravity, in g, every 0.04 s. */
function videoShove(tel, duration) {
  const a = tel.accel;
  if (a.length < 50) return null;
  const rate = 25, n = Math.floor(duration * rate) + 1;
  // Gravity: the reading averaged over 2 s; the push: what's left, square to gravity, over 0.2 s.
  const prefix = [[0, 0, 0]];
  for (const s of a) { const p = prefix.at(-1); prefix.push([p[0] + s.x, p[1] + s.y, p[2] + s.z]); }
  const ts = a.map((s) => s.t);
  const idx = (t) => { let lo = 0, hi = ts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
  const mean = (t0, t1) => {
    const i0 = idx(t0), i1 = idx(t1);
    if (i1 <= i0) return null;
    const p = prefix[i1], q = prefix[i0], c = i1 - i0;
    return [(p[0] - q[0]) / c, (p[1] - q[1]) / c, (p[2] - q[2]) / c];
  };
  const out = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const g = mean(t - 1, t + 1), m = mean(t - 0.1, t + 0.1);
    if (!g || !m) continue;
    const gl = Math.hypot(...g);
    if (gl < 1) continue;
    const u = g.map((v) => v / gl), d = [m[0] - g[0], m[1] - g[1], m[2] - g[2]];
    const along = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
    out[i] = Math.hypot(d[0] - along * u[0], d[1] - along * u[1], d[2] - along * u[2]) / G;
  }
  return out;
}

/**
 * The car's push from the iPhone, every 0.04 s of the drive, filtered as videoShove's is: the
 * camera's gravity (a 2 s average) takes in the push that lasts, so the same is taken off here,
 * or a long bend or pull would shift the match.
 */
function driveShove(drive) {
  if (!drive.hasMotion) return null;
  const n = drive.n, w = drive.rate; // ±1 s
  const pl = new Float64Array(n + 1), pa = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { pl[i + 1] = pl[i] + drive.longG[i]; pa[i + 1] = pa[i] + drive.latG[i]; }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const i0 = Math.max(0, i - w), i1 = Math.min(n, i + w), c = i1 - i0;
    out[i] = Math.hypot(drive.longG[i] - (pl[i1] - pl[i0]) / c, drive.latG[i] - (pa[i1] - pa[i0]) / c);
  }
  return out; // drive.rate is 25 a second, the same spacing as videoShove's
}

/** Pearson correlation of the video's push against the drive's with the video shifted by `offset` s. */
function shoveCorrelation(vs, ds, offset, rate, stride = 1) {
  const shift = Math.round(offset * rate);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, c = 0;
  for (let i = 0; i < vs.length; i += stride) {
    const j = i + shift;
    if (j < 0 || j >= ds.length) continue;
    const a = vs[i], b = ds[j];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; c++;
  }
  if (c * stride < rate * 10) return null;
  const cov = sab / c - (sa / c) * (sb / c), va = saa / c - (sa / c) ** 2, vb = sbb / c - (sb / c) ** 2;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/** The best accelerometer match within ±span of `around`: {offset, r} or null. */
function bestShoveOffset(vs, ds, around, span, rate = 25) {
  let best = null;
  for (let k = -Math.round(span * rate); k <= Math.round(span * rate); k++) {
    const o = around + k / rate;
    const r = shoveCorrelation(vs, ds, o, rate);
    if (r !== null && (!best || r > best.r)) best = { offset: o, r };
  }
  return best;
}

/** Seconds from the log's start to `date`, or null without a start time. */
const logTime = (drive, date) => (drive.started && date ? (date - drive.started) / 1000 : null);

/**
 * The offset (drive time = video time + offset) and how it was found:
 * {offset, method: "gps" | "gps-search" | "accel" | "clock" | "none", detail (a sentence), good (bool),
 *  speed: {video, drive} series for the sync chart}.
 */
export function autoSync(drive, mp4, tel) {
  const duration = mp4.duration;
  const ds = driveSpeed(drive);
  const result = { offset: 0, method: "none", good: false, detail: "", speed: { drive: ds, video: null, step: STEP } };
  const shove = tel?.accel?.length ? [videoShove(tel, duration), driveShove(drive)] : null;
  const fine = (offset) => {
    // The accelerometers to a frame or two, if they agree clearly.
    if (!shove?.[0] || !shove[1]) return null;
    const b = bestShoveOffset(shove[0], shove[1], offset, 1.5);
    return b && b.r > 0.45 ? b : null;
  };

  if (tel?.gps?.length > 20) {
    const vs = videoSpeed(tel, duration);
    result.speed.video = vs;
    const moving = tel.gps.filter((g) => g.speed > 2).length / tel.gps.length;
    const minOverlap = Math.min(150, Math.floor(vs.filter((v) => !Number.isNaN(v)).length / 4)); // samples looked at: every other one
    // The GPS's UTC against the log's start.
    const clock = tel.utc.length && drive.started
      ? tel.utc.map((u) => logTime(drive, u.date) - u.t).sort((a, b) => a - b)[tel.utc.length >> 1] : null;
    let best = null, method = "gps";
    if (clock !== null) best = bestSpeedOffset(vs, ds, clock - 5, clock + 5, 0.5, minOverlap);
    if (!best || best.rms > 2) {
      // No clock, or it doesn't fit: try everywhere the video could sit in the drive.
      const wide = bestSpeedOffset(vs, ds, -duration * 0.9, drive.duration - duration * 0.1, 0.5, minOverlap);
      if (wide && (!best || wide.rms < best.rms)) { best = wide; method = "gps-search"; }
    }
    if (best) {
      const f = fine(best.offset);
      result.offset = f ? f.offset : best.offset;
      result.method = method;
      const kmh = (best.rms * 3.6).toFixed(1);
      result.good = best.rms < 1.5 && moving > 0.1;
      result.detail = (method === "gps"
        ? `Lined up by the GoPro's GPS time and speed (speeds within ${kmh} km/h)`
        : `Found by matching the GoPro's GPS speed along the drive (within ${kmh} km/h)`)
        + (f ? `, then its accelerometer (r = ${f.r.toFixed(2)}).` : ".")
        + (moving <= 0.1 ? " The car hardly moves in this video, so check it." : "");
      return result;
    }
  }

  // A GoPro without a GPS fix: its accelerometer alone, along the whole drive.
  if (shove?.[0] && shove[1]) {
    const clock = logTime(drive, mp4.created);
    const around = clock !== null && clock > -duration && clock < drive.duration ? clock : null;
    let b = null;
    if (around !== null) b = bestShoveOffset(shove[0], shove[1], around, 30);
    if (!b || b.r < 0.5) {
      // Coarse search of the whole drive at 0.2 s, then fine around the best.
      let coarse = null;
      for (let o = -duration * 0.9; o <= drive.duration - duration * 0.1; o += 0.2) {
        const r = shoveCorrelation(shove[0], shove[1], o, 25, 5);
        if (r !== null && (!coarse || r > coarse.r)) coarse = { offset: o, r };
      }
      if (coarse) b = bestShoveOffset(shove[0], shove[1], coarse.offset, 0.3);
    }
    if (b && b.r > 0.5) {
      result.offset = b.offset; result.method = "accel"; result.good = b.r > 0.65;
      result.detail = `Found by matching the GoPro's accelerometer with the iPhone's (r = ${b.r.toFixed(2)}). The GoPro had no GPS fix.`;
      return result;
    }
  }

  // The camera's clock.
  const clock = logTime(drive, mp4.created);
  if (clock !== null && clock > -duration && clock < drive.duration) {
    result.offset = clock; result.method = "clock";
    result.detail = "From the video's creation time: only as good as the camera's clock. Check it, and adjust.";
    return result;
  }
  result.detail = "Nothing in the video says when it was taken. Line it up by hand.";
  return result;
}
