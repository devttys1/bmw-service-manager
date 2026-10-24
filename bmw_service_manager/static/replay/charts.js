// Drive Replay's 2D instruments, drawn on canvases: the timeline, the strip chart, the g-g
// circle and the inclinometer. Colours come from the page's CSS variables, light or dark.

import { at, formatTime } from "./drivelog.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Fit a canvas to its box at the screen's pixel density; returns its context and size in CSS pixels. */
function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w: r.width, h: r.height };
}

/** Pointer down and drag on `canvas` call `seek(fraction 0..1 across it)`. */
function draggable(canvas, seek) {
  let down = false;
  const go = (e) => {
    const r = canvas.getBoundingClientRect();
    seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), e);
  };
  canvas.addEventListener("pointerdown", (e) => { down = true; canvas.setPointerCapture(e.pointerId); go(e); });
  canvas.addEventListener("pointermove", (e) => { if (down) go(e); });
  canvas.addEventListener("pointerup", () => { down = false; });
  canvas.addEventListener("pointercancel", () => { down = false; });
}

/** The whole drive at a glance: speed as an area, laps shaded, marks flagged, the cursor. Click or drag to seek. */
export class Timeline {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.drive = null;
    this.laps = [];
    this.t = 0;
    draggable(canvas, (f) => this.drive && onSeek(f * this.drive.duration));
  }

  set(drive, laps) { this.drive = drive; this.laps = laps; this.cache = null; this.draw(this.t); }

  draw(t) {
    this.t = t;
    const d = this.drive;
    if (!d) return;
    const { g, w, h } = fitCanvas(this.canvas);
    const x = (time) => (time / d.duration) * w;
    if (!this.cache || this.cache.w !== w || this.cache.h !== h || this.cache.theme !== css("--text")) {
      // The background, drawn once: lap bands, the speed trace, marks.
      const off = document.createElement("canvas");
      off.width = this.canvas.width; off.height = this.canvas.height;
      const o = off.getContext("2d");
      const dpr = this.canvas.width / w;
      o.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.laps.forEach((lap, k) => {
        o.fillStyle = lap.best ? "rgba(48,209,88,0.18)" : k % 2 ? "rgba(127,127,127,0.10)" : "rgba(127,127,127,0.04)";
        o.fillRect(x(lap.start), 0, x(lap.end) - x(lap.start), h);
      });
      let max = 1;
      for (let i = 0; i < d.n; i++) max = Math.max(max, d.speed[i]);
      o.beginPath();
      o.moveTo(0, h);
      const step = Math.max(1, Math.floor(d.n / (w * 2)));
      for (let i = 0; i < d.n; i += step) o.lineTo(x(d.t[i]), h - 3 - (d.speed[i] / max) * (h - 8));
      o.lineTo(w, h);
      o.closePath();
      o.fillStyle = css("--accent") + "55";
      o.fill();
      o.strokeStyle = css("--accent");
      o.lineWidth = 1;
      o.stroke();
      o.fillStyle = css("--yellow");
      for (const m of d.marks) { o.fillRect(x(m.t) - 1, 0, 2, h); o.beginPath(); o.moveTo(x(m.t) + 1, 1); o.lineTo(x(m.t) + 8, 4); o.lineTo(x(m.t) + 1, 7); o.fill(); }
      o.fillStyle = css("--muted");
      o.font = "10px system-ui, sans-serif";
      this.laps.forEach((lap) => { if (x(lap.end) - x(lap.start) > 46) o.fillText(`Lap ${lap.n} ${formatTime(lap.time, true)}`, x(lap.start) + 4, 11); });
      this.cache = { canvas: off, w, h, theme: css("--text") };
    }
    g.clearRect(0, 0, w, h);
    g.drawImage(this.cache.canvas, 0, 0, w, h);
    g.fillStyle = css("--text");
    g.fillRect(x(t) - 1, 0, 2, h);
  }
}

