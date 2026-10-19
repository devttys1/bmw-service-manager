"use strict";

const $ = (sel) => document.querySelector(sel);
let meta = null;
let records = [];
const editing = new WeakSet();  // records whose editor is open

function log(line) {
  const el = $("#log");
  el.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
  el.scrollTop = el.scrollHeight;
}

async function api(path, body, { text = false } = {}) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: typeof body === "string" ? { "Content-Type": "text/plain" } : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return text ? res.text() : res.json();
}

let working = 0;  // requests to the car in progress: the connection light waits for them

async function busy(button, fn, output) {
  button.disabled = true;
  working++;
  try { await fn(); } catch (e) {
    log(`ERROR: ${e.message}`);
    if (output) show(output, [`<span class="err">Error: ${escapeHtml(e.message)}</span>`]);
  } finally { button.disabled = false; working--; }
}

// The connection light: asks the car every few seconds whether it answers.
const STATUS = {
  not_set: ["Not connected", () => "Find the vehicle below"],
  checking: ["Checking…", (s) => s.ip],
  connected: ["Connected", (s) => [s.vin && `VIN ${s.vin}`, s.ip].filter(Boolean).join(" · ")],
  simulator: ["Simulator", () => "a pretend car, no cable needed"],
  no_answer: ["Not responding", (s) => `${s.ip}: check the cable and ignition`],
};

function showStatus(s) {
  const box = $("#car-status");
  const [title, detail] = STATUS[s.state] || STATUS.not_set;
  box.dataset.state = s.state;
  box.querySelector("strong").textContent = title;
  box.querySelector(".detail").textContent = detail(s) || "";
  box.title = s.state === "connected" ? `Last answer ${new Date().toLocaleTimeString()}` : "";
}

let lastStatusHost = null;

async function checkStatus() {
  if (working || document.hidden) return;
  const { host, port } = connection();
  if (host !== lastStatusHost) { lastStatusHost = host; if (host) showStatus({ state: "checking", ip: host }); }
  try {
    showStatus(await api(`/api/status?host=${encodeURIComponent(host)}&port=${port}`));
  } catch { /* the app itself stopped: leave the last state */ }
}

// Dealers used before (number -> BMW dealer?), newest first: from the records and this browser.
function knownDealers(except = null) {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("dealers") || "[]"); } catch { /* storage blocked */ }
  const fromRecords = records.filter((r) => r !== except).sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map((r) => ({ number: r.dealer_number, bmw: !!r.bmw_dealer }));
  const seen = new Set();
  return [...fromRecords, ...saved].filter((d) => d.number && !seen.has(d.number) && seen.add(d.number));
}

function rememberDealer(number, bmw) {
  if (!number) return;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem("dealers") || "[]"); } catch { /* storage blocked */ }
  const list = [{ number, bmw }, ...saved.filter((d) => d.number !== number)].slice(0, 50);
  try { localStorage.setItem("dealers", JSON.stringify(list)); } catch { /* storage blocked */ }
}

