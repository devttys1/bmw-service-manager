// Needle gauges for the video overlay (#62): analogue dials for speed, RPM, boost and any one of
// the drive's values, in a few styles picked in the overlay's settings. The scales (round numbers
// for the dial) come first and are tested in tests/js/needles.test.mjs; the drawing is below.
//
// Every length here is in q, 1/13 of the dial's radius, so a style looks the same on a small
// boost dial and a big speedometer, and on a 720p clip and a 4K one.

/** The styles, the default (Minimal arc, the owner's pick) first. */
export const NEEDLE_STYLES = {
  minimal: "Minimal arc",
  classic: "Classic: white on black",
  sport: "Sport: red line",
  digital: "Digital centre",
  vintage: "Vintage: cream face",
};

const FIG = '"Archivo", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
const tidy = (x) => +x.toPrecision(12);

// MARK: scales

/**
 * Round numbers for a dial from lo to hi: {min, max, step, minor}. `step` is the labelled
 * interval (1, 2, 2.5 or 5 times a power of ten), with no more than `most` of them; `minor` is
 * the small ticks between.
 */
export function niceScale(lo, hi, { most = 8 } = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
  if (hi <= lo) hi = lo + (Math.abs(lo) || 1);
  const mag = 10 ** Math.floor(Math.log10((hi - lo) / most));
  let step = mag, each = 1;
  search: for (const m of [1, 10, 100]) {
    for (const s of [1, 2, 2.5, 5]) {
      step = tidy(s * m * mag); each = s;
      if (Math.ceil(tidy(hi / step)) - Math.floor(tidy(lo / step)) <= most) break search;
    }
  }
  const min = tidy(Math.floor(tidy(lo / step)) * step), max = tidy(Math.ceil(tidy(hi / step)) * step);
  return { min, max, step, minor: tidy(step / (each === 2 ? 4 : 5)), red: null };
}

/** A speedometer reaching past the drive's top speed (in the units shown), by 20s or 40s as a car's. */
export function speedScale(top, mph = false) {
  const want = Math.max(mph ? 80 : 120, (Number.isFinite(top) ? top : 0) * 1.05);
  const step = mph ? (want <= 80 ? 10 : want <= 160 ? 20 : 40) : (want <= 160 ? 20 : want <= 320 ? 40 : 50);
  return { min: 0, max: Math.ceil(want / step) * step, step, minor: step >= 40 ? 10 : step / 2, red: null };
}

/** The red line when the drive doesn't give the engine's own: a petrol engine's and a diesel's. */
export const REDLINE = { petrol: 8000, diesel: 5000 };

/**
 * The car's engine, from the log's header `car`: its `redline` (rpm) and `fuel` ("petrol",
 * "diesel") if the log says; else a diesel by its model (a BMW's "…18d", "320d", "M50d") or by a
 * diesel's channels (soot, DPF, regeneration), and petrol otherwise. {fuel, redline, said}.
 */
export function engineOf(car = {}, channels = []) {
  const said = Number.isFinite(car.redline) && car.redline > 0;
  let fuel = /^(petrol|diesel)$/.test(car.fuel) ? car.fuel : null;
  if (!fuel) fuel = /\d{2,3}d\b/.test(car.model || "") || channels.some((n) => /soot|dpf|regen/i.test(n)) ? "diesel" : "petrol";
  return { fuel, redline: said ? car.redline : REDLINE[fuel], said };
}

/**
 * A rev counter red from the engine's red line, reaching 1,000 past it (further if the drive
 * revved higher), labelled in thousands.
 */
export function rpmScale(redline, top = 0) {
  const max = Math.max(Math.ceil(redline / 1000) * 1000 + 1000, Math.ceil((Number.isFinite(top) ? top : 0) / 1000) * 1000);
  return { min: 0, max, step: 1000, minor: max <= 8000 ? 250 : 500, red: redline };
}

/** How far round the dial v is, 0 to 1 (a missing value rests at the start). */
export function needleFraction(scale, v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, (v - scale.min) / (scale.max - scale.min)));
}

/** The dial's figures: as many decimals as the step needs, and a real minus sign. */
export function tickLabel(v, step) {
  let dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  while (dec < 3 && Math.abs(step * 10 ** dec - Math.round(step * 10 ** dec)) > 1e-6) dec++;
  const s = Math.abs(v) < 1e-9 ? (0).toFixed(dec) : v.toFixed(dec);
  return s.replace("-", "−");
}

