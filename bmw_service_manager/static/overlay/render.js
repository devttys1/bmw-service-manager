// The overlay: gauges drawn over a video frame, on a 2D canvas. The same code draws the preview
// over the playing video and every frame of the export, so what you see is what you get.
//
// Sizes are in units of 1% of the frame's shorter side (times the size setting), so an overlay
// looks the same on a 720p clip and a 4K one, and fits a phone's upright video. Each gauge sits where the layout puts it: its top-left
// corner as a fraction of the frame's width and height.

import { at, value, findStartLine, lapsFor, delta, formatTime } from "../replay/drivelog.js";

export const FONT = { figures: '"Archivo", system-ui, sans-serif', label: '"IBM Plex Mono", ui-monospace, monospace', ui: '"Inter", system-ui, sans-serif' };
const C = {
  panel: "rgba(8, 14, 32, 0.58)", edge: "rgba(255, 255, 255, 0.10)", text: "#f2f5fa", muted: "#a7b1c3", faint: "rgba(255,255,255,0.16)",
  sky: "#6cb4ff", boost: "#1d63e0", red: "#ff5a4f", green: "#34d399", amber: "#f5a524",
};

/** The gauges, their size in units (w × h), and what they need from the drive. */
export const WIDGETS = {
  dial: { label: "Speed and RPM", w: 30, h: 30 },
  boost: { label: "Boost", w: 15, h: 15, needs: "Boost" },
  pedal: { label: "Pedal", w: 6, h: 30, needs: "Pedal" },
  gg: { label: "G-forces", w: 22, h: 22 },
  map: { label: "Track map", w: 24, h: 24 },
  lap: { label: "Lap timer", w: 38, h: 13 },
  values: { label: "Values", w: 24, h: 0 },
  attitude: { label: "Pitch and roll", w: 26, h: 13 },
};

/**
 * Where each gauge goes at first, and whether it's shown. x, y: its top-left, fractions of the
 * frame. `aspect` is the frame's width / height: units are 1% of its shorter side.
 */
export function defaultLayout(aspect = 16 / 9) {
  const uy = Math.min(1, aspect) / 100, ux = Math.min(1, 1 / aspect) / 100; // a unit, as a fraction of the height, the width
  const mx = 4 * ux, my = 4 * uy; // the margin
  const left = (units) => mx + units * ux, right = (units) => 1 - mx - units * ux;
  const bottom = (units) => 1 - my - units * uy;
  return {
    scale: 1, units: "kmh",
    values: ["Torque", "Coolant"],
    widgets: {
      dial: { on: true, x: left(0), y: bottom(30) },
      pedal: { on: true, x: left(32), y: bottom(30) },
      boost: { on: true, x: left(40), y: bottom(15) },
      gg: { on: true, x: right(22), y: bottom(26) },
      map: { on: true, x: right(24), y: my },
      lap: { on: true, x: left(0), y: my },
      values: { on: false, x: right(24), y: my + 27 * uy },
      attitude: { on: false, x: left(40), y: bottom(32) },
    },
  };
}

/** Everything about the drive the overlay works out once: laps, the track's outline, gauge ranges. */
export function prepare(drive) {
  const line = findStartLine(drive);
  const laps = lapsFor(drive, line);
  const best = laps.find((l) => l.best) || null;
  const rpm = drive.byName.RPM;
  const rpmMax = rpm ? Math.max(4000, Math.ceil((rpm.max || 6000) / 1000) * 1000) : 0;
  const boost = drive.byName.Boost;
  // The track: every 2 s of the drive, in metres east and north.
  const path = [];
  for (let i = 0; i < drive.n; i += drive.rate * 2) path.push([drive.x[i], drive.y[i]]);
  return { laps, best, rpmMax, boost: boost ? { min: Math.min(boost.min ?? -0.5, -0.5), max: Math.max(boost.max ?? 2, 1) } : null, path };
}

