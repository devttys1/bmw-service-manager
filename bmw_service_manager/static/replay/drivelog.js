// Drive logs from the iOS app's Logger tab (docs/drive-logging.md): reading them, and working
// out what the car did at every moment, for Drive Replay.
//
// A log holds the iPhone's sensors as they came (motion 25 or 50 times a second, GPS about once
// a second, the barometer) and the car's values as the gauges read them. `processLog` puts it all
// on one timeline, RATE samples a second:
//
// - Position: the GPS fixes, joined by curves whose direction and speed at each fix are the
//   GPS's own (Doppler) speed and course, so the car moves smoothly between fixes.
// - Pitch and roll: gravity in the phone, against the car's up and forward in the phone's axes.
//   Up is from Level (gravity on level ground) if it was set, else gravity averaged while parked.
//   Forward is learnt from the drive: the phone's acceleration lines up with the car's forward
//   axis when it speeds up or brakes (GPS), and averages out across it in bends.
// - Heading: the gyro's turn rate about the car's up, held to the GPS course while moving.
// - Height: the barometer's changes, set to the GPS's average height; else the GPS's, smoothed.
//
// Car axes follow ISO 8855: forward, left, up. Lateral g and yaw rate are positive to the left.

export const RATE = 25;
const G = 9.80665;
const DEG = Math.PI / 180;

// MARK: vectors (plain arrays)

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? scale(a, 1 / l) : a; };
const reject = (a, n) => sub(a, scale(n, dot(a, n)));
export const wrap180 = (d) => ((d + 540) % 360) - 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The car's up and forward in the phone's axes for each mount preset (x: screen right, y: screen top, z: out of the screen). */
const PRESETS = {
  upright: { up: [0, 1, 0], forward: [0, 0, -1] },
  flat: { up: [0, 0, 1], forward: [0, 1, 0] },
};

// MARK: reading

