// Video Overlay: a drive log's gauges over a video of the same drive, lined up and exported as a
// new MP4, all in the browser. See docs/drive-logging.md ("Video overlay").

import { readLog, parseLog, processLog, formatTime } from "../replay/drivelog.js";
import { readMp4 } from "./mp4.js";
import { readTelemetry } from "./gpmf.js";
import { autoSync } from "./sync.js";
import { WIDGETS, NEEDLE_STYLES, defaultLayout, prepare, drawOverlay, available, needleChoices, needleValue } from "./render.js";
import { canExport, decoderConfig, exportVideo, frameRate, outputSize } from "./export.js";

const $ = (s) => document.querySelector(s);
const LAYOUT_KEY = "boostbook.overlay.layout";

const state = {
  video: null, // {file, mp4, tel, fps, duration, decodable, url}
  drive: null, prep: null, driveName: "",
  offset: 0, sync: null,
  layout: null,
  range: [0, 0],
  boxes: {},
  exporting: null,
};
window.overlay = { state };
let gaugeDrag = null; // the gauge being dragged on the preview: {id, dx, dy}

// MARK: layout, kept in the browser

// Upright videos keep a layout of their own.
const layoutKey = (aspect) => (aspect < 1 ? `${LAYOUT_KEY}.upright` : LAYOUT_KEY);

function loadLayout(aspect) {
  const fresh = defaultLayout(aspect);
  try {
    const saved = JSON.parse(localStorage.getItem(layoutKey(aspect)) || "null");
    if (saved?.widgets) {
      for (const id of Object.keys(fresh.widgets)) if (saved.widgets[id]) fresh.widgets[id] = { ...fresh.widgets[id], ...saved.widgets[id] };
      if (saved.scale) fresh.scale = saved.scale;
      if (saved.units) fresh.units = saved.units;
      if (Array.isArray(saved.values)) fresh.values = saved.values;
      if (NEEDLE_STYLES[saved.needleStyle]) fresh.needleStyle = saved.needleStyle;
      if (typeof saved.needleValue === "string") fresh.needleValue = saved.needleValue;
    }
  } catch { /* none kept */ }
  return fresh;
}
function saveLayout() {
  try { localStorage.setItem(layoutKey(state.aspect), JSON.stringify(state.layout)); } catch { /* private window */ }
}

// MARK: opening files

const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|lrv)$/i.test(f.name);
const isDrive = (f) => /\.(bblog|gz|blr)$/i.test(f.name);

function showError(message) {
  const el = $("#load-error");
  el.textContent = message; el.hidden = !message;
}

async function openVideo(file) {
  showError("");
  $("#slot-video-name").textContent = `Reading ${file.name}…`;
  try {
    const mp4 = await readMp4(file);
    const track = mp4.tracks.find((t) => t.handler === "vide");
    if (!track) throw new Error("This file has no video in it.");
    const tel = await readTelemetry(mp4);
    const dec = canExport() ? await decoderConfig(track) : { error: "This browser can't export video (no WebCodecs). Try Chrome, Edge or Safari 17 or later." };
    if (state.video?.url) URL.revokeObjectURL(state.video.url);
    state.video = { file, mp4, track, tel, fps: frameRate(track), duration: mp4.duration || track.duration, exportError: dec.error || null, url: URL.createObjectURL(file) };
    state.range = [0, state.video.duration];
    $("#slot-video").classList.add("done");
    $("#slot-video-name").textContent = file.name;
    await begin();
  } catch (e) {
    $("#slot-video-name").textContent = "MP4 or MOV: GoPro, iPhone, Android";
    showError(e.message || String(e));
    if (!$("#editor").hidden) $("#export-note").textContent = e.message || String(e);
  }
}