/** The values at drive time t. */
export function sample(drive, prep, t) {
  const inside = t >= 0 && t <= drive.duration;
  const gps = at(drive, drive.speed, t) * 3.6;
  const car = value(drive, "Speed", t);
  const lap = prep.laps.find((l) => t >= l.start && t < l.end) || null;
  return {
    t, inside,
    speed: Number.isFinite(car) ? car : drive.hasGps ? gps : NaN,
    rpm: value(drive, "RPM", t),
    boost: value(drive, "Boost", t),
    pedal: value(drive, "Pedal", t),
    longG: drive.hasMotion ? at(drive, drive.longG, t) : value(drive, "Longitudinal", t),
    latG: drive.hasMotion ? at(drive, drive.latG, t) : value(drive, "Lateral", t),
    pitch: drive.hasMotion ? at(drive, drive.pitch, t) : NaN,
    roll: drive.hasMotion ? at(drive, drive.roll, t) : NaN,
    x: at(drive, drive.x, t), y: at(drive, drive.y, t),
    lap, delta: lap ? delta(drive, lap, prep.best, t) : NaN,
    lastLap: prep.laps.filter((l) => l.end <= t).at(-1) || null,
  };
}

// MARK: drawing helpers

function panel(g, x, y, w, h, r) {
  g.beginPath(); g.roundRect(x, y, w, h, r);
  g.fillStyle = C.panel; g.fill();
  g.lineWidth = Math.max(1, r * 0.08); g.strokeStyle = C.edge; g.stroke();
}

function text(g, s, x, y, size, { font = FONT.figures, weight = 700, color = C.text, align = "left", base = "alphabetic" } = {}) {
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
  g.fillText(s, x, y);
}

const label = (g, s, x, y, u, opts = {}) => text(g, s.toUpperCase(), x, y, 1.7 * u, { font: FONT.label, weight: 500, color: C.muted, ...opts });

const fmt = (v, digits = 0) => (Number.isFinite(v) ? v.toFixed(digits) : "—");

// MARK: the gauges