/** Every tick on a scale: [value, major]. */
export function ticksOf(scale) {
  const n = Math.round((scale.max - scale.min) / scale.minor), out = [];
  for (let i = 0; i <= n; i++) {
    const v = tidy(scale.min + i * scale.minor), k = v / scale.step;
    out.push([v, Math.abs(k - Math.round(k)) < 1e-6]);
  }
  return out;
}

// MARK: drawing helpers

function circle(g, x, y, r, fill) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); }

function arc(g, x, y, r, a0, a1, width, color, cap = "butt") {
  if (a1 <= a0) return;
  g.beginPath(); g.arc(x, y, r, a0, a1);
  g.lineWidth = width; g.strokeStyle = color; g.lineCap = cap; g.stroke(); g.lineCap = "butt";
}

function text(g, s, x, y, size, color, { font = FIG, weight = "700", align = "center", base = "middle" } = {}) {
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = base;
  g.fillText(s, x, y);
}

/** The ticks, outer ends on radius r: major [length, width, colour], minor the same; red ones from `red`. */
function ticks(g, c, o, ang, r, major, minor, red) {
  for (const [v, big] of ticksOf(o.scale)) {
    const [len, w, color] = big ? major : minor;
    if (!len) continue;
    const a = ang(v), cos = Math.cos(a), sin = Math.sin(a);
    g.strokeStyle = red && o.scale.red != null && v >= o.scale.red ? red : color;
    g.lineWidth = Math.max(1, w);
    g.beginPath(); g.moveTo(c + cos * r, c + sin * r); g.lineTo(c + cos * (r - len), c + sin * (r - len)); g.stroke();
  }
}

/** The figures at the major ticks, centred on radius r. */
function numerals(g, c, o, ang, r, size, color, { font = FIG, weight = "600", red = null, only = null } = {}) {
  const label = o.labelOf || ((v) => tickLabel(v, o.scale.step));
  for (const [v, big] of ticksOf(o.scale)) {
    if (!big || (only && !only(v))) continue;
    const a = ang(v);
    text(g, label(v), c + Math.cos(a) * r, c + Math.sin(a) * r, size, red && o.scale.red != null && v >= o.scale.red ? red : color, { font, weight });
  }
}

/** A tapered needle from `tail` behind the centre to `tip`: widths `base` and `end`. */
function needle(g, c, a, { tip, tail = 0, base, end, color, shadow = null, glow = null, from = 0 }) {
  g.save();
  g.translate(c, c); g.rotate(a);
  if (shadow) { g.shadowColor = shadow[0]; g.shadowBlur = shadow[1]; g.shadowOffsetX = shadow[2]; g.shadowOffsetY = shadow[2]; }
  if (glow) { g.shadowColor = glow[0]; g.shadowBlur = glow[1]; }
  g.beginPath();
  g.moveTo(from - tail, -base / 2); g.lineTo(tip, -end / 2); g.lineTo(tip, end / 2); g.lineTo(from - tail, base / 2);
  g.closePath(); g.fillStyle = color; g.fill();
  g.restore();
}

/** The angles a dial sweeps, clockwise from a0 to a1 (radians, 0 at three o'clock). */
const sweep = (a0, a1) => ({ a0: a0 * Math.PI, a1: a1 * Math.PI });

function angles(o, { a0, a1 }) {
  return (v) => a0 + (a1 - a0) * needleFraction(o.scale, v);
}

function chromeBezel(g, d, r, q) {
  const gr = g.createLinearGradient(0, 0, d, d);
  gr.addColorStop(0, "#f4f6f8"); gr.addColorStop(0.45, "#7b818c"); gr.addColorStop(0.7, "#4b505a"); gr.addColorStop(1, "#d9dde2");
  circle(g, r, r, r, gr);
  circle(g, r, r, r - 0.75 * q, "#111317");
}

/** A dark window with the value in it, centred at (x, y). */
function readoutWindow(g, x, y, q, s, { w = s.length > 3 ? 7.6 : 6.4, h = 3.4, fill = "#020304", color = "#f6f6f2", size = 2.6 } = {}) {
  g.beginPath(); g.roundRect(x - (w * q) / 2, y - (h * q) / 2, w * q, h * q, 0.7 * q);
  g.fillStyle = fill; g.fill();
  g.lineWidth = Math.max(1, 0.18 * q); g.strokeStyle = "rgba(255,255,255,0.22)"; g.stroke();
  text(g, s, x, y + 0.1 * q, size * q, color, { weight: "700" });
}

// MARK: the styles