/** Channels over time, one lane each, around the cursor (or the whole drive). Click or drag to seek. */
export class StripChart {
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.drive = null;
    this.names = [];
    this.window = 60;
    this.laps = [];
    draggable(canvas, (f, e) => {
      if (!this.drive) return;
      const [a, b] = this.span(this.t ?? 0);
      // Dragging within a moving window would chase itself: a click jumps, a drag nudges.
      onSeek(a + f * (b - a), e);
    });
  }

  set(drive, laps) { this.drive = drive; this.laps = laps; this.ranges = {}; }

  /** The time span shown: the whole drive, or `window` seconds with the cursor two thirds in. */
  span(t) {
    const d = this.drive;
    if (!this.window || this.window >= d.duration) return [0, d.duration];
    const a = Math.min(Math.max(0, t - this.window * 0.66), d.duration - this.window);
    return [a, a + this.window];
  }

  /** A channel's range for its lane: its data's, padded, within its gauge's. */
  range(c) {
    if (this.ranges[c.name]) return this.ranges[c.name];
    let lo = Infinity, hi = -Infinity;
    for (const v of c.values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!Number.isFinite(lo)) { lo = c.min ?? 0; hi = c.max ?? 1; }
    if (c.min < 0 && c.max > 0) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; } // centred on zero
    if (hi - lo < 1e-6) { hi = lo + 1; }
    const pad = (hi - lo) * 0.08;
    return (this.ranges[c.name] = [lo - pad, hi + pad]);
  }

  draw(t) {
    this.t = t;
    const d = this.drive;
    if (!d) return;
    const { g, w, h } = fitCanvas(this.canvas);
    g.clearRect(0, 0, w, h);
    const channels = this.names.map((n) => d.byName[n]).filter(Boolean);
    if (!channels.length) {
      g.fillStyle = css("--muted"); g.font = "13px system-ui, sans-serif";
      g.fillText("Choose values to chart above.", 12, 24);
      return;
    }
    const [a, b] = this.span(t);
    const x = (time) => ((time - a) / (b - a)) * w;
    const lane = h / channels.length;
    const i0 = Math.max(0, Math.floor(a * d.rate)), i1 = Math.min(d.n - 1, Math.ceil(b * d.rate));
    const step = Math.max(1, Math.floor((i1 - i0) / (w * 1.5)));
    const colors = [css("--accent"), css("--orange"), css("--green"), css("--purple"), css("--red"), css("--teal"), css("--yellow"), css("--indigo")];
    // Laps and marks across every lane.
    g.strokeStyle = css("--border"); g.setLineDash([3, 3]); g.lineWidth = 1;
    for (const lap of this.laps) for (const tt of [lap.start, lap.end]) if (tt > a && tt < b) { g.beginPath(); g.moveTo(x(tt), 0); g.lineTo(x(tt), h); g.stroke(); }
    g.setLineDash([]);
    channels.forEach((c, k) => {
      const top = k * lane, color = colors[k % colors.length];
      const [lo, hi] = this.range(c);
      const y = (v) => top + lane - 3 - ((v - lo) / (hi - lo)) * (lane - 6);
      if (k) { g.fillStyle = css("--border"); g.fillRect(0, top, w, 1); }
      if (lo < 0 && hi > 0) { g.fillStyle = css("--border"); g.fillRect(0, y(0), w, 1); }
      g.strokeStyle = color; g.lineWidth = 1.5; g.beginPath();
      let pen = false;
      for (let i = i0; i <= i1; i += step) {
        const v = c.values[i];
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (pen) g.lineTo(x(d.t[i]), y(v)); else { g.moveTo(x(d.t[i]), y(v)); pen = true; }
      }
      g.stroke();
      const v = at(d, c.values, t);
      g.font = "600 11px system-ui, sans-serif";
      const label = `${c.name}  ${Number.isFinite(v) ? (c.states ? c.states[Math.round(v)] ?? v : v.toFixed(c.digits ?? 0)) : "—"}${c.unit && !c.states ? ` ${c.unit}` : ""}`;
      const tw = g.measureText(label).width;
      g.fillStyle = css("--card") + "dd"; g.fillRect(4, top + 3, tw + 10, 16);
      g.fillStyle = color; g.fillText(label, 9, top + 15);
    });
    g.fillStyle = css("--text");
    g.fillRect(x(t) - 0.75, 0, 1.5, h);
  }
}

