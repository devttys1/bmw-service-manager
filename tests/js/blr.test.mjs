// Drive Replay's reader for the BLE CAN Logger's .BLR files (static/replay/blr.js), in Node:
//   node --test tests/js/*.test.mjs        (tests/test_replay_site.py runs it under pytest)
// It must read the shared fixture exactly as the iOS app does: the reference log is the app's own
// import of it (ios-app/tools/tests/BlrTests.swift checks the same file), and the logger's
// tools/firmware/blr.py reads the same fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blrToLog, readBlr, crc16, navPvt, obdValue, eventNote, jsonNumber, looksLikeBlr, startInName } from "../../bmw_service_manager/static/replay/blr.js";
import { readLog, parseLog, processLog } from "../../bmw_service_manager/static/replay/drivelog.js";

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const NAME = "LOG_00042_20261111-0805.BLR";
const fixture = new Uint8Array(readFileSync(root(`ios-app/tools/tests/fixtures/${NAME}`)));
const reference = readFileSync(root("ios-app/tools/tests/fixtures/LOG_00042_20261111-0805.bblog"), "utf8");

/** Writes records the way the logger's firmware does (records.c), as BlrTests.swift's BlrWriter. */
function writer() {
  const bytes = [];
  let seq = 0;
  const le = (v, n) => Array.from({ length: n }, (_, i) => Number((BigInt(v) >> BigInt(8 * i)) & 0xffn));
  return {
    bytes,
    record(type, t, payload) {
      const r = [0xa5, type, ...le(payload.length, 2), ...le(seq++, 4), ...le(1_000_000 + Math.round(t * 1e6), 8), ...payload];
      bytes.push(...r, ...le(crc16(Uint8Array.from(r), 1), 2));
    },
    le,
  };
}

test("the shared fixture reads as the iOS app reads it", () => {
  const s = readBlr(fixture);
  assert.deepEqual(s.header, { version: 1, deviceId: [1, 2, 3, 4, 5, 6, 7, 8], fwVersion: 0x00010000, sessionId: 42, wakeReasons: 1, vin: null });
  assert.equal(s.records.length, 3 + 1 + 100 * 2 + 20 * 4 + 1 + 1);
  assert.equal(s.skippedBytes, 6);
  assert.equal(s.missingRecords, 3);
  assert.equal(s.records[0].tUs, 1_000_000n);
});

test("the fixture becomes the same drive log as the iOS app's import of it", () => {
  const { text, vin } = blrToLog(fixture, NAME);
  const ours = text.trim().split("\n").map((l) => JSON.parse(l));
  const theirs = reference.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(vin, "WBA00000SAMPLE001", "the VIN the logger read, from its event");
  assert.ok(!text.includes("SAMPLE001"), "but not in the log: logs get shared");
  assert.equal(ours.length, theirs.length);
  // The header names the app and the car (the app knows it from its garage); the rest must agree.
  const { name, app, car, ...head } = ours[0];
  const { name: n2, app: a2, car: c2, ...head2 } = theirs[0];
  assert.deepEqual(head, head2);
  assert.match(name, /^Drive .* \(logger\)$/);
  assert.deepEqual(ours.slice(1), theirs.slice(1));
});

test("Drive Replay opens the session: a track, car values, notes", async () => {
  const drive = processLog(parseLog(await readLog(new Blob([fixture]), NAME)));
  assert.ok(drive.hasGps);
  assert.ok(drive.duration > 20 && drive.duration < 22);
  for (const name of ["RPM", "Speed", "Coolant", "Throttle", "Battery"]) assert.ok(drive.byName[name], name);
  assert.ok(drive.raw.notes.some((n) => n.text.includes("bad storage block")));
});

test("damage is read around", () => {
  const torn = fixture.slice();
  torn[64 + 20] ^= 0xff; // the first record's payload
  assert.equal(readBlr(torn).records.length, readBlr(fixture).records.length - 1);
  const headless = fixture.slice(64);
  assert.equal(readBlr(headless).header, null);
  assert.equal(readBlr(headless).records.length, readBlr(fixture).records.length);
  assert.ok(looksLikeBlr(headless, "LOG_1.BLR") && !looksLikeBlr(headless, "x.bblog") && looksLikeBlr(fixture));
  assert.throws(() => blrToLog(new TextEncoder().encode("not a log"), "x.BLR"), /isn't a BLE CAN Logger session/);
});

test("the accelerometer's samples go in by time", () => {
  const w = writer();
  const pvt = new Array(92).fill(0);
  Object.assign(pvt, { 4: 0xea, 5: 0x07, 6: 11, 7: 11, 8: 8, 9: 5, 10: 0, 11: 0x07, 20: 3, 21: 1, 23: 9 });
  w.record(1, 0, pvt);
  const samples = [[0, 0, 1000], [100, -50, 990], [200, -100, 980]].flatMap((xyz) => xyz.flatMap((v) => w.le(v & 0xffff, 2)));
  w.record(7, 0.5, [...w.le(100, 2), ...samples]);
  w.record(8, 0.505, w.le(14100, 2));
  const rows = blrToLog(Uint8Array.from(w.bytes), "x.BLR").text.trim().split("\n").map((l) => JSON.parse(l));
  const acc = rows.filter((r) => r.acc);
  assert.deepEqual(acc.map((r) => r.t), [0.5, 0.51, 0.52]);
  assert.deepEqual(acc[1].acc, [0.1, -0.05, 0.99]);
  assert.equal(rows[0].started, "2026-11-11T08:05:00Z");
  // The battery reading (0.505 s) waits for its fifth of a second to fill, so it's written last.
  assert.equal(rows.slice(1).map((r) => (r.acc ? "a" : r.car ? "c" : "")).join(""), "aaac");
});

test("UBX-NAV-PVT, OBD formulas, events, numbers", () => {
  assert.equal(navPvt(new Uint8Array(91)), null, "too short");
  const obd = [[0x0c, [0x1f, 0x40], "RPM", 2000], [0x0d, [88], "Speed", 88], [0x05, [130], "Coolant", 90], [0x0f, [65], "Intake air", 25],
    [0x04, [255], "Load", 100], [0x11, [0], "Throttle", 0], [0x0b, [180], "Manifold", 180], [0x42, [0x37, 0x14], "Battery", 14.1]];
  for (const [pid, d, name, v] of obd) {
    const [n, x] = obdValue(pid, d);
    assert.equal(n, name);
    assert.ok(Math.abs(x - v) < 1e-9, `${name} ${x}`);
  }
  assert.equal(obdValue(0x99, [1]), null);
  assert.equal(obdValue(0x0c, [1]), null);
  assert.equal(eventNote(15, 2345), "GPS first fix after 2.3 s");
  assert.equal(eventNote(16, 100), "GPS at 10 Hz while logging: the module can't do 20 Hz");
  assert.equal(eventNote(14, (3 << 20) | (40 << 8) | 1), "GPS assistance from the phone: 40 frames taken, 3 refused");
  assert.equal(eventNote(5, 0), null);
  assert.equal(eventNote(99, 0), "Logger event 99");
  assert.equal(jsonNumber(-0.0001, 3), "0");
  assert.equal(jsonNumber(149.5501300, 7), "149.55013");
  assert.equal(startInName(NAME).toISOString(), "2026-11-11T08:05:00.000Z");
  assert.equal(startInName("LOG_00042_NOTIME.BLR"), null);
});
