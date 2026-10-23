// Drive Replay: opens a drive log from Boostbook's Logger and plays it back on a 3D map, with
// the car close up, its instruments, lap times and charts. Everything runs in the browser.

import {
  readLog, parseLog, processLog, at, headingAt, value, findStartLine, lapsFor, delta, toKml, toCsv, formatTime,
} from "./drivelog.js";
import { ReplayMap, BASEMAPS } from "./maplayer.js";
import { CarView } from "./carview.js";
import { WHEELBASE } from "./car3d.js";
import { Timeline, StripChart, drawGG, drawIncline } from "./charts.js";

const $ = (s) => document.querySelector(s);
const state = { mode: "chase", drive: null, t: 0, playing: false, rate: 1, laps: [], line: null, ref: null, map: null, view: null, dirty: true };
// What the chart shows first: the driving values this drive has.
const DEFAULT_CHART = ["GPS speed", "Speed", "RPM", "Pedal", "Rear axle", "Front axle", "Sideways g", "Pitch", "Roll", "Height"];
const COLOUR_BY = ["GPS speed", "Height", "Sideways g", "Forward g", "Pedal", "Rear axle", "Front axle", "Boost", "RPM", "Pitch", "Roll"];

// MARK: opening a drive

async function open(source, label) {
  $("#load-error").hidden = true;
  try {
    const text = await readLog(source);
    const drive = processLog(parseLog(text));
    if (!drive.hasGps) throw new Error("This drive has no GPS fixes to draw. Was Location allowed for Boostbook?");
    show(drive, label);
  } catch (e) {
    console.error(e);
    $("#empty").hidden = false; $("#player").hidden = true;
    $("#load-error").textContent = e.message || String(e);
    $("#load-error").hidden = false;
  }
}

function show(drive, label) {
  pause();
  state.drive = drive;
  state.t = 0;
  $("#empty").hidden = true;
  $("#player").hidden = false;
  $("#export-kml").disabled = $("#export-csv").disabled = false;
  const name = drive.header.name || label || "Drive";
  $("#drive-name").textContent = `${name}${drive.started ? ` · ${drive.started.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}` : ""}`;
  document.title = `${name} · Drive Replay`;
  $("#duration").textContent = formatTime(drive.duration);

  const car = drive.header.car || {};
  const xdrive = car.xdrive || (drive.byName["Rear axle"] ? "rear" : drive.byName["Front axle"] ? "front" : "none");
  const driven = car.driven || (xdrive === "front" ? "rear" : "front");
  state.secondary = xdrive === "front" ? "Front axle" : "Rear axle";
  state.xdrive = xdrive;
  $("#hud-xdrive-label").textContent = xdrive === "front" ? "Front axle" : xdrive === "rear" ? "Rear axle" : "xDrive";

  // A new map and close-up for each drive: its drivetrain may differ.
  if (state.map) state.map.map.remove();
  state.map = new ReplayMap($("#map"), { driven, xdrive });
  state.map.onModeChange = (mode) => { state.mode = mode; markMode(mode); };
  state.mapReady = false;
  $("#car-view").replaceChildren();
  state.view = new CarView($("#car-view"), { driven, xdrive });
  state.view.setXray($("#xray").checked);
  $("#car-caption").textContent = xdrive === "none"
    ? `${car.model || "The car"}: drive to the ${driven} wheels.`
    : `${car.model || "The car"}: the ${driven} axle always drives; xDrive's clutch sends torque to the ${xdrive === "rear" ? "rear" : "front"} axle. Drag to turn.`;

  state.line = findStartLine(drive);
  setLaps();
  fillColourBy();
  fillChips();
  fillInfo();
  state.map.ready.then(() => {
    state.map.setBasemap($("#basemap").value);
    state.map.setExaggeration(+$("#exaggeration").value);
    colourTrack();
    state.map.setStartLine(drive, state.line);
    state.map.setMarks(drive);
    setMode(state.mode);
    state.mapReady = true;
    state.dirty = true;
  });
  state.dirty = true;
}

function setLaps() {
  const d = state.drive;
  state.laps = lapsFor(d, state.line);
  state.ref = state.laps.find((l) => l.best) || null;
  timeline.set(d, state.laps);
  chart.set(d, state.laps);
  state.map?.ready.then(() => state.map.setStartLine(d, state.line));
  fillLaps();
  state.dirty = true;
}