/** Forward and sideways g as a dot in a circle, with the last few seconds' trail. */
export function drawGG(canvas, drive, t) {
  const { g, w, h } = fitCanvas(canvas);
  g.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2 + 4, r = Math.min(w, h - 22) / 2 - 4;
  const full = 1.2;
  g.strokeStyle = css("--border"); g.lineWidth = 1;
  for (const ring of [0.5, 1.0]) { g.beginPath(); g.arc(cx, cy, (ring / full) * r, 0, Math.PI * 2); g.stroke(); }
  g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();
  g.fillStyle = css("--muted"); g.font = "10px system-ui, sans-serif";
  g.fillText("1 g", cx + (1 / full) * r * 0.72 + 2, cy - (1 / full) * r * 0.72);
  g.fillText("g-g", 6, 12);
  if (!drive?.hasMotion) { g.fillText("No motion data", cx - 36, cy); return; }
  // Left turns pull to the left, braking to the bottom.
  const px = (latG) => cx - (latG / full) * r, py = (longG) => cy - (longG / full) * r;
  const i1 = Math.min(drive.n - 1, Math.round(t * drive.rate)), i0 = Math.max(0, i1 - 3 * drive.rate);
  for (let i = i0; i < i1; i += 2) {
    g.fillStyle = `rgba(127,127,127,${0.1 + 0.5 * (i - i0) / (i1 - i0 + 1)})`;
    g.fillRect(px(drive.latG[i]) - 1.5, py(drive.longG[i]) - 1.5, 3, 3);
  }
  const lat = at(drive, drive.latG, t), lon = at(drive, drive.longG, t);
  g.fillStyle = css("--accent");
  g.beginPath(); g.arc(px(lat), py(lon), 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = css("--text"); g.font = "600 12px system-ui, sans-serif";
  g.fillText(`${Math.hypot(lat, lon).toFixed(2)} g`, w - 52, h - 6);
}

/** A car from the side (facing right) or from behind, as a path around (0, 0), about 60 wide. */
function carShape(g, side) {
  g.beginPath();
  if (side) {
    g.moveTo(-30, 8); g.lineTo(-31, -2); g.lineTo(-27, -12); g.lineTo(-13, -14); g.lineTo(-6, -23);
    g.lineTo(12, -23); g.lineTo(21, -12); g.lineTo(30, -9); g.lineTo(31, 4); g.lineTo(28, 8); g.closePath();
  } else {
    g.moveTo(-24, 8); g.lineTo(-25, -6); g.lineTo(-18, -12); g.lineTo(-14, -25); g.lineTo(14, -25);
    g.lineTo(18, -12); g.lineTo(25, -6); g.lineTo(24, 8); g.closePath();
  }
}

const tinted = new WeakMap();
/** A silhouette (car3d's `silhouettes`) in colour: the body, its windows lighter, the tyres darker. */
function carImage(view, body, card) {
  const key = `${body} ${card}`;
  if (tinted.get(view)?.key === key) return tinted.get(view).canvas;
  const { all, glass, rim, tyre } = view.masks;
  const out = document.createElement("canvas"), tmp = document.createElement("canvas");
  out.width = tmp.width = all.width; out.height = tmp.height = all.height;
  const g = out.getContext("2d"), t = tmp.getContext("2d");
  for (const [mask, colour, alpha] of [[all, body, 1], [glass, card, 0.6], [rim, card, 0.3], [tyre, "#000", 0.55]]) {
    t.globalCompositeOperation = "copy";
    t.drawImage(mask, 0, 0);
    t.globalCompositeOperation = "source-in";
    t.fillStyle = colour;
    t.fillRect(0, 0, tmp.width, tmp.height);
    g.globalAlpha = alpha;
    g.drawImage(tmp, 0, 0);
  }
  tinted.set(view, { key, canvas: out });
  return out;
}

/** Pitch and roll as two dials, a car in each tilted as the car was: the shapes of the car
 *  drawn (car3d's `silhouettes`), else a sketch of one. */
export function drawIncline(canvas, pitch, roll, shapes = null) {
  const { g, w, h } = fitCanvas(canvas);
  g.clearRect(0, 0, w, h);
  const dials = [["Pitch", pitch, true], ["Roll", roll, false]];
  const r = Math.min(w / 4, (h - 30) / 2) - 4;
  dials.forEach(([label, v, side], k) => {
    const cx = (w / 4) * (1 + 2 * k), cy = r + 6;
    g.strokeStyle = css("--border"); g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.stroke();
    // Ticks every 10°, the warning past 25°.
    for (let a = -40; a <= 40; a += 10) {
      const ang = (a * Math.PI) / 180;
      for (const s of [1, -1]) {
        const ex = cx + s * Math.cos(ang) * r, ey = cy + s * Math.sin(ang) * r;
        g.strokeStyle = Math.abs(a) > 25 ? css("--red") : css("--border");
        g.beginPath(); g.moveTo(ex, ey); g.lineTo(cx + s * Math.cos(ang) * (r - 5), cy + s * Math.sin(ang) * (r - 5)); g.stroke();
      }
    }
    const warn = Math.abs(v) > 25;
    g.save();
    g.translate(cx, cy);
    // Nose up turns the side view (facing right) anticlockwise; right side down turns the rear view clockwise.
    g.rotate(((side ? -v : v) * Math.PI) / 180);
    const view = shapes?.[side ? "side" : "rear"];
    if (view) {
      // The car's length or width across most of the dial, its middle on the dial's.
      const dw = r * (side ? 1.62 : 1.15), dh = dw * view.height / view.width;
      g.drawImage(carImage(view, warn ? css("--red") : css("--accent"), css("--card")), -dw / 2, -dh / 2, dw, dh);
    } else {
      g.scale(r / 40, r / 40);
      carShape(g, side);
      g.fillStyle = warn ? css("--red") : css("--accent");
      g.fill();
      g.fillStyle = css("--card");
      if (side) { for (const wx of [-18, 18]) { g.beginPath(); g.arc(wx, 8, 6, 0, Math.PI * 2); g.fill(); } }
      else { g.fillRect(-12, -22, 24, 8); }
    }
    g.restore();
    g.fillStyle = warn ? css("--red") : css("--text");
    g.font = "600 14px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText(`${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}°`, cx, cy + r + 18);
    g.fillStyle = css("--muted"); g.font = "10px system-ui, sans-serif";
    g.fillText(label, cx, cy + r + 30);
    g.textAlign = "start";
  });
}