const STYLES = {
  /** White figures on a black face in a chrome ring, an orange needle: a German car's dial. */
  classic(g, d, o) {
    const r = d / 2, c = r, q = r / 13, S = sweep(0.75, 2.25), ang = angles(o, S);
    chromeBezel(g, d, r, q);
    const rf = r - 0.9 * q, face = g.createRadialGradient(c, c - r * 0.35, 0, c, c, rf);
    face.addColorStop(0, "#272a31"); face.addColorStop(1, "#060709");
    circle(g, c, c, rf, face);
    const rt = rf - 0.75 * q;
    if (o.scale.red != null) arc(g, c, c, rt - 0.5 * q, ang(o.scale.red), S.a1, 1.0 * q, "#e5332a");
    ticks(g, c, o, ang, rt, [2.1 * q, 0.48 * q, "#f5f5f1"], [1.0 * q, 0.22 * q, "rgba(245,245,241,0.8)"]);
    numerals(g, c, o, ang, rt - 4.1 * q, 2.4 * q, "#f5f5f1");
    text(g, o.caption, c, c + (o.small ? 3.3 : 4.3) * q, 1.5 * q, "#a8afbb", { font: MONO, weight: "500" });
    if (o.kind !== "rpm") readoutWindow(g, c, c + 8.1 * q, q, o.readout);
    needle(g, c, ang(o.value), { tip: rt - 0.3 * q, tail: (o.small ? 1.8 : 2.6) * q, base: 1.0 * q, end: 0.3 * q, color: "#ff6a1f", shadow: ["rgba(0,0,0,0.7)", 1.2 * q, 0.3 * q] });
    const cap = g.createRadialGradient(c - 0.5 * q, c - 0.5 * q, 0, c, c, 1.6 * q);
    cap.addColorStop(0, "#7d838d"); cap.addColorStop(1, "#202329");
    circle(g, c, c, 1.6 * q, cap);
  },

  /** A dark face with a painted red line, bold slanted figures, a red needle that glows, and a shift light. */
  sport(g, d, o) {
    const r = d / 2, c = r, q = r / 13, S = sweep(0.75, 2.25), ang = angles(o, S);
    circle(g, c, c, r, "#050506");
    const face = g.createRadialGradient(c, c, r * 0.1, c, c, r);
    face.addColorStop(0, "#2a2d34"); face.addColorStop(0.75, "#121318"); face.addColorStop(1, "#08090b");
    circle(g, c, c, r - 0.5 * q, face);
    arc(g, c, c, r - 0.55 * q, 0, Math.PI * 2, 0.35 * q, "#ff2b2b");
    const rt = r - 1.3 * q;
    if (o.scale.red != null) {
      g.beginPath(); g.arc(c, c, rt, ang(o.scale.red), S.a1); g.arc(c, c, rt - 2.3 * q, S.a1, ang(o.scale.red), true); g.closePath();
      g.fillStyle = "rgba(232, 30, 36, 0.92)"; g.fill();
    }
    ticks(g, c, o, ang, rt, [2.3 * q, 0.55 * q, "#ffffff"], [1.1 * q, 0.25 * q, "rgba(255,255,255,0.7)"]);
    numerals(g, c, o, ang, rt - (o.small ? 4.4 : 4.1) * q, (o.small ? 2.4 : 2.7) * q, "#ffffff", { weight: "italic 800", red: "#ff4a43" });
    if (o.kind === "rpm" && o.scale.red != null) {
      // The shift light: amber nearing the red line, red on it.
      const v = o.value, warn = o.scale.red - o.scale.max * 0.06;
      const lit = Number.isFinite(v) && v >= warn ? (v >= o.scale.red ? "#ff2b2b" : "#ffb020") : null;
      g.save();
      if (lit) { g.shadowColor = lit; g.shadowBlur = 2.4 * q; }
      g.beginPath(); g.roundRect(c - 2.6 * q, c - 5.1 * q, 5.2 * q, 1.4 * q, 0.7 * q);
      g.fillStyle = lit || "#26282e"; g.fill();
      g.restore();
    }
    text(g, o.readout, c, c + 8.4 * q, (o.readout.length > 3 ? 2.7 : 3.1) * q, "#ffffff", { weight: "italic 800" });
    // What it is goes under the figure, where the needle never points (not across the hub, #62).
    text(g, o.kind === "rpm" ? "rpm" : o.caption, c, c + 10.6 * q, 1.25 * o.fs * q, "#ff4a43", { font: MONO, weight: "500" });
    needle(g, c, ang(o.value), { tip: rt - 0.2 * q, tail: 2.2 * q, base: 0.9 * q, end: 0.22 * q, color: "#ff2b2b", glow: ["rgba(255,43,43,0.8)", 1.6 * q] });
    circle(g, c, c, 1.6 * q, "#ff2b2b");
    circle(g, c, c, 1.25 * q, "#0b0b0d");
  },

  /** A thin arc on the overlay's own glass panel, the reading in colour, a slim needle and the figure below. */
  minimal(g, d, o) {
    const r = d / 2, c = r, q = r / 13, S = sweep(5 / 6, 13 / 6), ang = angles(o, S);
    circle(g, c, c, r, "rgba(8, 14, 32, 0.55)");
    g.lineWidth = Math.max(1, 0.14 * q); g.strokeStyle = "rgba(255,255,255,0.10)"; g.beginPath(); g.arc(c, c, r - 0.07 * q, 0, Math.PI * 2); g.stroke();
    const ra = r - 1.6 * q;
    arc(g, c, c, ra, S.a0, S.a1, 0.55 * q, "rgba(255,255,255,0.16)", "round");
    if (o.scale.red != null) arc(g, c, c, ra, ang(o.scale.red), S.a1, 0.55 * q, "rgba(255, 90, 79, 0.45)", "round");
    const red = o.scale.red != null && o.value >= o.scale.red;
    if (Number.isFinite(o.value)) arc(g, c, c, ra, S.a0, Math.max(S.a0 + 0.01, ang(o.value)), 0.55 * q, red ? "#ff5a4f" : "#6cb4ff", "round");
    for (const [v, big] of ticksOf(o.scale)) {
      if (!big) continue;
      const a = ang(v);
      circle(g, c + Math.cos(a) * (ra - 1.6 * q), c + Math.sin(a) * (ra - 1.6 * q), 0.3 * q, "rgba(255,255,255,0.55)");
    }
    const ends = (v) => Math.abs(v - o.scale.min) < 1e-9 || Math.abs(v - o.scale.max) < 1e-9;
    numerals(g, c, o, ang, ra - 3.6 * q, 1.7 * o.fs * q, "#a7b1c3", { font: MONO, weight: "500", only: ends });
    const a = ang(o.value);
    g.save();
    g.lineCap = "round"; g.lineWidth = 0.4 * q; g.strokeStyle = "#f2f5fa";
    g.beginPath(); g.moveTo(c + Math.cos(a) * 1.4 * q, c + Math.sin(a) * 1.4 * q); g.lineTo(c + Math.cos(a) * (ra + 0.2 * q), c + Math.sin(a) * (ra + 0.2 * q)); g.stroke();
    g.restore();
    circle(g, c, c, 0.75 * q, "#f2f5fa");
    text(g, o.readout, c, c + r * 0.5, (o.readout.length > 4 ? 3.4 : 4.2) * q, "#f2f5fa");
    text(g, (o.kind === "rpm" ? "rpm" : o.caption).toUpperCase(), c, c + r * 0.5 + 2.9 * q, 1.3 * o.fs * q, "#a7b1c3", { font: MONO, weight: "500" });
  },

  /** A ring of ticks with a lit band and a short bright pointer on it, a big figure in the middle. */
  digital(g, d, o) {
    const r = d / 2, c = r, q = r / 13, S = sweep(0.75, 2.25), ang = angles(o, S);
    const face = g.createRadialGradient(c, c, 0, c, c, r);
    face.addColorStop(0, "rgba(16, 26, 54, 0.78)"); face.addColorStop(1, "rgba(5, 9, 22, 0.86)");
    circle(g, c, c, r, face);
    g.lineWidth = Math.max(1, 0.16 * q); g.strokeStyle = "rgba(108,180,255,0.25)"; g.beginPath(); g.arc(c, c, r - 0.08 * q, 0, Math.PI * 2); g.stroke();
    const rb = r - 1.6 * q, red = o.scale.red;
    arc(g, c, c, rb, S.a0, S.a1, 1.5 * q, "rgba(255,255,255,0.08)");
    if (red != null) arc(g, c, c, rb, ang(red), S.a1, 1.5 * q, "rgba(255, 90, 79, 0.28)");
    if (Number.isFinite(o.value)) {
      const band = g.createConicGradient ? g.createConicGradient(S.a0, c, c) : null;
      if (band) { band.addColorStop(0, "rgba(29,99,224,0.55)"); band.addColorStop(0.75, "rgba(108,180,255,0.95)"); band.addColorStop(1, "rgba(108,180,255,0.95)"); }
      arc(g, c, c, rb, S.a0, ang(Math.min(o.value, red ?? Infinity)), 1.5 * q, band || "#6cb4ff");
      if (red != null && o.value > red) arc(g, c, c, rb, ang(red), ang(o.value), 1.5 * q, "#ff5a4f");
    }
    ticks(g, c, o, ang, r - 0.6 * q, [1.6 * q, 0.32 * q, "rgba(255,255,255,0.85)"], [0.8 * q, 0.16 * q, "rgba(255,255,255,0.4)"], "#ff8a80");
    numerals(g, c, o, ang, r - 4.6 * q, 1.9 * o.fs * q, "#a7b1c3", { font: MONO, weight: "500", red: "#ff8a80" });
    const a = ang(o.value), hot = red != null && o.value >= red;
    g.save();
    g.shadowColor = hot ? "rgba(255,90,79,0.9)" : "rgba(108,180,255,0.9)"; g.shadowBlur = 1.4 * q;
    g.lineCap = "round"; g.lineWidth = 0.6 * q; g.strokeStyle = "#ffffff";
    g.beginPath(); g.moveTo(c + Math.cos(a) * (r - 4.0 * q), c + Math.sin(a) * (r - 4.0 * q)); g.lineTo(c + Math.cos(a) * (r - 0.4 * q), c + Math.sin(a) * (r - 0.4 * q)); g.stroke();
    g.restore();
    const big = o.readout.length > 4 ? 4.6 : o.readout.length > 3 ? 5.4 : 6.6;
    text(g, o.readout, c, c + 0.3 * q, big * q, hot ? "#ff5a4f" : "#f2f5fa");
    text(g, (o.kind === "rpm" ? "rpm" : o.caption).toUpperCase(), c, c + 4.3 * q, 1.45 * o.fs * q, "#a7b1c3", { font: MONO, weight: "500" });
  },

  /** Black figures on a cream face, a black needle with a red tip, in chrome: an old sports car's. */
  vintage(g, d, o) {
    const r = d / 2, c = r, q = r / 13, S = sweep(0.75, 2.25), ang = angles(o, S);
    chromeBezel(g, d, r, q);
    const rf = r - 0.9 * q, face = g.createRadialGradient(c, c - r * 0.3, 0, c, c, rf);
    face.addColorStop(0, "#f6f0dd"); face.addColorStop(1, "#d8ccab");
    circle(g, c, c, rf, face);
    const rt = rf - 0.7 * q;
    if (o.scale.red != null) arc(g, c, c, rt - 0.45 * q, ang(o.scale.red), S.a1, 0.9 * q, "#b3261e");
    ticks(g, c, o, ang, rt, [2.0 * q, 0.5 * q, "#15130f"], [1.0 * q, 0.24 * q, "#2a261d"]);
    numerals(g, c, o, ang, rt - 4.0 * q, 2.5 * q, "#15130f", { weight: "700" });
    text(g, o.caption, c, c + (o.small ? 3.3 : 4.3) * q, 1.5 * q, "#4a4335", { font: MONO, weight: "500" });
    if (o.kind !== "rpm") readoutWindow(g, c, c + 8.1 * q, q, o.readout, { fill: "#15130f", color: "#f6f0dd" });
    const a = ang(o.value);
    needle(g, c, a, { tip: rt - 0.2 * q, tail: (o.small ? 1.8 : 3.2) * q, base: 0.8 * q, end: 0.35 * q, color: "#15130f", shadow: ["rgba(0,0,0,0.45)", 0.8 * q, 0.35 * q] });
    needle(g, c, a, { from: rt - 3.4 * q, tip: rt - 0.2 * q, base: 0.52 * q, end: 0.35 * q, color: "#c8261d" });
    const cap = g.createRadialGradient(c - 0.5 * q, c - 0.5 * q, 0, c, c, 1.8 * q);
    cap.addColorStop(0, "#f2f3f5"); cap.addColorStop(1, "#5b606a");
    circle(g, c, c, 1.8 * q, cap);
  },
};

/**
 * Draws a needle gauge d pixels across with its top-left at the origin. o: {style, kind ("speed",
 * "rpm", "boost", "value"), scale, value, readout (the figure as shown), unit, caption, labelOf,
 * small (a smaller dial: its words a little bigger for it, to stay readable)}.
 */
export function drawNeedleGauge(g, d, o) {
  const opts = { caption: o.unit || "", readout: "—", ...o, fs: o.small ? 1.2 : 1 };
  g.save();
  (STYLES[o.style] || STYLES.classic)(g, d, opts);
  g.restore();
}