async function openDrive(source, name) {
  showError("");
  try {
    const drive = processLog(parseLog(await readLog(source, name)));
    state.drive = drive;
    state.prep = prepare(drive);
    state.driveName = drive.header.name || name || "Drive";
    $("#slot-drive").classList.add("done");
    $("#slot-drive-name").textContent = state.driveName;
    await begin();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function openFiles(files) {
  for (const f of files) {
    if (isDrive(f)) await openDrive(f, f.name);
    else if (isVideo(f)) await openVideo(f);
    else showError(`${f.name} isn't a video (MP4, MOV) or a drive log (.bblog.gz, .BLR).`);
  }
}

for (const id of ["#open-video", "#open-video2"]) $(id).addEventListener("change", (e) => { if (e.target.files[0]) openVideo(e.target.files[0]); e.target.value = ""; });
for (const id of ["#open-drive", "#open-drive2"]) $(id).addEventListener("change", (e) => { if (e.target.files[0]) openDrive(e.target.files[0], e.target.files[0].name); e.target.value = ""; });
$("#sample-drive").addEventListener("click", async () => {
  const res = await fetch("/static/sample-drive.bblog.gz");
  await openDrive(res, "Sample drive");
});
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
document.addEventListener("drop", (e) => {
  e.preventDefault(); document.body.classList.remove("dragging");
  if (e.dataTransfer?.files?.length) openFiles([...e.dataTransfer.files]);
});

// MARK: starting the editor

const video = $("#video");

async function begin() {
  if (!state.video || !state.drive) return;
  // The canvas draws with the page's fonts: have them before the first frame.
  await Promise.all(['700 20px "Archivo"', '500 20px "IBM Plex Mono"', '500 20px "Inter"'].map((f) => document.fonts.load(f).catch(() => null)));
  const v = state.video;
  if (video.src !== v.url) {
    video.src = v.url;
    await new Promise((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.addEventListener("error", resolve, { once: true });
    });
  }
  const [ow, oh] = outputSize(v.track, 0);
  state.aspect = ow / oh;
  state.layout = loadLayout(state.aspect);
  runSync();
  $("#empty").hidden = true;
  $("#editor").hidden = false;
  $("#title-sub").textContent = `${v.file.name} with ${state.driveName}`;
  describeFiles();
  buildGaugeControls();
  updateRangeInputs();
  $("#export-note").textContent = v.exportError || "";
  $("#export").disabled = !!v.exportError;
  fitFrame();
  draw();
}

function describeFiles() {
  const v = state.video, d = state.drive;
  const tr = v.track;
  const [w, h] = outputSize(tr, 0);
  const tel = v.tel.found ? (v.tel.gps.length ? `GoPro telemetry: GPS, ${v.tel.accel.length ? "accelerometer" : "no accelerometer"}` : `GoPro telemetry: ${v.tel.accel.length ? "accelerometer, no GPS fix" : "no GPS fix"}`) : "No telemetry";
  $("#video-info").innerHTML = "";
  $("#video-info").append(v.file.name, Object.assign(document.createElement("small"), {
    textContent: `${w} × ${h}, ${v.fps.toFixed(v.fps % 1 ? 2 : 0)} fps, ${formatTime(v.duration)} · ${tr.format.toUpperCase()} · ${tel}`,
  }));
  $("#drive-info").innerHTML = "";
  const car = d.header.car?.model || d.header.car?.name || "";
  $("#drive-info").append(state.driveName, Object.assign(document.createElement("small"), {
    textContent: `${formatTime(d.duration)}${d.started ? ` from ${d.started.toLocaleString()}` : ""}${car ? ` · ${car}` : ""}${state.prep.laps.length ? ` · ${state.prep.laps.length} laps` : ""}`,
  }));
}

// MARK: sync

function runSync() {
  const r = autoSync(state.drive, state.video.mp4, state.video.tel);
  state.sync = r;
  setOffset(r.offset);
  const el = $("#sync-status");
  el.textContent = r.detail;
  el.className = `sync-status ${r.good ? "good" : r.method === "none" ? "" : "check"}`;
  $("#sync-legend").hidden = !r.speed.video;
}

function setOffset(o) {
  state.offset = Math.round(o * 1000) / 1000;
  const out = $("#offset");
  out.textContent = formatTime(state.offset, 2);
  out.title = `The video starts ${formatTime(state.offset, 2)} into the drive`;
  draw();
  drawSyncChart();
}
window.overlay.setOffset = setOffset;

$("#auto-sync").addEventListener("click", () => runSync());
for (const b of document.querySelectorAll("[data-nudge]")) {
  b.addEventListener("click", () => {
    const k = b.dataset.nudge;
    const step = k === "frame" ? 1 / state.video.fps : k === "-frame" ? -1 / state.video.fps : parseFloat(k);
    setOffset(state.offset + step);
  });
}

/** "2:31.4", "-0:05", "151.4" → seconds; NaN if it isn't a time. */
function parseTime(s) {
  s = String(s).trim().replace("−", "-");
  if (!s) return NaN;
  const neg = s.startsWith("-");
  const parts = s.replace(/^-/, "").split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return NaN;
  const v = parts.reduce((a, p) => a * 60 + p, 0);
  return neg ? -v : v;
}

$("#mark-apply").addEventListener("click", () => {
  const t = parseTime($("#mark-time").value);
  if (!Number.isFinite(t)) { $("#mark-help").textContent = "Give the drive time as minutes:seconds, like 2:31.4."; return; }
  setOffset(t - video.currentTime);
  $("#mark-help").textContent = `Lined up: ${formatTime(video.currentTime, 2)} in the video is ${formatTime(t, 2)} in the drive.`;
  $("#sync-status").textContent = "Lined up by hand.";
  $("#sync-status").className = "sync-status";
});

// The sync chart: the whole drive's speed in a strip at the top with the video's span on it, and
// below, the video's span close up with the drive's speed and (from a GoPro) the camera's own.
const syncChart = $("#sync-chart");
function canvasFor(el) {
  const dpr = window.devicePixelRatio || 1;
  const w = el.clientWidth, h = el.clientHeight;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
  const g = el.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

const STRIP = 24;
function syncGeometry(w) {
  const d = state.drive, v = state.video;
  const lo = Math.min(0, state.offset), hi = Math.max(d.duration, state.offset + v.duration);
  const pad = 6;
  // The close-up: the video's span with a quarter of it either side.
  const margin = Math.max(5, v.duration * 0.25);
  return {
    pad, lo, hi,
    X: (t) => pad + (t - lo) / (hi - lo) * (w - 2 * pad),
    perPx: (hi - lo) / (w - 2 * pad),
    zlo: state.offset - margin, zhi: state.offset + v.duration + margin,
    ZX: (t) => pad + (t - (state.offset - margin)) / (v.duration + 2 * margin) * (w - 2 * pad),
    zPerPx: (v.duration + 2 * margin) / (w - 2 * pad),
  };
}

function drawSyncChart() {
  if (!state.drive || !state.video || $("#editor").hidden) return;
  const { g, w, h } = canvasFor(syncChart);
  g.clearRect(0, 0, w, h);
  const s = state.sync.speed, geo = syncGeometry(w);
  const ds = s.drive, step = s.step;
  const vmax = Math.max(10, ...ds.filter(Number.isFinite)) * 1.05;
  // Strip: the whole drive.
  const line = (from, to, X, top, height, color, series, shift = 0, width = 1.3) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    let pen = false;
    const i0 = Math.max(0, Math.floor((from - shift) / step)), i1 = Math.min(series.length - 1, Math.ceil((to - shift) / step));
    const every = Math.max(1, Math.floor((i1 - i0) / (w * 2)));
    for (let i = i0; i <= i1; i += every) {
      const val = series[i];
      if (!Number.isFinite(val)) { pen = false; continue; }
      const x = X(i * step + shift), y = top + height - (val / vmax) * height;
      if (pen) g.lineTo(x, y); else { g.moveTo(x, y); pen = true; }
    }
    g.stroke();
  };
  g.fillStyle = "rgba(108,180,255,0.05)"; g.fillRect(geo.pad, 2, w - 2 * geo.pad, STRIP - 4);
  line(geo.lo, geo.hi, geo.X, 3, STRIP - 6, "rgba(108,180,255,0.7)", ds, 0, 1);
  const sx0 = geo.X(state.offset), sx1 = geo.X(state.offset + state.video.duration);
  g.fillStyle = "rgba(255,209,102,0.22)"; g.strokeStyle = "rgba(255,209,102,0.9)"; g.lineWidth = 1;
  g.beginPath(); g.roundRect(sx0, 1.5, Math.max(3, sx1 - sx0), STRIP - 3, 3); g.fill(); g.stroke();
  // Close-up.
  const top = STRIP + 6, hh = h - top - 14;
  const zx0 = geo.ZX(state.offset), zx1 = geo.ZX(state.offset + state.video.duration);
  g.fillStyle = "rgba(255,209,102,0.07)"; g.fillRect(zx0, top, zx1 - zx0, hh);
  g.strokeStyle = "rgba(255,209,102,0.5)"; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(zx0, top); g.lineTo(zx0, top + hh); g.moveTo(zx1, top); g.lineTo(zx1, top + hh); g.stroke(); g.setLineDash([]);
  line(geo.zlo, geo.zhi, geo.ZX, top, hh, "#6cb4ff", ds, 0, 1.6);
  if (s.video) line(geo.zlo - state.offset, geo.zhi - state.offset, (t) => geo.ZX(t), top, hh, "rgba(255,255,255,0.9)", s.video, state.offset, 1.3);
  // The playhead.
  const ph = geo.ZX(state.offset + video.currentTime);
  g.strokeStyle = "#ffd166"; g.lineWidth = 1.5; g.beginPath(); g.moveTo(ph, top); g.lineTo(ph, top + hh); g.stroke();
  g.fillStyle = "#98a3b6"; g.font = '500 10px "IBM Plex Mono", monospace'; g.textBaseline = "alphabetic";
  g.textAlign = "left"; g.fillText(formatTime(Math.max(0, geo.zlo)), geo.pad, h - 3);
  g.textAlign = "right"; g.fillText(formatTime(geo.zhi), w - geo.pad, h - 3);
  g.textAlign = "center"; g.fillText(`${Math.round(vmax * 3.6)} km/h top`, w / 2, h - 3);
}

{
  let drag = null;
  syncChart.addEventListener("pointerdown", (e) => {
    if (!state.drive) return;
    const r = syncChart.getBoundingClientRect(), geo = syncGeometry(r.width);
    drag = { x: e.clientX, offset: state.offset, perPx: e.clientY - r.top < STRIP ? geo.perPx : -geo.zPerPx };
    syncChart.setPointerCapture(e.pointerId); syncChart.classList.add("dragging");
  });
  syncChart.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // In the strip, drag the span along the drive; in the close-up, drag the drive past the video.
    setOffset(drag.offset + (e.clientX - drag.x) * drag.perPx);
    $("#sync-status").textContent = "Lined up by hand.";
    $("#sync-status").className = "sync-status";
  });
  const end = () => { drag = null; syncChart.classList.remove("dragging"); };
  syncChart.addEventListener("pointerup", end);
  syncChart.addEventListener("pointercancel", end);
}