// MARK: playback

function play() {
  if (!state.drive) return;
  if (state.t >= state.drive.duration) state.t = 0;
  state.playing = true;
  $("#play").textContent = "⏸"; $("#play").setAttribute("aria-label", "Pause");
}

function pause() {
  state.playing = false;
  $("#play").textContent = "▶"; $("#play").setAttribute("aria-label", "Play");
}

function seek(t) {
  if (!state.drive) return;
  state.t = Math.min(state.drive.duration, Math.max(0, t));
  state.dirty = true;
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const d = state.drive;
  let simDt = 0;
  if (d && state.playing) {
    simDt = dt * state.rate;
    state.t += simDt;
    if (state.t >= d.duration) { state.t = d.duration; pause(); }
    state.dirty = true;
  }
  if (d && state.dirty) {
    state.dirty = false;
    draw(simDt);
  }
  requestAnimationFrame(frame);
}

/** What the car was doing at t, for the 3D views. */
function carState(t, dt) {
  const d = state.drive;
  const gps = at(d, d.speed, t) * 3.6;
  const speed = Number.isFinite(value(d, "Speed", t)) ? value(d, "Speed", t) : gps;
  const wheels = ["Wheel FL", "Wheel FR", "Wheel RL", "Wheel RR"].map((n) => value(d, n, t));
  // Steering from how fast it turns at this speed: a bicycle model's angle.
  let yaw = d.hasMotion ? at(d, d.yaw, t) : value(d, "Yaw rate", t);
  if (!Number.isFinite(yaw)) yaw = 0;
  const v = speed / 3.6;
  const steer = v > 3 ? Math.max(-35, Math.min(35, Math.atan((WHEELBASE * yaw * Math.PI / 180) / v) * 180 / Math.PI)) : 0;
  const longG = d.hasMotion ? at(d, d.longG, t) : value(d, "Longitudinal", t);
  const pedal = value(d, "Pedal", t);
  const braking = Number.isFinite(longG) && longG < -0.12 && !(pedal > 5) ? Math.min(1, (-longG - 0.1) / 0.6) : 0;
  return {
    dt, speed, steer, braking,
    wheels: wheels.every(Number.isFinite) ? wheels : null,
    engine: value(d, "Torque", t),
    secondary: value(d, state.secondary, t),
  };
}

const fmt = (v, digits = 0, unit = "") => (Number.isFinite(v) ? `${v.toFixed(digits)}${unit ? ` ${unit}` : ""}` : "—");

function draw(dt) {
  const d = state.drive, t = state.t;
  const pose = {
    lat: at(d, d.lat, t), lon: at(d, d.lon, t), heading: headingAt(d, t),
    pitch: d.hasMotion ? at(d, d.pitch, t) : 0, roll: d.hasMotion ? at(d, d.roll, t) : 0, distance: at(d, d.dist, t),
  };
  const cs = carState(t, dt);
  state.map.show(pose, cs);
  const torque = cs.engine, second = cs.secondary;
  state.view.render(pose, cs, {
    engine: Number.isFinite(torque) ? `Engine ${Math.round(torque)} Nm` : "",
    primary: Number.isFinite(cs.speed) ? `${Math.round(cs.speed)} km/h` : "",
    secondary: Number.isFinite(second) ? `xDrive ${Math.round(second)} Nm` : "",
  });
  drawIncline($("#incline"), pose.pitch, pose.roll);
  drawGG($("#gg"), d, t);
  timeline.draw(t);
  chart.draw(t);
  $("#clock").textContent = formatTime(t, true);
  // The readout.
  $("#hud-speed").textContent = Math.round(cs.speed);
  $("#hud-rpm").textContent = fmt(value(d, "RPM", t));
  $("#hud-pedal").textContent = fmt(value(d, "Pedal", t), 0, "%");
  $("#hud-torque").textContent = fmt(torque, 0, "Nm");
  $("#hud-xdrive").textContent = fmt(second, 0, "Nm");
  $("#hud-height").textContent = fmt(at(d, d.alt, t), 0, "m");
  const lap = state.laps.find((l) => t >= l.start && t < l.end);
  $("#hud-lap").hidden = !state.laps.length;
  if (state.laps.length) {
    if (lap) {
      $("#hud-lap-n").textContent = `Lap ${lap.n}/${state.laps.length}`;
      $("#hud-lap-time").textContent = formatTime(t - lap.start, true);
      const dl = delta(d, lap, state.ref, t);
      const el = $("#hud-delta");
      el.textContent = Number.isFinite(dl) ? `${dl >= 0 ? "+" : "−"}${Math.abs(dl).toFixed(2)} s on lap ${state.ref.n}` : "";
      el.className = `delta ${dl < 0 ? "gain" : dl > 0 ? "loss" : ""}`;
    } else {
      const done = state.laps.filter((l) => l.end <= t).at(-1);
      $("#hud-lap-n").textContent = done ? `Lap ${done.n}` : "Out lap";
      $("#hud-lap-time").textContent = done ? formatTime(done.time, true) : formatTime(t, true);
      $("#hud-delta").textContent = "";
    }
    for (const row of document.querySelectorAll("#laps tr[data-lap]")) row.classList.toggle("current", lap && +row.dataset.lap === lap.n);
  }
  updateValues(t);
}