const DRAW = {
  dial(g, u, f, ctx) {
    const s = 30 * u, cx = s / 2, cy = s / 2, r = s / 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = C.panel; g.fill(); g.lineWidth = Math.max(1, u * 0.18); g.strokeStyle = C.edge; g.stroke();
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ring = r - 2.6 * u;
    const max = ctx.prep.rpmMax;
    if (max) {
      // The RPM arc: its track, ticks every 1,000, the top 15% in red, the reading in Sky.
      g.lineCap = "round"; g.lineWidth = 1.6 * u;
      g.strokeStyle = C.faint; g.beginPath(); g.arc(cx, cy, ring, a0, a1); g.stroke();
      const red = a0 + (a1 - a0) * 0.85;
      g.strokeStyle = "rgba(255, 90, 79, 0.45)"; g.beginPath(); g.arc(cx, cy, ring, red, a1); g.stroke();
      const rpm = f.rpm;
      if (Number.isFinite(rpm)) {
        const k = Math.min(1, Math.max(0, rpm / max));
        g.strokeStyle = k > 0.85 ? C.red : C.sky;
        g.beginPath(); g.arc(cx, cy, ring, a0, a0 + (a1 - a0) * Math.max(0.002, k)); g.stroke();
      }
      g.lineCap = "butt";
      for (let k = 0; k <= max; k += 1000) {
        const a = a0 + (a1 - a0) * (k / max), cos = Math.cos(a), sin = Math.sin(a);
        g.strokeStyle = "rgba(255,255,255,0.55)"; g.lineWidth = Math.max(1, 0.3 * u);
        g.beginPath(); g.moveTo(cx + cos * (ring - 1.6 * u), cy + sin * (ring - 1.6 * u)); g.lineTo(cx + cos * (ring - 2.6 * u), cy + sin * (ring - 2.6 * u)); g.stroke();
        text(g, String(k / 1000), cx + cos * (ring - 3.9 * u), cy + sin * (ring - 3.9 * u), 1.9 * u, { font: FONT.label, weight: 500, color: C.muted, align: "center", base: "middle" });
      }
      text(g, Number.isFinite(rpm) ? `${Math.round(rpm / 10) * 10} rpm` : "— rpm", cx, cy + r * 0.74, 2.1 * u, { font: FONT.label, weight: 500, color: C.muted, align: "center", base: "middle" });
    }
    const mph = ctx.layout.units === "mph";
    const v = mph ? f.speed / 1.609344 : f.speed;
    text(g, fmt(v), cx, cy + 3 * u, 8 * u, { align: "center" });
    label(g, mph ? "mph" : "km/h", cx, cy + 7 * u, u, { align: "center" });
  },

  boost(g, u, f, ctx) {
    const s = 15 * u, cx = s / 2, cy = s / 2, r = s / 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = C.panel; g.fill(); g.lineWidth = Math.max(1, u * 0.18); g.strokeStyle = C.edge; g.stroke();
    const { min, max } = ctx.prep.boost || { min: -0.5, max: 2 };
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25, ring = r - 1.8 * u;
    const ang = (v) => a0 + (a1 - a0) * Math.min(1, Math.max(0, (v - min) / (max - min)));
    g.lineCap = "round"; g.lineWidth = 1.1 * u;
    g.strokeStyle = C.faint; g.beginPath(); g.arc(cx, cy, ring, a0, a1); g.stroke();
    const b = f.boost;
    if (Number.isFinite(b)) {
      const z = ang(0), a = ang(b);
      g.strokeStyle = b >= 0 ? C.sky : C.muted;
      g.beginPath(); b >= 0 ? g.arc(cx, cy, ring, z, Math.max(a, z + 0.01)) : g.arc(cx, cy, ring, a, z); g.stroke();
    }
    g.lineCap = "butt";
    text(g, fmt(b, 2), cx, cy + 1.6 * u, 4.2 * u, { align: "center" });
    label(g, "boost bar", cx, cy + 4.6 * u, u * 0.85, { align: "center" });
  },

  pedal(g, u, f) {
    const w = 6 * u, h = 30 * u;
    panel(g, 0, 0, w, h, 1.6 * u);
    const pad = 1.2 * u, top = 1.4 * u, bottom = 4.4 * u, bh = h - top - bottom;
    g.fillStyle = C.faint; g.beginPath(); g.roundRect(pad, top, w - 2 * pad, bh, 0.8 * u); g.fill();
    const p = Math.min(100, Math.max(0, f.pedal));
    if (Number.isFinite(p)) {
      const fh = bh * p / 100;
      const grad = g.createLinearGradient(0, top + bh, 0, top);
      grad.addColorStop(0, C.boost); grad.addColorStop(1, C.sky);
      g.fillStyle = grad; g.beginPath(); g.roundRect(pad, top + bh - fh, w - 2 * pad, fh, 0.8 * u); g.fill();
    }
    text(g, Number.isFinite(f.pedal) ? `${Math.round(f.pedal)}` : "—", w / 2, h - 2.3 * u, 2.6 * u, { align: "center" });
    label(g, "%", w / 2, h - 0.6 * u, u * 0.8, { align: "center" });
  },

  gg(g, u, f, ctx) {
    const s = 22 * u, cx = s / 2, cy = s / 2, r = s / 2;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = C.panel; g.fill(); g.lineWidth = Math.max(1, u * 0.18); g.strokeStyle = C.edge; g.stroke();
    const full = 1.2, rr = r - 1.2 * u;
    g.strokeStyle = "rgba(255,255,255,0.18)"; g.lineWidth = Math.max(1, 0.2 * u);
    for (const ring of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, rr * ring / full, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx - rr, cy); g.lineTo(cx + rr, cy); g.moveTo(cx, cy - rr); g.lineTo(cx, cy + rr); g.stroke();
    // Left turns pull to the left, braking to the bottom (as on Drive Replay's g-g).
    const px = (lat) => cx - (Math.max(-full, Math.min(full, lat)) / full) * rr;
    const py = (lon) => cy - (Math.max(-full, Math.min(full, lon)) / full) * rr;
    const { drive } = ctx;
    if (f.inside && drive) {
      const lg = drive.hasMotion ? drive.longG : drive.byName.Longitudinal?.values;
      const ag = drive.hasMotion ? drive.latG : drive.byName.Lateral?.values;
      if (lg && ag) {
        const i1 = Math.min(drive.n - 1, Math.round(f.t * drive.rate)), i0 = Math.max(0, i1 - 2 * drive.rate);
        for (let i = i0; i < i1; i += 2) {
          if (!Number.isFinite(lg[i]) || !Number.isFinite(ag[i])) continue;
          g.fillStyle = `rgba(108, 180, 255, ${0.08 + 0.4 * (i - i0) / (i1 - i0 + 1)})`;
          g.beginPath(); g.arc(px(ag[i]), py(lg[i]), 0.45 * u, 0, Math.PI * 2); g.fill();
        }
      }
    }
    if (Number.isFinite(f.latG) && Number.isFinite(f.longG)) {
      g.fillStyle = C.sky; g.shadowColor = "rgba(108,180,255,0.7)"; g.shadowBlur = 1.2 * u;
      g.beginPath(); g.arc(px(f.latG), py(f.longG), 1.1 * u, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0;
      text(g, `${Math.hypot(f.latG, f.longG).toFixed(2)} g`, cx, s + 3 * u, 2.8 * u, { align: "center" });
    }
  },

  map(g, u, f, ctx) {
    const s = 24 * u;
    panel(g, 0, 0, s, s, 2 * u);
    const pts = ctx.prep.path;
    if (pts.length < 2) return;
    if (!ctx.prep.bounds) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      ctx.prep.bounds = { x0, x1, y0, y1 };
    }
    const b = ctx.prep.bounds, pad = 2.4 * u, span = Math.max(b.x1 - b.x0, b.y1 - b.y0, 50);
    const k = (s - 2 * pad) / span;
    const ox = pad + (s - 2 * pad - (b.x1 - b.x0) * k) / 2, oy = pad + (s - 2 * pad - (b.y1 - b.y0) * k) / 2;
    const X = (x) => ox + (x - b.x0) * k, Y = (y) => s - oy - (y - b.y0) * k; // north up
    g.lineJoin = "round"; g.lineCap = "round";
    g.strokeStyle = "rgba(255,255,255,0.55)"; g.lineWidth = 0.55 * u;
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.stroke();
    if (f.inside && Number.isFinite(f.x)) {
      g.fillStyle = C.sky; g.strokeStyle = "#0b1630"; g.lineWidth = 0.35 * u;
      g.beginPath(); g.arc(X(f.x), Y(f.y), 1.1 * u, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  },

  lap(g, u, f, ctx) {
    const w = 38 * u, h = 13 * u;
    panel(g, 0, 0, w, h, 2 * u);
    const laps = ctx.prep.laps, pad = 2 * u;
    if (!laps.length) {
      label(g, "Time", pad, 3.8 * u, u);
      text(g, formatTime(f.t, true), pad, 10 * u, 5.4 * u);
      return;
    }
    const lap = f.lap;
    label(g, lap ? `Lap ${lap.n} of ${laps.length}` : f.lastLap ? `Lap ${f.lastLap.n} done` : "Out lap", pad, 3.8 * u, u);
    const shown = lap ? f.t - lap.start : f.lastLap ? f.lastLap.time : NaN;
    text(g, Number.isFinite(shown) ? formatTime(shown, true) : "—", pad, 10 * u, 5.4 * u);
    if (lap && Number.isFinite(f.delta)) {
      const d = f.delta;
      text(g, `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}`, w - pad, 10 * u, 3.6 * u, { align: "right", color: d < 0 ? C.green : C.red });
      label(g, `vs lap ${ctx.prep.best.n}`, w - pad, 3.8 * u, u * 0.9, { align: "right" });
    } else if (ctx.prep.best) {
      label(g, "Best", w - pad, 3.8 * u, u * 0.9, { align: "right" });
      text(g, formatTime(ctx.prep.best.time, true), w - pad, 10 * u, 3.2 * u, { align: "right", color: C.muted });
    }
  },

  values(g, u, f, ctx) {
    const names = ctx.layout.values.filter((n) => ctx.drive?.byName[n]);
    const row = 5.2 * u, w = 24 * u, h = Math.max(1, names.length) * row + 1.6 * u;
    panel(g, 0, 0, w, h, 2 * u);
    names.forEach((name, i) => {
      const c = ctx.drive.byName[name];
      const y = 0.8 * u + i * row + row * 0.66;
      label(g, name, 1.8 * u, y, u * 0.9);
      const v = f.inside ? value(ctx.drive, name, f.t) : NaN;
      const shown = c.states && Number.isFinite(v) ? (c.states[Math.round(v)] ?? fmt(v)) : fmt(v, c.digits ?? 0);
      text(g, `${shown}${c.unit && !c.states ? ` ${c.unit}` : ""}`, w - 1.8 * u, y, 2.8 * u, { align: "right" });
    });
  },

  attitude(g, u, f) {
    const w = 26 * u, h = 13 * u;
    panel(g, 0, 0, w, h, 2 * u);
    const half = w / 2;
    const draw = (cx, angle, side, name) => {
      g.save(); g.translate(cx, h * 0.56); g.rotate(-(Number.isFinite(angle) ? angle : 0) * Math.PI / 180);
      const k = u * 0.12;
      g.beginPath();
      if (side) { g.moveTo(-30 * k, 8 * k); g.lineTo(-31 * k, -2 * k); g.lineTo(-27 * k, -12 * k); g.lineTo(-13 * k, -14 * k); g.lineTo(-6 * k, -23 * k); g.lineTo(12 * k, -23 * k); g.lineTo(21 * k, -12 * k); g.lineTo(30 * k, -9 * k); g.lineTo(31 * k, 4 * k); g.lineTo(28 * k, 8 * k); }
      else { g.moveTo(-24 * k, 8 * k); g.lineTo(-25 * k, -6 * k); g.lineTo(-18 * k, -12 * k); g.lineTo(-14 * k, -25 * k); g.lineTo(14 * k, -25 * k); g.lineTo(18 * k, -12 * k); g.lineTo(25 * k, -6 * k); g.lineTo(24 * k, 8 * k); }
      g.closePath(); g.fillStyle = Math.abs(angle) > 20 ? C.red : C.sky; g.fill();
      g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = Math.max(1, 0.2 * u);
      g.beginPath(); g.moveTo(-34 * k, 8 * k); g.lineTo(34 * k, 8 * k); g.stroke();
      g.restore();
      text(g, `${fmt(Math.abs(angle), 0)}°`, cx, h - 1.4 * u, 2.6 * u, { align: "center" });
      label(g, name, cx, 2.8 * u, u * 0.8, { align: "center" });
    };
    // Nose up turns the side view's front (right) up: anticlockwise, so the angle as is.
    draw(half / 2, f.pitch, true, "pitch");
    draw(half * 1.5, -f.roll, false, "roll");
  },
};

/** A gauge's size in pixels, for laying out and dragging. */
export function widgetSize(id, u, ctx) {
  const w = WIDGETS[id];
  if (id === "values") {
    const n = Math.max(1, ctx.layout.values.filter((v) => ctx.drive?.byName[v]).length);
    return [w.w * u, n * 5.2 * u + 1.6 * u];
  }
  return [w.w * u, w.h * u + (id === "gg" ? 4 * u : 0)];
}

/** Whether a drive has what a gauge shows. */
export function available(id, drive) {
  if (!drive) return true;
  if (id === "dial") return !!drive.byName.Speed || drive.hasGps;
  if (id === "boost") return !!drive.byName.Boost;
  if (id === "pedal") return !!drive.byName.Pedal;
  if (id === "gg") return drive.hasMotion || !!drive.byName.Lateral;
  if (id === "map") return drive.hasGps;
  if (id === "attitude") return drive.hasMotion;
  return true;
}

/**
 * Draws the overlay for drive time t on a W × H frame. ctx: {drive, prep, layout}.
 * Gauges the drive can't fill, and every gauge outside the drive's time, aren't drawn.
 * Returns each gauge's box [x, y, w, h] in pixels (for dragging in the preview).
 */
export function drawOverlay(g, W, H, t, ctx) {
  const u = (Math.min(W, H) / 100) * ctx.layout.scale;
  const boxes = {};
  if (!ctx.drive) return boxes;
  const f = sample(ctx.drive, ctx.prep, t);
  for (const id of Object.keys(WIDGETS)) {
    const pos = ctx.layout.widgets[id];
    if (!pos?.on || !available(id, ctx.drive)) continue;
    if (id === "values" && !ctx.layout.values.some((v) => ctx.drive.byName[v])) continue;
    const [w, h] = widgetSize(id, u, ctx);
    const x = Math.round(Math.min(Math.max(0, pos.x * W), W - w)), y = Math.round(Math.min(Math.max(0, pos.y * H), H - h));
    boxes[id] = [x, y, w, h];
    if (!f.inside) continue;
    g.save(); g.translate(x, y);
    DRAW[id](g, u, f, ctx);
    g.restore();
  }
  return boxes;
}