/** The log's text, from a File, Blob, ArrayBuffer or Response: gzipped (.bblog.gz) or not. */
export async function readLog(source) {
  let bytes;
  if (source instanceof ArrayBuffer) bytes = new Uint8Array(source);
  else if (source instanceof Uint8Array) bytes = source;
  else bytes = new Uint8Array(await source.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

/** The log's lines, sorted by kind. Lines that don't parse (a cut-off last line) are skipped. */
export function parseLog(text) {
  const lines = text.split("\n");
  let header = null;
  try { header = JSON.parse(lines[0]); } catch { /* not JSON */ }
  if (!header || header.format !== "boostbook-drive") throw new Error("This isn't a Boostbook drive log (.bblog).");
  if (header.version > 1) throw new Error("This log is from a newer Boostbook. Update the web app to open it.");
  const raw = {
    header, motion: [], gps: [], baro: [], car: [], marks: [], notes: [], end: null,
    channels: [], // every channel, in the order first seen
  };
  // The motion's acceleration is the way the car accelerates ("accel": "car"); a real iPhone's
  // logs without it (builds up to 14) have Core Motion's, which points the other way.
  const flip = !header.simulated && header.accel !== "car" ? -1 : 1;
  let current = []; // the latest channel list: indexes into raw.channels
  const byName = new Map();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const t = row.t;
    if (typeof t !== "number") continue;
    if (row.m) { const m = row.m; raw.motion.push([t, m[0], m[1], m[2], flip * m[3], flip * m[4], flip * m[5], m[6], m[7], m[8]]); }
    else if (row.gps) raw.gps.push([t, ...row.gps]);
    else if (row.baro) raw.baro.push([t, ...row.baro]);
    else if (row.car) {
      const values = {};
      row.car.forEach((v, k) => { if (v !== null && current[k] !== undefined) values[raw.channels[current[k]].name] = v; });
      raw.car.push([t, values]);
    } else if (row.channels) {
      current = row.channels.map((c) => {
        if (!byName.has(c.name)) { byName.set(c.name, raw.channels.length); raw.channels.push(c); }
        return byName.get(c.name);
      });
    } else if (row.mark !== undefined) raw.marks.push({ t, label: row.mark });
    else if (row.note !== undefined) raw.notes.push({ t, text: row.note });
    else if (row.end) raw.end = { t, ...row.end, forward: row.end.forward?.map((v) => flip * v) };
  }
  return raw;
}

// MARK: working it out

/** Index of the last element of sorted `ts` at or before t (−1 if none). */
export function before(ts, t) {
  let lo = 0, hi = ts.length - 1;
  if (hi < 0 || t < ts[0]) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Metres east and north of `origin`, and back: flat-earth, plenty for a drive. */
function projector(origin) {
  const kx = 111320 * Math.cos(origin.lat * DEG), ky = 110574;
  return {
    xy: (lat, lon) => [(lon - origin.lon) * kx, (lat - origin.lat) * ky],
    ll: (x, y) => [origin.lat + y / ky, origin.lon + x / kx],
  };
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1];
}

/**
 * The car's up and forward in the phone's axes, and how they were found.
 * `fixes` are good GPS fixes [t, ..., speed at 6].
 */
export function solveMount(raw, fixes) {
  const { header, motion } = raw;
  const preset = PRESETS[header.mount?.preset] || PRESETS.upright;
  let up, upFrom;
  if (header.mount?.level?.length === 3) { up = norm(scale(header.mount.level, -1)); upFrom = "level"; }
  else if (motion.length) {
    // Gravity while parked (speed under 0.5 m/s); if never parked, over the whole drive.
    const fixT = fixes.map((f) => f[0]);
    let sum = [0, 0, 0], n = 0;
    for (const m of motion) {
      const k = before(fixT, m[0]);
      if (k >= 0 && fixes[k][6] >= 0 && fixes[k][6] < 0.5) { sum = [sum[0] + m[1], sum[1] + m[2], sum[2] + m[3]]; n++; }
    }
    if (n < 50) { sum = [0, 0, 0]; n = 0; for (const m of motion) { sum = [sum[0] + m[1], sum[1] + m[2], sum[2] + m[3]]; n++; } }
    up = norm(scale(sum, -1 / n)); upFrom = n ? "parked" : "preset";
  } else { up = preset.up; upFrom = "preset"; }

  // Forward: speeding up and braking (GPS) against the phone's acceleration square to up.
  let acc = [0, 0, 0], weight = 0, count = 0, spread = 0;
  let mi = 0;
  for (let k = 1; k < fixes.length; k++) {
    const [t0, v0] = [fixes[k - 1][0], fixes[k - 1][6]], [t1, v1] = [fixes[k][0], fixes[k][6]];
    if (v0 < 0 || v1 < 0 || t1 - t0 < 0.3 || t1 - t0 > 3) continue;
    while (mi < motion.length && motion[mi][0] <= t0) mi++;
    let h = [0, 0, 0], n = 0, turn = 0;
    for (let j = mi; j < motion.length && motion[j][0] <= t1; j++) {
      const a = reject([motion[j][4], motion[j][5], motion[j][6]], up);
      h = [h[0] + a[0], h[1] + a[1], h[2] + a[2]]; n++;
      turn += dot([motion[j][7], motion[j][8], motion[j][9]], up);
    }
    if (!n) continue;
    h = scale(h, 1 / n);
    const along = (v1 - v0) / (t1 - t0) / G;
    if (Math.abs(along) < 0.05 || Math.max(v0, v1) < 2) continue;
    // Not while cornering: braking into bends would pull forward towards their side.
    if (Math.abs(turn / n) * (v0 + v1) / 2 / G > 0.05) continue;
    acc = [acc[0] + h[0] * along, acc[1] + h[1] * along, acc[2] + h[2] * along];
    weight += along * along; spread += dot(h, h); count++;
  }
  let forward, forwardFrom, confidence = 0;
  const learnt = reject(acc, up);
  if (count >= 12 && weight > 0.1 && Math.hypot(...learnt) > 1e-6) {
    forward = norm(learnt); forwardFrom = "drive";
    confidence = Math.hypot(...acc) / Math.sqrt(weight * spread);
  } else if (raw.end?.forward?.length === 3) {
    forward = norm(reject(raw.end.forward, up)); forwardFrom = "phone";
  } else {
    forward = reject(preset.forward, up);
    if (Math.hypot(...forward) < 0.2) forward = reject(Math.abs(up[2]) < 0.9 ? [0, 0, -1] : [0, 1, 0], up);
    forward = norm(forward); forwardFrom = "preset";
  }
  return { up, forward, left: cross(up, forward), upFrom, forwardFrom, confidence };
}

/**
 * How late the GPS reports each fix (s): an iPhone's GPS smooths its fixes and gives them out
 * about 2 s after the car was there (1.9 s in the X1). Found from how its speed changes against
 * the car's own wheel speed, and how its course turns against the gyro (about `up`), over each
 * fix's interval at lags of 0 to 3 s: the lag that fits best, or 0 if neither fits well.
 */
export function findGpsLag(raw, fixes, up) {
  // Running integrals, so a value's change over any interval is a subtraction.
  const integral = (pts) => {
    const ts = pts.map((p) => p[0]), sum = new Float64Array(pts.length);
    for (let k = 1; k < pts.length; k++) sum[k] = sum[k - 1] + (pts[k][1] + pts[k - 1][1]) / 2 * (ts[k] - ts[k - 1]);
    return (t) => {
      const k = before(ts, t);
      if (k < 0 || k >= pts.length - 1) return NaN;
      const s = (t - ts[k]) / (ts[k + 1] - ts[k]);
      return sum[k] + (pts[k][1] + (pts[k + 1][1] - pts[k][1]) * s / 2) * s * (ts[k + 1] - ts[k]);
    };
  };
  const tries = [];
  // The car's speed (m/s); its change over a fix's interval against the GPS's.
  const wheels = raw.car.filter(([, v]) => Number.isFinite(v.Speed)).map(([t, v]) => [t, v.Speed / 3.6]);
  if (wheels.length > 100) {
    const wt = wheels.map((w) => w[0]);
    const speed = (t) => {
      const k = before(wt, t);
      if (k < 0 || k >= wheels.length - 1 || wt[k + 1] - wt[k] > 2) return NaN;
      return wheels[k][1] + (wheels[k + 1][1] - wheels[k][1]) * (t - wt[k]) / (wt[k + 1] - wt[k]);
    };
    tries.push({ ok: (a, b) => a[6] >= 0 && b[6] >= 0 && Math.max(a[6], b[6]) > 1, gps: (a, b) => b[6] - a[6], other: (t0, t1) => speed(t1) - speed(t0) });
  }
  // The gyro's turn about up (° left +) against the course's (compass, clockwise +).
  if (raw.motion.length > 100) {
    const turned = integral(raw.motion.map((m) => [m[0], (up[0] * m[7] + up[1] * m[8] + up[2] * m[9]) / DEG]));
    tries.push({ ok: (a, b) => a[8] >= 0 && b[8] >= 0 && Math.min(a[6], b[6]) > 3, gps: (a, b) => -wrap180(b[8] - a[8]), other: (t0, t1) => turned(t1) - turned(t0) });
  }
  let best = { lag: 0, fit: 0 };
  for (const { ok, gps, other } of tries) {
    const pairs = [];
    for (let k = 1; k < fixes.length; k++) {
      const a = fixes[k - 1], b = fixes[k], dt = b[0] - a[0];
      if (dt >= 0.3 && dt <= 1.5 && ok(a, b)) pairs.push([a[0], b[0], gps(a, b)]);
    }
    if (pairs.length < 30) continue;
    for (let lag = 0; lag <= 3.001; lag += 0.05) {
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (const [t0, t1, x] of pairs) {
        const y = other(t0 - lag, t1 - lag);
        if (!Number.isFinite(y)) continue;
        n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      }
      if (n < 30) continue;
      const fit = (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
      if (fit > best.fit) best = { lag, fit };
    }
  }
  return best.fit > 0.8 ? Math.round(best.lag * 100) / 100 : 0;
}

// MARK: xDrive's torque

/**
 * What the estimate needs of a car: kerb weight with a driver (kg), rolling radius (m),
 * wheelbase (m), the share of its weight on the front axle, its centre of gravity's height (m)
 * and its drag area (m²). Makers' figures, rounded; `rear` and `front` (by xDrive's kind) stand
 * in for cars not listed.
 */
export const CAR_FIGURES = {
  F48: { mass: 1700, radius: 0.341, wheelbase: 2.67, front: 0.58, cg: 0.6, cda: 0.74 }, // X1 xDrive18d
  F15: { mass: 2200, radius: 0.37, wheelbase: 2.933, front: 0.5, cg: 0.66, cda: 0.98 }, // X5 xDrive40d
  rear: { mass: 1650, radius: 0.34, wheelbase: 2.67, front: 0.6, cg: 0.58, cda: 0.72 },
  front: { mass: 1900, radius: 0.35, wheelbase: 2.9, front: 0.5, cg: 0.6, cda: 0.8 },
};

/** The figures for the log's car: by its chassis code, else by its kind of xDrive. */
export function carFigures(car = {}, xdrive = car.xdrive) {
  const code = car.chassis || /\(([A-Z]\d{2})/.exec(car.model || "")?.[1];
  const known = CAR_FIGURES[code];
  return known ? { ...known, chassis: code } : { ...CAR_FIGURES[xdrive === "front" ? "front" : "rear"], chassis: null };
}

/**
 * The torque xDrive passes, worked out. The axle values (Rear axle, Front axle) are what the
 * clutch is set to carry: a slipping clutch passes just that, but a locked one only what that
 * axle's tyres take, its share of the torque the road takes from all four wheels. So it passes
 * the smaller of the two. The road's torque: the car's weight × (its acceleration from the wheels'
 * speed, and the hill from the height over distance), with rolling and air resistance, at the
 * rolling radius; no more than the engine's power could give at that wheel speed. The share: the
 * weight on the axle, which moves back speeding up and climbing. Both are at the wheels, as the
 * clutch's figure appears to be (its pull-aways only fit that).
 * Returns { wheels, xdrive } (Float32Arrays on the timeline, NaN where not known), or null.
 */
export function estimateXdrive(drive, figures) {
  const axle = drive.byName["Rear axle"] || drive.byName["Front axle"];
  const speed = drive.byName.Speed;
  if (!axle || !speed) return null;
  const toRear = axle.name === "Rear axle";
  const { mass, radius, wheelbase, front, cg, cda } = figures;
  const n = drive.n, R = drive.rate, sv = speed.values;
  const torque = drive.byName.Torque?.values, rpm = drive.byName.RPM?.values;
  const wheels = new Float32Array(n).fill(NaN), xdrive = new Float32Array(n).fill(NaN);
  const half = Math.round(R / 2), hill = Math.round(2.5 * R);
  for (let i = 0; i < n; i++) {
    const v = sv[i] / 3.6;
    const a0 = sv[Math.max(0, i - half)], a1 = sv[Math.min(n - 1, i + half)];
    if (!Number.isFinite(v) || !Number.isFinite(a0) || !Number.isFinite(a1)) continue;
    const accel = (a1 - a0) / 3.6 / ((Math.min(n - 1, i + half) - Math.max(0, i - half)) / R);
    const j0 = Math.max(0, i - hill), j1 = Math.min(n - 1, i + hill), run = drive.dist[j1] - drive.dist[j0];
    const grade = run > 5 ? clamp((drive.alt[j1] - drive.alt[j0]) / run, -0.35, 0.35) : 0;
    const moving = v > 0.3 || Math.abs(accel) > 0.05;
    let force = mass * (1.04 * accel + G * grade) + (moving ? 0.012 * mass * G + 0.6 * cda * v * v : 0);
    let total = force * radius;
    // No more than the engine's power through the gears at this wheel speed.
    if (torque && rpm && v > 2 && Number.isFinite(torque[i]) && Number.isFinite(rpm[i])) {
      total = Math.min(total, Math.max(0, torque[i]) * rpm[i] * 2 * Math.PI / 60 / (v / radius));
    }
    wheels[i] = total;
    const rearShare = clamp(1 - front + (accel / G + grade) * cg / wheelbase, 0.2, 0.8);
    const share = toRear ? rearShare : 1 - rearShare;
    const set = axle.values[i];
    if (Number.isFinite(set)) xdrive[i] = clamp(Math.min(set, share * total), 0, Math.max(0, set));
  }
  return { wheels, xdrive, axle: axle.name };
}

/** A channel the player adds (from the iPhone), drawn and charted like the car's. */
function derived(name, unit, digits, min, max, values) {
  return { name, unit, group: "iPhone", digits, min, max, values, derived: true };
}

/**
 * Everything the player needs, on one timeline of RATE samples a second:
 * t, x/y (m east/north of the start), lat, lon, alt, speed (m/s), heading (compass °),
 * pitch/roll (°), longG/latG (g, forward/left), yaw (°/s, left +), dist (m); and the car's channels.
 */
export function processLog(raw) {
  const { header } = raw;
  let fixes = raw.gps.filter((g) => g[4] >= 0 && g[4] <= 50 && Math.abs(g[1]) <= 90 && Math.abs(g[2]) <= 180)
    .sort((a, b) => a[0] - b[0]);
  // Each fix at when the car was there, so the map keeps time with the gyro and the car's values.
  const gpsLag = findGpsLag(raw, fixes, solveMount(raw, fixes).up);
  if (gpsLag) fixes = fixes.map((f) => [f[0] - gpsLag, ...f.slice(1)]);
  const lastT = Math.max(
    raw.motion.at(-1)?.[0] ?? 0, raw.gps.at(-1)?.[0] ?? 0, raw.car.at(-1)?.[0] ?? 0, raw.end?.t ?? 0);
  const n = Math.max(2, Math.floor(lastT * RATE) + 1);
  const T = new Float64Array(n);
  for (let i = 0; i < n; i++) T[i] = i / RATE;
  const duration = T[n - 1];

  const origin = fixes.length ? { lat: fixes[0][1], lon: fixes[0][2] } : { lat: 0, lon: 0 };
  const proj = projector(origin);

  // Position: Hermite curves between fixes, tangents from the GPS's speed and course.
  const X = new Float64Array(n), Y = new Float64Array(n), V = new Float64Array(n);
  const gpsHeading = new Float64Array(n).fill(NaN);
  if (fixes.length) {
    const fx = fixes.map((f) => {
      const [x, y] = proj.xy(f[1], f[2]);
      const speed = Math.max(0, f[6]);
      const course = f[8];
      const ok = course >= 0 && speed > 0.8;
      return { t: f[0], x, y, speed, course: ok ? course : NaN, vx: ok ? speed * Math.sin(course * DEG) : 0, vy: ok ? speed * Math.cos(course * DEG) : 0 };
    });
    // Without a course (an old phone, a parked car), velocity from the neighbouring fixes.
    for (let k = 0; k < fx.length; k++) {
      if (!Number.isNaN(fx[k].course) || fx[k].speed < 0.8) continue;
      const a = fx[Math.max(0, k - 1)], b = fx[Math.min(fx.length - 1, k + 1)];
      const dt = b.t - a.t;
      if (dt > 0) { fx[k].vx = (b.x - a.x) / dt; fx[k].vy = (b.y - a.y) / dt; }
    }
    const ft = fx.map((f) => f.t);
    for (let i = 0; i < n; i++) {
      const t = T[i];
      let k = before(ft, t);
      if (k < 0) { X[i] = fx[0].x; Y[i] = fx[0].y; V[i] = fx[0].speed; gpsHeading[i] = fx[0].course; continue; }
      if (k >= fx.length - 1) { const f = fx.at(-1); X[i] = f.x; Y[i] = f.y; V[i] = f.speed; gpsHeading[i] = f.course; continue; }
      const a = fx[k], b = fx[k + 1], h = b.t - a.t, s = (t - a.t) / h;
      if (h > 5) { // a gap in the GPS: straight across it
        X[i] = a.x + (b.x - a.x) * s; Y[i] = a.y + (b.y - a.y) * s; V[i] = a.speed + (b.speed - a.speed) * s; continue;
      }
      const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
      X[i] = h00 * a.x + h10 * h * a.vx + h01 * b.x + h11 * h * b.vx;
      Y[i] = h00 * a.y + h10 * h * a.vy + h01 * b.y + h11 * h * b.vy;
      V[i] = a.speed + (b.speed - a.speed) * s;
      if (!Number.isNaN(a.course) && !Number.isNaN(b.course)) gpsHeading[i] = (a.course + wrap180(b.course - a.course) * s + 360) % 360;
    }
  }

  // The iPhone's motion, on the timeline.
  const mount = solveMount(raw, fixes);
  const P = new Float64Array(n), R = new Float64Array(n), LG = new Float64Array(n), AG = new Float64Array(n), W = new Float64Array(n);
  const hasMotion = raw.motion.length > 10;
  if (hasMotion) {
    const mt = raw.motion.map((m) => m[0]);
    // Each motion sample in the car's terms, then averaged over each timeline step.
    const per = raw.motion.map((m) => {
      const g = [m[1], m[2], m[3]], a = [m[4], m[5], m[6]], r = [m[7], m[8], m[9]];
      const upWorld = norm(scale(g, -1));
      return [
        Math.asin(clamp(dot(mount.forward, upWorld), -1, 1)) / DEG,
        Math.asin(clamp(dot(mount.left, upWorld), -1, 1)) / DEG,
        dot(mount.forward, a), dot(mount.left, a), dot(mount.up, r) / DEG,
      ];
    });
    // Acceleration jitters with the road: averaged over 0.2 s.
    const half = 0.1;
    for (let i = 0; i < n; i++) {
      const t = T[i];
      let k0 = before(mt, t - half), k1 = before(mt, t + half);
      k0 = Math.max(0, k0 + 1); k1 = Math.max(k0, k1);
      if (k1 >= per.length) k1 = per.length - 1;
      const k = clamp(before(mt, t), 0, per.length - 1);
      P[i] = per[k][0]; R[i] = per[k][1]; W[i] = per[k][4];
      let lg = 0, ag = 0, c = 0;
      for (let j = k0; j <= k1; j++) { lg += per[j][2]; ag += per[j][3]; c++; }
      LG[i] = c ? lg / c : per[k][2]; AG[i] = c ? ag / c : per[k][3];
    }
  }

  // Heading: the gyro's turn, held to the GPS course while moving (compass: clockwise +).
  const H = new Float64Array(n);
  {
    let first = 0;
    for (let i = 0; i < n; i++) if (!Number.isNaN(gpsHeading[i])) { first = gpsHeading[i]; break; }
    // Forwards, then backwards, each pulled towards the course; averaged, so neither lags.
    const pull = (i) => (!Number.isNaN(gpsHeading[i]) && V[i] > 2 ? Math.min(0.08, 0.02 * V[i] / 2) : 0);
    const fwd = new Float64Array(n), back = new Float64Array(n);
    let h = first;
    for (let i = 0; i < n; i++) {
      if (i > 0) h += hasMotion ? -W[i] / RATE : 0;
      const k = pull(i);
      if (k) h += wrap180(gpsHeading[i] - h) * (hasMotion ? k : 1);
      fwd[i] = h;
    }
    h = fwd[n - 1];
    for (let i = n - 1; i >= 0; i--) {
      if (i < n - 1) h -= hasMotion ? -W[i + 1] / RATE : 0;
      const k = pull(i);
      if (k) h += wrap180(gpsHeading[i] - h) * (hasMotion ? k : 1);
      back[i] = h;
    }
    for (let i = 0; i < n; i++) H[i] = (fwd[i] + wrap180(back[i] - fwd[i]) / 2 + 720) % 360;
  }

  // Height: the barometer's changes on the GPS's average, else the GPS smoothed.
  const A = new Float64Array(n);
  {
    const good = fixes.filter((f) => f[5] >= 0);
    const gt = good.map((f) => f[0]);
    const gpsAlt = (t) => {
      const k = before(gt, t);
      if (k < 0) return good[0]?.[3] ?? 0;
      if (k >= good.length - 1) return good.at(-1)[3];
      const s = (t - gt[k]) / (gt[k + 1] - gt[k]);
      return good[k][3] + (good[k + 1][3] - good[k][3]) * s;
    };
    if (raw.baro.length > 2 && good.length) {
      const bt = raw.baro.map((b) => b[0]);
      const baroAt = (t) => {
        const k = clamp(before(bt, t), 0, raw.baro.length - 1);
        if (k >= raw.baro.length - 1) return raw.baro[k][1];
        const s = clamp((t - bt[k]) / (bt[k + 1] - bt[k]), 0, 1);
        return raw.baro[k][1] + (raw.baro[k + 1][1] - raw.baro[k][1]) * s;
      };
      const offset = median(good.map((f) => f[3] - baroAt(f[0])));
      for (let i = 0; i < n; i++) A[i] = baroAt(T[i]) + offset;
    } else {
      // GPS heights wander by metres from fix to fix: averaged over 6 s, centred.
      const w = 3 * RATE;
      const rawA = Float64Array.from(T, gpsAlt);
      for (let i = 0; i < n; i++) {
        let sum = 0, c = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j += 5) { sum += rawA[j]; c++; }
        A[i] = sum / c;
      }
    }
  }

  const LAT = new Float64Array(n), LON = new Float64Array(n), D = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [la, lo] = proj.ll(X[i], Y[i]);
    LAT[i] = la; LON[i] = lo;
    if (i) D[i] = D[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  }

  // The car's values on the timeline: joined between readings up to 2 s apart.
  const channels = raw.channels.map((c) => {
    const values = new Float32Array(n).fill(NaN);
    const pts = [];
    raw.car.forEach(([t, v]) => { if (v[c.name] !== undefined) pts.push([t, v[c.name]]); });
    const pt = pts.map((p) => p[0]);
    const step = !!c.states;
    for (let i = 0; i < n; i++) {
      const k = before(pt, T[i]);
      if (k < 0) continue;
      if (k >= pts.length - 1) { if (T[i] - pt[k] < 2) values[i] = pts[k][1]; continue; }
      const gap = pt[k + 1] - pt[k];
      if (gap > 2) { if (T[i] - pt[k] < 1) values[i] = pts[k][1]; continue; }
      values[i] = step ? pts[k][1] : pts[k][1] + (pts[k + 1][1] - pts[k][1]) * (T[i] - pt[k]) / gap;
    }
    return { ...c, values };
  });
  const phone = [
    derived("GPS speed", "km/h", 0, 0, 200, Float32Array.from(V, (v) => v * 3.6)),
    derived("Height", "m", 0, Math.floor(Math.min(...A.filter(Number.isFinite), 0) / 50) * 50, Math.ceil(Math.max(...A, 100) / 50) * 50, Float32Array.from(A)),
  ];
  if (hasMotion) {
    phone.push(
      derived("Pitch", "°", 1, -30, 30, Float32Array.from(P)),
      derived("Roll", "°", 1, -30, 30, Float32Array.from(R)),
      derived("Forward g", "g", 2, -1, 1, Float32Array.from(LG)),
      derived("Sideways g", "g", 2, -1, 1, Float32Array.from(AG)),
      derived("Turn rate", "°/s", 0, -40, 40, Float32Array.from(W)),
    );
  }

  let byName = Object.fromEntries([...channels, ...phone].map((c) => [c.name, c]));
  // xDrive's torque, worked out from the clutch's figure and the road's.
  const figures = carFigures(header.car || {});
  const est = estimateXdrive({ n, rate: RATE, byName, dist: D, alt: A }, figures);
  if (est) {
    const group = byName[est.axle].group;
    channels.push(
      { name: "All wheels (est.)", unit: "Nm", group, digits: 0, min: 0, max: 3000, values: est.wheels, derived: true },
      { name: "xDrive (est.)", unit: "Nm", group, digits: 0, min: 0, max: 1000, values: est.xdrive, derived: true },
    );
    byName = Object.fromEntries([...channels, ...phone].map((c) => [c.name, c]));
  }
  return {
    figures,
    header, raw, duration, n, rate: RATE, origin, proj, mount, gpsLag, hasMotion, hasGps: fixes.length > 1,
    t: T, x: X, y: Y, lat: LAT, lon: LON, alt: A, speed: V, heading: H, pitch: P, roll: R,
    longG: LG, latG: AG, yaw: W, dist: D,
    channels, phone, byName,
    marks: raw.marks, notes: raw.notes,
    started: header.started ? new Date(header.started) : null,
  };
}

/** The value of `arr` at time t, between samples. */
export function at(drive, arr, t) {
  const f = clamp(t * drive.rate, 0, drive.n - 1);
  const i = Math.floor(f), s = f - i;
  if (i >= drive.n - 1) return arr[drive.n - 1];
  const a = arr[i], b = arr[i + 1];
  if (Number.isNaN(a)) return s > 0.5 ? b : a;
  if (Number.isNaN(b)) return s > 0.5 ? b : a;
  return a + (b - a) * s;
}

/** The heading at t, between samples, the short way round. */
export function headingAt(drive, t) {
  const f = clamp(t * drive.rate, 0, drive.n - 1);
  const i = Math.floor(f), s = f - i;
  if (i >= drive.n - 1) return drive.heading[drive.n - 1];
  return (drive.heading[i] + wrap180(drive.heading[i + 1] - drive.heading[i]) * s + 360) % 360;
}

/** A channel's value at t (NaN for none). */
export function value(drive, name, t) {
  const c = drive.byName[name];
  return c ? at(drive, c.values, t) : NaN;
}

// MARK: laps

/**
 * Where laps start and finish: the place on the drive passed most often, going the same way.
 * Returns {x, y, heading} or null if the drive never comes back past a place.
 */
export function findStartLine(drive) {
  const stride = Math.max(1, Math.round(drive.rate / 5)); // search at 5 a second
  const idx = [];
  for (let i = 0; i < drive.n; i += stride) if (drive.speed[i] > 5) idx.push(i);
  if (idx.length < 20) return null;
  let best = null;
  const candStride = Math.max(1, Math.round(idx.length / 400));
  for (let c = 0; c < idx.length; c += candStride) {
    const i = idx[c];
    const cx = drive.x[i], cy = drive.y[i], ch = drive.heading[i];
    let passes = 0, lastT = -1e9;
    for (const j of idx) {
      if (Math.abs(drive.x[j] - cx) > 12 || Math.abs(drive.y[j] - cy) > 12) continue;
      if (Math.hypot(drive.x[j] - cx, drive.y[j] - cy) > 12 || Math.abs(wrap180(drive.heading[j] - ch)) > 45) continue;
      if (drive.t[j] - lastT > 20) passes++;
      lastT = drive.t[j];
    }
    if (passes >= 2 && (!best || passes > best.passes)) best = { passes, x: cx, y: cy, heading: ch, t: drive.t[i] };
  }
  return best;
}

/**
 * Laps through `line` ({x, y, heading}): each crossing going its way, 15 m either side.
 * Returns [{n, start, end, time, distance, maxSpeed, best}] for each lap between crossings.
 */
export function lapsFor(drive, line, halfWidth = 15) {
  if (!line) return [];
  const fx = Math.sin(line.heading * DEG), fy = Math.cos(line.heading * DEG); // the way through
  const crossings = [];
  for (let i = 1; i < drive.n; i++) {
    const a = (drive.x[i - 1] - line.x) * fx + (drive.y[i - 1] - line.y) * fy;
    const b = (drive.x[i] - line.x) * fx + (drive.y[i] - line.y) * fy;
    if (!(a < 0 && b >= 0)) continue;
    const s = a / (a - b);
    const px = drive.x[i - 1] + (drive.x[i] - drive.x[i - 1]) * s - line.x;
    const py = drive.y[i - 1] + (drive.y[i] - drive.y[i - 1]) * s - line.y;
    if (Math.abs(-px * fy + py * fx) > halfWidth) continue; // along the line, beyond its end
    const t = drive.t[i - 1] + s / drive.rate;
    if (crossings.length && t - crossings.at(-1) < 10) continue;
    crossings.push(t);
  }
  const laps = [];
  for (let k = 1; k < crossings.length; k++) {
    const start = crossings[k - 1], end = crossings[k];
    const i0 = Math.round(start * drive.rate), i1 = Math.min(drive.n - 1, Math.round(end * drive.rate));
    let maxSpeed = 0;
    for (let i = i0; i <= i1; i++) maxSpeed = Math.max(maxSpeed, drive.speed[i]);
    laps.push({ n: k, start, end, time: end - start, distance: drive.dist[i1] - drive.dist[i0], maxSpeed, best: false });
  }
  // Laps much longer than the rest (a stop in the pits) aren't timed laps.
  const typical = median(laps.map((l) => l.time));
  const timed = laps.filter((l) => l.time < typical * 1.5);
  const best = timed.reduce((b, l) => (!b || l.time < b.time ? l : b), null);
  if (best) best.best = true;
  return laps;
}

/** Seconds gained (−) or lost (+) against `ref` lap at time t in `lap`, by distance along each. */
export function delta(drive, lap, ref, t) {
  if (!lap || !ref || lap === ref) return NaN;
  const d = at(drive, drive.dist, t) - at(drive, drive.dist, lap.start);
  const target = at(drive, drive.dist, ref.start) + d;
  // When the reference lap had covered the same distance.
  let lo = Math.round(ref.start * drive.rate), hi = Math.min(drive.n - 1, Math.round(ref.end * drive.rate));
  if (target > drive.dist[hi]) return NaN;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (drive.dist[mid] < target) lo = mid; else hi = mid; }
  const span = drive.dist[hi] - drive.dist[lo];
  const refT = drive.t[lo] + (span > 0 ? (target - drive.dist[lo]) / span / drive.rate : 0);
  return (t - lap.start) - (refT - ref.start);
}

// MARK: exports

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

/**
 * KML for Google Earth: the path on the ground, and a time-stamped track with the car's heading,
 * pitch and roll and its values, which Earth plays back with its time slider (2 points a second).
 */
export function toKml(drive, { laps = [], name } = {}) {
  const title = name || drive.header.name || "Drive";
  const step = Math.max(1, Math.round(drive.rate / 2));
  const start = drive.started ? drive.started.getTime() : Date.UTC(2000, 0, 1);
  const idx = [];
  for (let i = 0; i < drive.n; i += step) idx.push(i);
  const fields = [
    ["speed", "Speed (km/h)", (i) => drive.speed[i] * 3.6, 1],
    ["height", "Height (m)", (i) => drive.alt[i], 1],
    ...(drive.hasMotion ? [["pitch", "Pitch (°)", (i) => drive.pitch[i], 1], ["roll", "Roll (°)", (i) => drive.roll[i], 1],
      ["forward_g", "Forward g", (i) => drive.longG[i], 2], ["sideways_g", "Sideways g", (i) => drive.latG[i], 2]] : []),
    ...drive.channels.map((c) => [c.name.replace(/\W+/g, "_").toLowerCase(), `${c.name}${c.unit ? ` (${c.unit})` : ""}`, (i) => c.values[i], (c.digits ?? 1) + 1]),
  ];
  const coords = idx.map((i) => `${drive.lon[i].toFixed(7)},${drive.lat[i].toFixed(7)},0`).join(" ");
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">',
    `<Document><name>${xml(title)}</name>`,
    '<Style id="path"><LineStyle><color>ff2a5cff</color><width>4</width></LineStyle></Style>',
    '<Style id="car"><IconStyle><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/cabs.png</href></Icon></IconStyle><LineStyle><color>00000000</color></LineStyle></Style>',
    '<Schema id="drive">',
    ...fields.map(([id, label]) => `<gx:SimpleArrayField name="${id}" type="float"><displayName>${xml(label)}</displayName></gx:SimpleArrayField>`),
    "</Schema>",
    `<Placemark><name>${xml(title)}: path</name><styleUrl>#path</styleUrl><LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${coords}</coordinates></LineString></Placemark>`,
    `<Placemark><name>${xml(title)}</name><styleUrl>#car</styleUrl><gx:Track><altitudeMode>clampToGround</altitudeMode>`);
  for (const i of idx) out.push(`<when>${new Date(start + drive.t[i] * 1000).toISOString()}</when>`);
  for (const i of idx) out.push(`<gx:coord>${drive.lon[i].toFixed(7)} ${drive.lat[i].toFixed(7)} 0</gx:coord>`);
  for (const i of idx) out.push(`<gx:angles>${drive.heading[i].toFixed(1)} ${drive.pitch[i].toFixed(1)} ${drive.roll[i].toFixed(1)}</gx:angles>`);
  out.push('<ExtendedData><SchemaData schemaUrl="#drive">');
  for (const [id, , f, d] of fields) {
    out.push(`<gx:SimpleArrayData name="${id}">`);
    for (const i of idx) { const v = f(i); out.push(`<gx:value>${Number.isFinite(v) ? v.toFixed(d) : ""}</gx:value>`); }
    out.push("</gx:SimpleArrayData>");
  }
  out.push("</SchemaData></ExtendedData></gx:Track></Placemark>");
  for (const lap of laps) {
    const i = Math.round(lap.start * drive.rate);
    out.push(`<Placemark><name>Lap ${lap.n}: ${formatTime(lap.time, true)}${lap.best ? " (best)" : ""}</name><TimeStamp><when>${new Date(start + lap.start * 1000).toISOString()}</when></TimeStamp><Point><coordinates>${drive.lon[i].toFixed(7)},${drive.lat[i].toFixed(7)},0</coordinates></Point></Placemark>`);
  }
  for (const m of drive.marks) {
    const i = Math.min(drive.n - 1, Math.round(m.t * drive.rate));
    out.push(`<Placemark><name>${xml(m.label)}</name><Point><coordinates>${drive.lon[i].toFixed(7)},${drive.lat[i].toFixed(7)},0</coordinates></Point></Placemark>`);
  }
  out.push("</Document></kml>");
  return out.join("\n");
}