// MARK: the preview

const overlayCanvas = $("#overlay");
const frame = $("#frame");

function fitFrame() {
  if (!state.video) return;
  const stage = $(".ov-stage");
  const pad = window.innerWidth <= 900 ? 0 : 32;
  const sw = stage.clientWidth - pad, sh = window.innerWidth <= 900 ? Infinity : stage.clientHeight - pad;
  const a = state.aspect || 16 / 9;
  let w = sw, h = w / a;
  if (h > sh) { h = sh; w = h * a; }
  frame.style.width = `${Math.floor(w)}px`;
  frame.style.height = `${Math.floor(h)}px`;
  const dpr = window.devicePixelRatio || 1;
  overlayCanvas.width = Math.round(w * dpr); overlayCanvas.height = Math.round(h * dpr);
  draw();
}
new ResizeObserver(() => { fitFrame(); drawSyncChart(); drawScrub(); }).observe(document.body);

function draw() {
  if (!state.drive || !state.video || !state.layout) return;
  const g = overlayCanvas.getContext("2d");
  const W = overlayCanvas.width, H = overlayCanvas.height;
  g.clearRect(0, 0, W, H);
  const t = video.currentTime + state.offset;
  state.boxes = drawOverlay(g, W, H, t, { drive: state.drive, prep: state.prep, layout: state.layout });
  if (gaugeDrag) {
    const b = state.boxes[gaugeDrag.id];
    if (b) { g.strokeStyle = "rgba(255,209,102,0.9)"; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(b[0] - 3, b[1] - 3, b[2] + 6, b[3] + 6); g.setLineDash([]); }
  }
  const inside = t >= 0 && t <= state.drive.duration;
  $("#frame-hint").hidden = inside;
  $("#clock").textContent = formatTime(video.currentTime, true);
  $("#clock-of").textContent = `/ ${formatTime(state.video.duration)}`;
  $("#drive-clock").textContent = inside ? formatTime(t, true) : "—";
  drawScrub();
}