// MARK: side panels

let valuesAt = 0;
function updateValues(t) {
  const now = performance.now();
  if (now - valuesAt < 100 && state.playing) return; // ten times a second is plenty to read
  valuesAt = now;
  const d = state.drive;
  const rows = [];
  let group = null;
  for (const c of [...d.phone, ...d.channels]) {
    if (c.group !== group) { group = c.group; rows.push(`<tr class="group"><td colspan="3">${group}</td></tr>`); }
    const v = at(d, c.values, t);
    const text = !Number.isFinite(v) ? "—" : c.states ? (c.states[Math.round(v)] ?? v) : `${v.toFixed(c.digits ?? 0)}${c.unit ? ` ${c.unit}` : ""}`;
    const lo = c.min ?? 0, hi = c.max ?? 1;
    const f = Number.isFinite(v) ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0;
    rows.push(`<tr><td>${c.name}</td><td class="bar"><div class="meter"><span style="width:${(f * 100).toFixed(0)}%"></span></div></td><td class="v">${text}</td></tr>`);
  }
  $("#values").innerHTML = rows.join("");
}

function fillLaps() {
  const laps = state.laps;
  const note = $("#laps-note");
  if (!state.line) note.textContent = "No laps: this drive doesn't pass the same place twice. To time from a place, play to it and choose Start/finish here.";
  else if (!laps.length) note.textContent = "The start/finish line is set, but the drive doesn't cross it twice going the same way.";
  else note.textContent = `${laps.length} lap${laps.length > 1 ? "s" : ""} from the dashed line on the map. Click one to watch it; the delta is against the green one.`;
  const best = laps.find((l) => l.best);
  $("#laps").innerHTML = laps.length ? `<tr><th>Lap</th><th class="num">Time</th><th class="num">Gap</th><th class="num">Top</th></tr>` + laps.map((l) =>
    `<tr data-lap="${l.n}" class="${l.best ? "best" : ""}"><td>${l.n}</td><td class="num">${formatTime(l.time, 2)}</td>`
    + `<td class="num">${best && !l.best ? `+${(l.time - best.time).toFixed(2)}` : ""}</td><td class="num">${Math.round(l.maxSpeed * 3.6)} km/h</td></tr>`).join("") : "";
}