function renderDealers() {
  $("#dealers").innerHTML = knownDealers()
    .map((d) => `<option value="${escapeHtml(d.number)}">${d.bmw ? "BMW dealer" : "Independent"}</option>`).join("");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Show result lines right under the action, not just in the log at the bottom.
function show(output, htmlLines) {
  output.innerHTML = htmlLines.join("\n");
  output.hidden = false;
  output.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

// Two clicks within 5 s, instead of a blocking browser dialog.
function armed(button, label, fn, output) {
  let timer = null;
  const original = button.textContent;
  button.addEventListener("click", () => {
    if (!timer) {
      button.textContent = label;
      timer = setTimeout(() => { button.textContent = original; timer = null; }, 5000);
      return;
    }
    clearTimeout(timer); timer = null; button.textContent = original;
    busy(button, fn, output);
  });
}

function connection() {
  return { host: $("#host").value.trim(), port: Number($("#port").value) || 6801 };
}

function today() { return new Date().toISOString().slice(0, 10); }

function newRecord() {
  return { date: today(), mileage_km: 0, bmw_dealer: true, dealer_number: "", status: 1, correction: 0,
           items: [{ code: 1, status: 1, remaining_distance: 0, remaining_time: 0 }] };
}

function options(map, selected) {
  return Object.entries(map).map(([k, v]) => `<option value="${k}" ${Number(k) === Number(selected) ? "selected" : ""}>${v}</option>`).join("");
}

function pill(text, tint) {
  return `<span class="pill" style="--tint: var(--${tint})">${escapeHtml(text)}</span>`;
}

function itemChip(item) {
  const s = itemStyle(item.code);
  const name = meta.item_types[item.code] || `Unknown (${item.code})`;
  const late = Number(item.status) !== 1
    ? ` <b style="color: var(--${statusTint(item.status)})">${escapeHtml(meta.item_statuses[item.status] || `status ${item.status}`)}</b>` : "";
  return `<span class="chip" style="--tint: var(--${s.tint})">${icon(s.icon)}${escapeHtml(name)}${late}</span>`;
}

// The card summary: date tile, mileage, dealer, status and one chip per item.
function renderSummary(node, rec) {
  const [y, m, d] = (rec.date || "").split("-").map(Number);
  const date = y && m && d ? new Date(y, m - 1, d) : null;
  node.querySelector(".day").textContent = date ? d : "?";
  node.querySelector(".month").textContent = date ? date.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "no date";
  node.querySelector(".km").textContent = `${Number(rec.mileage_km || 0).toLocaleString()} km`;
  node.querySelector(".rec-status").outerHTML = `<span class="rec-status">${pill(meta.record_statuses[rec.status] || `status ${rec.status}`, statusTint(rec.status))}</span>`;
  const kind = rec.bmw_dealer ? "BMW dealer" : "Independent";
  node.querySelector(".dealer").innerHTML = `${icon(rec.bmw_dealer ? "garage" : "tool")}${escapeHtml(rec.dealer_number ? `${kind} ${rec.dealer_number}` : kind)}`;
  node.querySelector(".chips").innerHTML = rec.items.map(itemChip).join("");
}

// Highest mileage first; the later date first when two match.
function byMileage(a, b) {
  return (Number(b.mileage_km) - Number(a.mileage_km)) || String(b.date).localeCompare(String(a.date));
}

function isSortedByMileage() {
  return records.every((r, i) => i === 0 || byMileage(records[i - 1], r) <= 0);
}

// A number field shows nothing for 0 (its placeholder is a grey 0), so typing doesn't follow a 0.
function numberText(v) { return Number(v) ? String(v) : ""; }

let dragFrom = null;

// Over the lower half of a card: drop after it. (offsetY is relative to whichever child is under the pointer.)
function dropsAfter(node, ev) {
  const box = node.getBoundingClientRect();
  return ev.clientY > box.top + box.height / 2;
}

// Drag a record (by its card, while its editor is closed) and drop it above or below another.
function makeDraggable(node, idx) {
  node.draggable = true;
  node.addEventListener("dragstart", (ev) => {
    dragFrom = idx;
    node.classList.add("dragging");
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(idx));
  });
  node.addEventListener("dragend", () => { dragFrom = null; render(); });
  node.addEventListener("dragover", (ev) => {
    if (dragFrom === null) return;
    ev.preventDefault();
    const after = dropsAfter(node, ev);
    node.classList.toggle("drop-before", !after);
    node.classList.toggle("drop-after", after);
  });
  node.addEventListener("dragleave", () => node.classList.remove("drop-before", "drop-after"));
  node.addEventListener("drop", (ev) => {
    ev.preventDefault();
    if (dragFrom === null) return;
    const after = dropsAfter(node, ev);
    moveRecord(dragFrom, idx + (after ? 1 : 0));
    dragFrom = null;
  });
}

// Moves records[from] so it lands before the record now at index `to` (records.length: the end).
function moveRecord(from, to) {
  const [rec] = records.splice(from, 1);
  records.splice(to > from ? to - 1 : to, 0, rec);
  log(`Moved the ${Number(rec.mileage_km).toLocaleString()} km record to position ${records.indexOf(rec) + 1}.`);
  render();
}

function render() {
  const host = $("#records");
  host.innerHTML = "";
  renderDealers();
  $("#qr-panel").hidden = true;  // a QR code shown before a change no longer matches the records
  if (!records.length) host.innerHTML = '<p class="muted">No records yet. Add one, or import a .tst or .json file.</p>';
  $("#sort-km").disabled = records.length < 2 || isSortedByMileage();
  records.forEach((rec, idx) => {
    const node = $("#record-tpl").content.firstElementChild.cloneNode(true);
    if (!editing.has(rec)) makeDraggable(node, idx);
    const editor = node.querySelector(".rec-edit");
    editor.hidden = !editing.has(rec);
    node.querySelector('[data-act="edit"]').textContent = editing.has(rec) ? "Done" : "Edit";
    node.querySelector('[data-f="status"]').innerHTML = options(meta.record_statuses, rec.status);
    renderSummary(node, rec);
    for (const input of node.querySelectorAll("[data-f]")) {
      const f = input.dataset.f;
      if (f === "bmw_dealer") input.value = rec.bmw_dealer ? "1" : "0";
      else if (input.type === "number") input.value = numberText(rec[f]);
      else if (f !== "status") input.value = rec[f];
      input.addEventListener("change", () => {
        if (f === "bmw_dealer") { rec.bmw_dealer = input.value === "1"; rememberDealer(rec.dealer_number, rec.bmw_dealer); }
        else if (f === "dealer_number") {
          rec[f] = input.value.trim();
          // A dealer picked from the list brings its type (BMW dealer or independent) with it.
          const known = knownDealers(rec).find((d) => d.number === rec[f]);
          if (known && known.bmw !== rec.bmw_dealer) {
            rec.bmw_dealer = known.bmw;
            node.querySelector('[data-f="bmw_dealer"]').value = known.bmw ? "1" : "0";
          }
          rememberDealer(rec[f], rec.bmw_dealer);
          renderDealers();
        } else if (f === "date") rec[f] = input.value;
        else rec[f] = Number(input.value) || 0;
        renderSummary(node, rec);
        $("#qr-panel").hidden = true;
        $("#sort-km").disabled = records.length < 2 || isSortedByMileage();
      });
    }
    const body = node.querySelector("tbody");
    rec.items.forEach((item, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><div class="item-pick">${itemIcon(item.code, "small")}<select data-k="code">${options(meta.item_types, item.code)}</select></div></td>
        <td><select data-k="status">${options(meta.item_statuses, item.status)}</select></td>
        <td><input data-k="remaining_time" type="number" min="0" max="65535" placeholder="0" value="${numberText(item.remaining_time)}" title="Months late/overdue shown by iDrive"></td>
        <td><input data-k="remaining_distance" type="number" min="0" max="4294967295" placeholder="0" value="${numberText(item.remaining_distance)}" title="km late/overdue shown by iDrive"></td>
        <td><button class="danger small">Remove</button></td>`;
      tr.querySelectorAll("select, input").forEach((s) => s.addEventListener("change", () => {
        item[s.dataset.k] = Number(s.value) || 0;
        if (s.dataset.k === "code") tr.querySelector(".icon-tile").outerHTML = itemIcon(item.code, "small");
        renderSummary(node, rec);
        $("#qr-panel").hidden = true;
      }));
      tr.querySelector("button").addEventListener("click", () => { rec.items.splice(i, 1); render(); });
      body.appendChild(tr);
    });
    node.addEventListener("click", (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "edit") { if (editing.has(rec)) editing.delete(rec); else editing.add(rec); }
      if (act === "remove") records.splice(idx, 1);
      if (act === "up" && idx > 0) [records[idx - 1], records[idx]] = [records[idx], records[idx - 1]];
      if (act === "down" && idx < records.length - 1) [records[idx + 1], records[idx]] = [records[idx], records[idx + 1]];
      if (act === "add-item") {
        if (rec.items.length >= meta.max_items) return log(`A record holds at most ${meta.max_items} items.`);
        rec.items.push({ code: 1, status: 1, remaining_distance: 0, remaining_time: 0 });
      }
      render();
    });
    host.appendChild(node);
  });
}

function download(name, content, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function logFrames(frames) {
  for (const [dir, hex] of frames || []) log(`  ${dir === "tx" ? "→" : "←"} ${hex}`);
}

function availabilityTint(a) {
  return a <= 10 ? "red" : a <= 30 ? "orange" : "green";
}

// One card per CBS item, each with its own Reset (sent to the ECU that owns the item).
function renderCbs(items) {
  const list = $("#cbs-list");
  list.innerHTML = items.length ? "" : '<div class="placeholder"><strong>No service items</strong><span class="muted">The instrument cluster answered, but listed no CBS items.</span></div>';
  for (const i of items) {
    const card = document.createElement("div");
    card.className = "cbs-item";
    const avail = i.availability === null
      ? `<div class="meta muted">${icon("tool")}Wear sensor</div>`
      : `<div class="avail" style="--tint: var(--${availabilityTint(i.availability)})"><div class="bar"><div style="width: ${i.availability}%"></div></div><span>${i.availability}%</span></div>`;
    const facts = [];
    if (i.remaining_km !== null) {
      const km = i.remaining_km;
      const tint = km < 0 ? "red" : km === 0 ? "orange" : "";
      facts.push(`<span style="${tint && `color: var(--${tint})`}">${icon("road")}${km < 0 ? `${(-km).toLocaleString()} km overdue` : km === 0 ? "Due now" : `${km.toLocaleString()} km left`}</span>`);
    }
    if (i.due) facts.push(`<span style="${i.overdue && !(i.remaining_km < 0) ? "color: var(--red)" : ""}">${icon("calendar")}${i.due}</span>`);
    const details = [i.interval_km && `every ${i.interval_km.toLocaleString()} km`, i.interval_months && `every ${i.interval_months} months`,
                     `${i.resets} services`, `via ${i.owner}`].filter(Boolean).join(" · ");
    card.innerHTML = `${itemIcon(i.code, "large")}
      <div class="cbs-main">
        <div class="rec-line"><span><strong>${escapeHtml(i.name)}</strong> ${i.overdue ? pill("Due", "red") : ""}</span>
          <button class="danger small">Reset</button></div>
        ${avail}
        ${facts.length ? `<div class="meta">${facts.join("")}</div>` : ""}
        <div class="muted small">${details}</div>
        <code class="raw">${i.raw}</code>
      </div>`;
    armed(card.querySelector("button"), "Click again to reset", () => resetCbs(i), $("#cbs-output"));
    list.appendChild(card);
  }
}

// DME items report their raw DID 0x1001 block; everything else its decoded cluster slot.
function cbsStatusText(s) {
  if (!s) return "not answered";
  if (!("code" in s)) return s.raw ?? "not answered";  // the DME's {raw} block
  return `${s.availability ?? "sensor"}% · ${s.resets} services · due ${s.due || "—"}`;
}

async function resetCbs(item) {
  const out = $("#cbs-output");
  show(out, [`Resetting ${escapeHtml(item.name.toLowerCase())} in the ${item.owner}…`]);
  const { items, before, after, frames } = await api("/api/cbs/reset", { ...connection(), item: item.code });
  logFrames(frames);
  renderCbs(items);
  const lines = [`Reset of ${item.name.toLowerCase()} accepted (6E 10 01).`, `Before: ${cbsStatusText(before)}`, `After:  ${cbsStatusText(after)}`];
  show(out, lines.map(escapeHtml));
  log(lines.join("\n"));
}

function writeBody() {
  return { ...connection(), records, erase: $("#erase").checked, reset: $("#reset").checked };
}

async function init() {
  meta = await api("/api/meta");
  if (meta.default_host) {
    $("#host").value = meta.default_host;
    $("#port").value = meta.default_port;
    log(`Simulator mode: head unit at ${meta.default_host}:${meta.default_port}`);
  }
  render();
  $("#version").textContent = meta.version;
  checkStatus();
  setInterval(checkStatus, 4000);
  $("#host").addEventListener("change", checkStatus);
  $("#port").addEventListener("change", checkStatus);

  // The probe tools stay hidden unless turned on under Advanced (remembered in this browser).
  const showProbe = $("#show-probe");
  const applyProbe = () => { $("#probe-card").hidden = !showProbe.checked; };
  try { showProbe.checked = localStorage.getItem("showProbe") === "1"; } catch { /* storage blocked */ }
  applyProbe();
  showProbe.addEventListener("change", () => {
    try { localStorage.setItem("showProbe", showProbe.checked ? "1" : "0"); } catch { /* storage blocked */ }
    applyProbe();
  });

  // Appearance: System follows the computer; Light and Dark override it (remembered in this browser).
  const theme = $("#theme");
  theme.value = document.documentElement.dataset.theme || "system";
  theme.addEventListener("change", () => {
    if (theme.value === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try { localStorage.setItem("theme", theme.value); } catch { /* storage blocked */ }
  });

  $("#sort-km").addEventListener("click", () => {
    records.sort(byMileage);
    log("Sorted by mileage, highest first.");
    render();
  });

  $("#discover").addEventListener("click", (e) => busy(e.target, async () => {
    log("Broadcasting vehicle identification request…");
    const { vehicles } = await api("/api/discover", {});
    const box = $("#vehicles");
    if (!vehicles.length) { box.textContent = "No vehicle answered. Check the cable and ignition, or type the IP address."; return; }
    box.innerHTML = "";
    for (const v of vehicles) {
      const div = document.createElement("div");
      div.className = "vehicle";
      div.textContent = `${v.ip}  VIN ${v.vin || "?"}  MAC ${v.mac || "?"}`;
      const use = document.createElement("button");
      use.textContent = "Use";
      use.className = "secondary";
      use.addEventListener("click", () => { $("#host").value = v.ip; if (v.vin) $("#vin").value = v.vin; log(`Using ${v.ip} (${v.vin})`); });
      div.appendChild(use);
      box.appendChild(div);
      log(`Found ${v.ip} VIN ${v.vin}`);
    }
    if (vehicles.length === 1) { $("#host").value = vehicles[0].ip; if (vehicles[0].vin) $("#vin").value = vehicles[0].vin; }
  }));

  $("#add-record").addEventListener("click", () => { records.push(newRecord()); render(); });

  $("#import-tst").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const res = await api("/api/import/tst", await file.text());
      records = res.records;
      $("#erase").checked = res.erase;
      render();
      log(`Imported ${records.length} records from ${file.name}`);
    } catch (err) { log(`ERROR: ${err.message}`); }
    e.target.value = "";
  });

  $("#import-json").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      records = data.records || data;
      if (data.vin) $("#vin").value = data.vin;
      render();
      log(`Imported ${records.length} records from ${file.name}`);
    } catch (err) { log(`ERROR: ${err.message}`); }
    e.target.value = "";
  });

  $("#export-tst").addEventListener("click", (e) => busy(e.target, async () => {
    download("service-history.tst", await api("/api/export/tst", writeBody(), { text: true }), "text/plain");
  }));

  // The same format as Stampbook's exports, so either app can import the other's file.
  $("#export-json").addEventListener("click", () => {
    const vin = $("#vin").value.trim().toUpperCase();
    const file = { format: "stampbook-history", version: 1, saved: new Date().toISOString(), records };
    if (vin) file.vin = vin;
    download(`${vin ? `${vin} ` : ""}service history ${today()}.json`, JSON.stringify(file, null, 2), "application/json");
  });

  let qr = { svgs: [], at: 0 };
  const showQr = () => {
    $("#qr-code").innerHTML = qr.svgs[qr.at];
    $("#qr-nav").hidden = qr.svgs.length < 2;
    $("#qr-count").textContent = `${qr.at + 1} of ${qr.svgs.length}`;
    $("#qr-prev").disabled = qr.at === 0;
    $("#qr-next").disabled = qr.at === qr.svgs.length - 1;
    $("#qr-hint").textContent = qr.svgs.length > 1 ? "Scan every code, in any order: Stampbook waits until it has them all." : "";
    $("#qr-panel").hidden = false;
  };
  $("#show-qr").addEventListener("click", (e) => busy(e.target, async () => {
    const { svgs, parts } = await api("/api/qr", { records, vin: $("#vin").value });
    qr = { svgs, at: 0 };
    showQr();
    $("#qr-panel").scrollIntoView({ block: "nearest", behavior: "smooth" });
    log(`QR code for ${records.length} records (${parts.length === 1 ? "one code" : `${parts.length} codes`}, ${parts.join("").length} characters).`);
  }));
  $("#qr-prev").addEventListener("click", () => { qr.at = Math.max(0, qr.at - 1); showQr(); });
  $("#qr-next").addEventListener("click", () => { qr.at = Math.min(qr.svgs.length - 1, qr.at + 1); showQr(); });
  $("#qr-close").addEventListener("click", () => { $("#qr-panel").hidden = true; });

  const writeOut = $("#write-output");

  $("#preview").addEventListener("click", (e) => busy(e.target, async () => {
    const { steps } = await api("/api/plan", writeBody());
    const lines = [`Preview: ${steps.length} requests to head unit 0x63 (nothing sent)`];
    for (const s of steps) lines.push(`${escapeHtml(s.label)}\n  ${s.request}`);
    show(writeOut, lines);
    log(lines.join("\n"));
  }, writeOut));

  armed($("#write"), "Click again to write", async () => {
    show(writeOut, ["Writing service history…"]);
    const { results, frames } = await api("/api/write", writeBody());
    logFrames(frames);
    const lines = results.map((r) => `${r.ok ? "OK  " : '<span class="err">FAIL</span>'} ${escapeHtml(r.label)}: ${escapeHtml(r.detail)}`);
    lines.push(results.every((r) => r.ok) ? "Write complete." : '<span class="err">Write stopped at the first failure.</span>');
    show(writeOut, lines);
    for (const r of results) log(`${r.ok ? "OK " : "FAIL"} ${r.label}: ${r.detail}`);
  }, writeOut);

  $("#probe-routines").addEventListener("click", (e) => busy(e.target, async () => {
    const { results, frames } = await api("/api/probe/routines", connection());
    logFrames(frames);
    for (const r of results) log(`${r.label}: ${r.ok ? r.response : r.detail}`);
  }));

  $("#probe-dids").addEventListener("click", (e) => busy(e.target, async () => {
    const body = { ...connection(), ecu: $("#did-ecu-custom").value.trim() || $("#did-ecu").value, session: $("#did-session").value,
                   start: $("#did-start").value, end: $("#did-end").value,
                   known_date: $("#known-date").value, known_km: $("#known-km").value };
    const { id } = await api("/api/probe/dids", body);
    log(`Scanning ECU 0x${body.ecu.toUpperCase()} DIDs ${body.start}–${body.end} in session ${body.session} (read-only)…`);
    const bar = $("#did-progress"), status = $("#did-status"), stop = $("#stop-dids");
    bar.hidden = false; stop.hidden = false;
    stop.onclick = () => api(`/api/probe/dids/${id}/stop`, {});
    let seen = 0, answered = 0, flagged = [];
    for (;;) {
      const s = await api(`/api/probe/dids/${id}?since=${seen}`);
      seen = s.total_hits;
      for (const h of s.hits) {
        if (h.error) { log(`Stopped at ${h.did}: ${h.error}`); continue; }
        answered++;
        const flags = [...h.matches, ...(h.records.length ? [`${h.records.length} record(s)`] : [])];
        if (flags.length) flagged.push(h.did);
        log(`${flags.length ? `MATCH [${flags.join(", ")}] ` : ""}${h.did} (${h.length} B): ${h.data}`);
        for (const r of h.records) log(`    record @${r.offset}: ${r.date} ${r.mileage_km} km, dealer ${r.dealer_number}, ${r.items.length} items`);
      }
      bar.max = s.end - s.start + 1; bar.value = s.current - s.start + 1;
      status.textContent = `0x${s.current.toString(16).toUpperCase().padStart(4, "0")} · ${answered} answered · ${flagged.length} flagged`;
      if (s.done) break;
      await new Promise((r) => setTimeout(r, 700));
    }
    stop.hidden = true;
    log(`Scan of ECU 0x${body.ecu.toUpperCase()} finished: ${answered} DIDs answered${flagged.length ? `, flagged: ${flagged.join(" ")}` : ", none flagged"}.`);
  }));

  const cbsOut = $("#cbs-output");

  $("#read-cbs").addEventListener("click", (e) => busy(e.target, async () => {
    const { items, dme_status } = await api("/api/cbs", connection());
    renderCbs(items);
    show(cbsOut, [`DME CBS status (22 10 01): ${dme_status ?? "not answered"}`]);
    log(`Read ${items.length} CBS items from the instrument cluster. DME status: ${dme_status ?? "not answered"}`);
  }, cbsOut));

  $("#clear-log").addEventListener("click", () => { $("#log").textContent = ""; });
}

init().catch((e) => log(`ERROR: ${e.message}`));