function loop() {
  if (!video.paused) { draw(); drawSyncChart(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
video.addEventListener("seeked", () => { draw(); drawSyncChart(); });
video.addEventListener("play", () => $("#play use").setAttribute("href", "#i-pause"));
video.addEventListener("pause", () => { $("#play use").setAttribute("href", "#i-play"); draw(); drawSyncChart(); });
$("#play").addEventListener("click", () => (video.paused ? video.play() : video.pause()));
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, select, textarea") || $("#editor").hidden) return;
  if (e.code === "Space") { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    const step = e.shiftKey ? 5 : 1 / state.video.fps;
    seek(video.currentTime + (e.key === "ArrowLeft" ? -step : step));
  }
});

function seek(t) {
  video.currentTime = Math.max(0, Math.min(state.video.duration, t));
  draw(); drawSyncChart();
}
window.overlay.seek = seek;
window.overlay.draw = draw;

// Dragging gauges about on the preview.
const toCanvas = (e) => {
  const r = overlayCanvas.getBoundingClientRect();
  return [(e.clientX - r.left) * overlayCanvas.width / r.width, (e.clientY - r.top) * overlayCanvas.height / r.height];
};
const hit = ([x, y]) => Object.entries(state.boxes).reverse().find(([, b]) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3])?.[0];
overlayCanvas.addEventListener("pointerdown", (e) => {
  const p = toCanvas(e), id = hit(p);
  if (!id) { video.paused ? video.play() : video.pause(); return; }
  const b = state.boxes[id];
  gaugeDrag = { id, dx: p[0] - b[0], dy: p[1] - b[1] };
  overlayCanvas.setPointerCapture(e.pointerId);
  overlayCanvas.classList.add("dragging");
  draw();
});
overlayCanvas.addEventListener("pointermove", (e) => {
  const p = toCanvas(e);
  if (!gaugeDrag) { overlayCanvas.classList.toggle("over", !!hit(p)); return; }
  const W = overlayCanvas.width, H = overlayCanvas.height;
  const pos = state.layout.widgets[gaugeDrag.id];
  pos.x = Math.max(0, Math.min(1, (p[0] - gaugeDrag.dx) / W));
  pos.y = Math.max(0, Math.min(1, (p[1] - gaugeDrag.dy) / H));
  draw();
});
const endDrag = () => { if (!gaugeDrag) return; gaugeDrag = null; overlayCanvas.classList.remove("dragging"); saveLayout(); draw(); };
overlayCanvas.addEventListener("pointerup", endDrag);
overlayCanvas.addEventListener("pointercancel", endDrag);