/** CSV, 10 rows a second: time, position, attitude and every channel. */
export function toCsv(drive) {
  const step = Math.max(1, Math.round(drive.rate / 10));
  const cols = [
    ["time_s", (i) => drive.t[i].toFixed(2)],
    ["lat", (i) => drive.lat[i].toFixed(7)], ["lon", (i) => drive.lon[i].toFixed(7)],
    ["height_m", (i) => drive.alt[i].toFixed(1)], ["speed_kmh", (i) => (drive.speed[i] * 3.6).toFixed(1)],
    ["heading_deg", (i) => drive.heading[i].toFixed(1)], ["distance_m", (i) => drive.dist[i].toFixed(1)],
    ...(drive.hasMotion ? [["pitch_deg", (i) => drive.pitch[i].toFixed(2)], ["roll_deg", (i) => drive.roll[i].toFixed(2)],
      ["forward_g", (i) => drive.longG[i].toFixed(3)], ["sideways_g", (i) => drive.latG[i].toFixed(3)],
      ["turn_rate_dps", (i) => drive.yaw[i].toFixed(2)]] : []),
    ...drive.channels.map((c) => [`${c.name}${c.unit ? ` (${c.unit})` : ""}`, (i) => (Number.isFinite(c.values[i]) ? +c.values[i].toFixed((c.digits ?? 1) + 1) : "")]),
  ];
  const quote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [cols.map(([h]) => quote(h)).join(",")];
  for (let i = 0; i < drive.n; i += step) rows.push(cols.map(([, f]) => f(i)).join(","));
  return rows.join("\n");
}

/** "1:02:03", "2:03.4" with tenths, or "−0.42" for a delta. */
export function formatTime(seconds, tenths = false) {
  if (!Number.isFinite(seconds)) return "—";
  const sign = seconds < 0 ? "−" : "";
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  const secText = tenths ? sec.toFixed(tenths === 2 ? 2 : 1).padStart(tenths === 2 ? 5 : 4, "0") : String(Math.floor(sec)).padStart(2, "0");
  return sign + (h ? `${h}:${String(m).padStart(2, "0")}:` : `${m}:`) + secText;
}