function fillInfo() {
  const d = state.drive, h = d.header, car = h.car || {};
  const m = d.mount;
  const upFrom = { level: "Level, set in the app", parked: "gravity while parked", preset: "how the iPhone was mounted" }[m.upFrom];
  const fwdFrom = { drive: `learnt from the drive (fit ${(m.confidence * 100).toFixed(0)}%)`, phone: "as the app learnt it", preset: "how the iPhone was mounted" }[m.forwardFrom];
  let maxSpeed = 0, maxLat = 0, maxPitch = 0, maxRoll = 0;
  for (let i = 0; i < d.n; i++) {
    maxSpeed = Math.max(maxSpeed, d.speed[i]); maxLat = Math.max(maxLat, Math.abs(d.latG[i]));
    maxPitch = Math.max(maxPitch, Math.abs(d.pitch[i])); maxRoll = Math.max(maxRoll, Math.abs(d.roll[i]));
  }
  const items = [
    ["Name", h.name], ["Started", d.started?.toLocaleString()], ["Time", formatTime(d.duration)],
    ["Distance", `${(d.dist[d.n - 1] / 1000).toFixed(2)} km`], ["Top speed", `${Math.round(maxSpeed * 3.6)} km/h`],
    ["Height", `${Math.round(Math.min(...d.alt))}–${Math.round(Math.max(...d.alt))} m`],
    ...(d.hasMotion ? [["Most pitch", `${maxPitch.toFixed(1)}°`], ["Most roll", `${maxRoll.toFixed(1)}°`], ["Cornering", `${maxLat.toFixed(2)} g`]] : []),
    ["Car", [car.model, car.name].filter(Boolean).join(", ") || "—"],
    ["xDrive", { rear: "to the rear axle (a clutch)", front: "to the front axle (a transfer case)", none: "none" }[state.xdrive] || "—"],
    ["Car values", d.channels.length ? `${d.channels.length}, ${d.raw.car.length.toLocaleString()} readings` : "none"],
    ["GPS fixes", d.raw.gps.length.toLocaleString()], ["Motion", d.hasMotion ? `${d.raw.motion.length.toLocaleString()} readings` : "none"],
    ["Up", upFrom], ["Forward", fwdFrom],
    ["Recorded by", `Boostbook ${h.app || ""}${h.simulated ? " (simulator)" : ""}`],
    ...d.notes.map((n) => [formatTime(n.t), n.text]),
  ];
  $("#info").innerHTML = items.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${String(v).replace(/</g, "&lt;")}</dd>`).join("");
}

function fillColourBy() {
  const d = state.drive, sel = $("#colour-by");
  const prev = sel.value || "GPS speed";
  sel.innerHTML = COLOUR_BY.filter((n) => d.byName[n]).map((n) => `<option>${n}</option>`).join("");
  sel.value = d.byName[prev] ? prev : "GPS speed";
}

function colourTrack() {
  const d = state.drive, c = d.byName[$("#colour-by").value];
  if (!c) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of c.values) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (c.min < 0 && c.max > 0) { const m = Math.max(-lo, hi); lo = -m; hi = m; }
  state.map.setTrack(d, c.values, lo, hi);
}

let chartNames = null;
function fillChips() {
  const d = state.drive;
  const all = [...d.phone, ...d.channels].map((c) => c.name);
  if (!chartNames || !chartNames.some((n) => d.byName[n])) {
    chartNames = DEFAULT_CHART.filter((n) => d.byName[n]);
    if (chartNames.includes("Speed")) chartNames = chartNames.filter((n) => n !== "GPS speed");
    chartNames = chartNames.slice(0, 6);
  }
  chart.names = chartNames.filter((n) => d.byName[n]);
  $("#chips").innerHTML = all.map((n) => `<span class="chip${chart.names.includes(n) ? " on" : ""}" role="checkbox" tabindex="0" aria-checked="${chart.names.includes(n)}" data-name="${n}">${n}</span>`).join("");
}

function toggleChip(el) {
  const n = el.dataset.name;
  chartNames = chart.names.includes(n) ? chart.names.filter((x) => x !== n) : [...chart.names, n];
  chart.names = chartNames;
  el.classList.toggle("on"); el.setAttribute("aria-checked", el.classList.contains("on"));
  state.dirty = true;
}

function markMode(mode) {
  for (const b of document.querySelectorAll(".seg button")) b.classList.toggle("on", b.dataset.mode === mode);
}

function setMode(mode) {
  state.mode = mode;
  if (!state.map) return;
  if (mode === "fit") { state.map.setMode("free"); state.map.fit(state.drive); markMode("fit"); return; }
  state.map.setMode(mode);
  markMode(mode);
  state.dirty = true;
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const fileName = () => (state.drive.header.name || "drive").replace(/[\\/:*?"<>|]+/g, "-");

// MARK: wiring

const timeline = new Timeline($("#timeline"), seek);
const chart = new StripChart($("#chart"), seek);
chart.window = +$("#window").value;

for (const [id, b] of Object.entries(BASEMAPS)) $("#basemap").add(new Option(b.label, id));
try { const saved = localStorage.getItem("replayBasemap"); if (saved && BASEMAPS[saved]) $("#basemap").value = saved; } catch { /* storage blocked */ }

for (const input of ["#open", "#open2"]) {
  $(input).addEventListener("change", (e) => { const f = e.target.files[0]; if (f) open(f, f.name); e.target.value = ""; });
}
const sample = async () => {
  const res = await fetch("/static/sample-drive.bblog.gz");
  if (!res.ok) { $("#load-error").textContent = "The sample drive is missing."; $("#load-error").hidden = false; return; }
  await open(await res.arrayBuffer(), "Sample drive");
  play();
};
$("#sample").addEventListener("click", sample);
$("#sample2").addEventListener("click", sample);
document.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
document.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const f = e.dataTransfer.files[0];
  if (f) open(f, f.name);
});

$("#play").addEventListener("click", () => (state.playing ? pause() : play()));
$("#back").addEventListener("click", () => seek(state.t - 5));
$("#fwd").addEventListener("click", () => seek(state.t + 5));
$("#rate").addEventListener("change", (e) => { state.rate = +e.target.value; });
$("#window").addEventListener("change", (e) => { chart.window = +e.target.value; state.dirty = true; });
$("#xray").addEventListener("change", (e) => { state.view?.setXray(e.target.checked); state.dirty = true; });
for (const b of document.querySelectorAll(".seg button")) b.addEventListener("click", () => setMode(b.dataset.mode));
$("#basemap").addEventListener("change", (e) => {
  state.map?.setBasemap(e.target.value);
  try { localStorage.setItem("replayBasemap", e.target.value); } catch { /* storage blocked */ }
});
$("#colour-by").addEventListener("change", colourTrack);
$("#exaggeration").addEventListener("input", (e) => {
  $("#exaggeration-value").textContent = `${e.target.value}×`;
  state.map?.setExaggeration(+e.target.value);
  state.dirty = true;
});
$("#chips").addEventListener("click", (e) => { if (e.target.dataset.name) toggleChip(e.target); });
$("#chips").addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && e.target.dataset.name) { e.preventDefault(); toggleChip(e.target); } });
for (const tab of document.querySelectorAll(".tabs button")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tabs button")) {
      t.setAttribute("aria-selected", t === tab);
      $(`#tab-${t.dataset.tab}`).hidden = t !== tab;
    }
  });
}
$("#laps").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-lap]");
  const lap = row && state.laps.find((l) => l.n === +row.dataset.lap);
  if (lap) { seek(lap.start); play(); }
});
$("#set-line").addEventListener("click", () => {
  const d = state.drive, t = state.t;
  state.line = { x: at(d, d.x, t), y: at(d, d.y, t), heading: headingAt(d, t) };
  setLaps();
});
$("#auto-line").addEventListener("click", () => { state.line = findStartLine(state.drive); setLaps(); });
$("#no-line").addEventListener("click", () => { state.line = null; setLaps(); });
$("#export-kml").addEventListener("click", () => download(toKml(state.drive, { laps: state.laps }), `${fileName()}.kml`, "application/vnd.google-earth.kml+xml"));
$("#export-csv").addEventListener("click", () => download(toCsv(state.drive), `${fileName()}.csv`, "text/csv"));

document.addEventListener("keydown", (e) => {
  if (!state.drive || e.target.closest("input, select, textarea")) return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); state.playing ? pause() : play(); }
  else if (k === "ArrowLeft") seek(state.t - (e.shiftKey ? 1 : 5));
  else if (k === "ArrowRight") seek(state.t + (e.shiftKey ? 1 : 5));
  else if (k === "Home") seek(0);
  else if (k === "End") seek(state.drive.duration);
  else if (k === "c") setMode("chase");
  else if (k === "t") setMode("top");
  else if (k === "f") setMode("free");
  else if (k === "w") setMode("fit");
  else if (k === "[" || k === "]") {
    const sel = $("#rate"), i = sel.selectedIndex + (k === "]" ? 1 : -1);
    if (i >= 0 && i < sel.options.length) { sel.selectedIndex = i; state.rate = +sel.value; }
  }
});
window.addEventListener("resize", () => { state.dirty = true; });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { timeline.cache = null; state.dirty = true; });

requestAnimationFrame(frame);
// /replay?sample opens the sample at once.
if (new URLSearchParams(location.search).has("sample")) sample();

// For the tests: the state, and the log functions.
window.replay = { state, open, seek, play, pause };