// The scrub bar: the video's length, where the drive covers it, the export range and the playhead.
const scrub = $("#scrub");
function drawScrub() {
  if (!state.video || !state.drive || $("#editor").hidden) return;
  const { g, w, h } = canvasFor(scrub);
  const dur = state.video.duration, X = (t) => 8 + (t / dur) * (w - 16);
  g.clearRect(0, 0, w, h);
  const c0 = Math.max(0, -state.offset), c1 = Math.min(dur, state.drive.duration - state.offset);
  const [r0, r1] = state.range;
  g.fillStyle = "rgba(255,209,102,0.10)"; g.fillRect(X(r0), 4, X(r1) - X(r0), h - 8);
  g.fillStyle = "#ffd166"; g.fillRect(X(r0) - 1, 4, 2, h - 8); g.fillRect(X(r1) - 1, 4, 2, h - 8);
  g.fillStyle = "rgba(255,255,255,0.08)"; g.fillRect(8, h / 2 - 3, w - 16, 6);
  if (c1 > c0) { g.fillStyle = "#3d7fe0"; g.fillRect(X(c0), h / 2 - 3, X(c1) - X(c0), 6); }
  // Lap starts, as ticks.
  g.fillStyle = "rgba(255,255,255,0.5)";
  for (const lap of state.prep.laps) { const t = lap.start - state.offset; if (t > 0 && t < dur) g.fillRect(X(t) - 0.5, h / 2 - 8, 1, 16); }
  const px = X(video.currentTime);
  g.fillStyle = "#fff"; g.beginPath(); g.arc(px, h / 2, 6, 0, Math.PI * 2); g.fill();
}
{
  let scrubbing = false;
  const at = (e) => { const r = scrub.getBoundingClientRect(); return ((e.clientX - r.left - 8) / (r.width - 16)) * state.video.duration; };
  scrub.addEventListener("pointerdown", (e) => { scrubbing = true; scrub.setPointerCapture(e.pointerId); seek(at(e)); });
  scrub.addEventListener("pointermove", (e) => { if (scrubbing) seek(at(e)); });
  scrub.addEventListener("pointerup", () => { scrubbing = false; });
}

// MARK: gauges

function buildGaugeControls() {
  const list = $("#widgets");
  list.innerHTML = "";
  for (const [id, w] of Object.entries(WIDGETS)) {
    const ok = available(id, state.drive);
    if (w.needle && !list.querySelector(".group")) list.append(Object.assign(document.createElement("li"), { className: "group eyebrow", textContent: "Needle gauges" }));
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: ok && state.layout.widgets[id].on, disabled: !ok });
    box.dataset.widget = id;
    box.addEventListener("change", () => { state.layout.widgets[id].on = box.checked; saveLayout(); draw(); });
    label.append(box, w.label);
    if (!ok) { label.classList.add("na"); label.title = "This drive doesn't have it"; }
    li.append(label);
    list.append(li);
  }
  $("#scale").value = state.layout.scale;
  $("#units").value = state.layout.units;
  // Needle gauges: one style for them all, and the value the value needle shows.
  const style = $("#needle-style");
  style.replaceChildren(...Object.entries(NEEDLE_STYLES).map(([id, name]) => new Option(name, id)));
  style.value = state.layout.needleStyle;
  const pick = $("#needle-value"), choices = needleChoices(state.drive);
  pick.replaceChildren(...choices.map((n) => new Option(n, n)));
  pick.value = needleValue(state.layout, state.drive) || "";
  pick.disabled = !choices.length;
  // Values: any of the drive's channels, four at most.
  const chips = $("#value-chips");
  chips.innerHTML = "";
  const names = [...state.drive.channels, ...state.drive.phone].map((c) => c.name)
    .filter((n) => !["Speed", "GPS speed", "RPM", "Boost", "Pedal"].includes(n));
  for (const name of names) {
    const b = Object.assign(document.createElement("button"), { type: "button", textContent: name });
    b.classList.toggle("on", state.layout.values.includes(name));
    b.addEventListener("click", () => {
      const v = state.layout.values;
      if (v.includes(name)) v.splice(v.indexOf(name), 1);
      else { if (v.length >= 4) v.shift(); v.push(name); }
      if (v.length) state.layout.widgets.values.on = true;
      for (const c of chips.children) c.classList.toggle("on", v.includes(c.textContent));
      $('[data-widget="values"]').checked = state.layout.widgets.values.on;
      saveLayout(); draw();
    });
    chips.append(b);
  }
}

$("#scale").addEventListener("input", (e) => { state.layout.scale = +e.target.value; saveLayout(); draw(); });
$("#units").addEventListener("change", (e) => { state.layout.units = e.target.value; saveLayout(); draw(); });
$("#needle-style").addEventListener("change", (e) => { state.layout.needleStyle = e.target.value; saveLayout(); draw(); });
$("#needle-value").addEventListener("change", (e) => {
  state.layout.needleValue = e.target.value;
  state.layout.widgets.needle.on = true;
  $('[data-widget="needle"]').checked = true;
  saveLayout(); draw();
});
$("#reset-layout").addEventListener("click", () => {
  try { localStorage.removeItem(layoutKey(state.aspect)); } catch { /* none */ }
  state.layout = defaultLayout(state.aspect);
  buildGaugeControls(); draw();
});

// MARK: export

function updateRangeInputs() {
  $("#range-start").value = formatTime(state.range[0], true);
  $("#range-end").value = formatTime(state.range[1], true);
  drawScrub();
}
function readRange() {
  const a = parseTime($("#range-start").value), b = parseTime($("#range-end").value);
  const dur = state.video.duration;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) state.range = [Math.max(0, a), Math.min(dur, b)];
  updateRangeInputs();
}
$("#range-start").addEventListener("change", readRange);
$("#range-end").addEventListener("change", readRange);
$("#range-drive").addEventListener("click", () => {
  const dur = state.video.duration;
  const a = Math.max(0, -state.offset), b = Math.min(dur, state.drive.duration - state.offset);
  if (b > a) state.range = [a, b];
  updateRangeInputs();
});

$("#export").addEventListener("click", async () => {
  if (state.exporting) return;
  const v = state.video;
  const base = v.file.name.replace(/\.[^.]+$/, "");
  const name = `${base} overlay.mp4`;
  let handle = null;
  if (window.showSaveFilePicker && !window.overlay.noPicker) {
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
    } catch (e) {
      if (e.name === "AbortError") return; // they closed the picker
      handle = null;
    }
  }
  video.pause();
  const ctrl = new AbortController();
  state.exporting = ctrl;
  const prog = $("#progress");
  prog.hidden = false; prog.classList.remove("done");
  $("#cancel").hidden = false;
  $("#export").disabled = true;
  $("#export-note").textContent = "";
  const started = performance.now();
  const [t0, t1] = state.range;
  const layout = structuredClone(state.layout);
  const ctx = { drive: state.drive, prep: state.prep, layout };
  const offset = state.offset;
  try {
    const blob = await exportVideo(v.mp4, t0, t1, (g, W, H, t) => drawOverlay(g, W, H, t + offset, ctx), {
      maxHeight: +$("#out-size").value || 0,
      quality: +$("#out-quality").value,
      handle, signal: ctrl.signal,
      onProgress: (f, frames) => {
        $("#progress-bar").style.width = `${(f * 100).toFixed(1)}%`;
        const secs = (performance.now() - started) / 1000;
        const left = f > 0.02 ? secs / f - secs : NaN;
        $("#progress-text").textContent = `${Math.round(f * 100)}% · ${(frames / secs).toFixed(0)} frames a second${Number.isFinite(left) ? ` · about ${formatTime(left)} to go` : ""}`;
      },
    });
    prog.classList.add("done");
    $("#progress-bar").style.width = "100%";
    $("#cancel").hidden = true;
    const took = formatTime((performance.now() - started) / 1000);
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $("#progress-text").textContent = `Done in ${took}: ${(blob.size / 1e6).toFixed(1)} MB, downloaded as “${name}”.`;
    } else {
      $("#progress-text").textContent = `Done in ${took}: saved as “${handle.name}”.`;
    }
    window.overlay.lastExport = blob;
  } catch (e) {
    $("#cancel").hidden = true;
    if (e.name === "AbortError") { $("#progress-text").textContent = "Cancelled."; }
    else { $("#progress-text").textContent = "It stopped."; $("#export-note").textContent = e.message || String(e); console.error(e); }
  } finally {
    state.exporting = null;
    $("#export").disabled = !!v.exportError;
  }
});
$("#cancel").addEventListener("click", () => state.exporting?.abort());
