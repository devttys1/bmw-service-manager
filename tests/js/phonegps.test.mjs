// Drive Replay with the iPhone's track in a logger session (#60): the iOS app's import marks each fix
// "logger" or "phone" (src) and says so in the header (gps). node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLog, processLog } from "../../bmw_service_manager/static/replay/drivelog.js";

const header = (gps) => JSON.stringify({
  format: "boostbook-drive", version: 1, name: "Drive (logger)", started: "2026-11-24T02:03:32Z", app: "test", simulated: false,
  car: { name: "", model: "" }, mount: { preset: "upright" }, accel: "car",
  fields: { gps: ["lat", "lon", "alt", "hacc", "vacc", "speed", "sacc", "course", "cacc"] },
  source: { device: "ble-can-logger", file: "LOG_00016_20261124-0203.BLR", session: 16 }, gps,
});
const fix = (t, src, hacc, v = 15) => JSON.stringify({ t, gps: [-33.44 + t * v / 111195, 149.55, 850, hacc, 4, v, 0.5, 0, 3], src });

test("a logger session with no fix plays on the iPhone's track", () => {
  const lines = [header({ from: "phone", note: "GPS from this iPhone: the logger had no fix" }),
    JSON.stringify({ t: 1, note: "GPS from this iPhone: the logger had no fix" })];
  for (let t = 1; t <= 60; t++) lines.push(fix(t, "phone", 5));
  const raw = parseLog(lines.join("\n") + "\n");
  assert.equal(raw.gps.length, 60);
  assert.ok(raw.gps.every((g) => g[10] === "phone"), "each fix keeps its source");
  const drive = processLog(raw);
  assert.ok(drive.hasGps, "a map to replay on");
  assert.ok(Math.abs(drive.dist[drive.n - 1] - 59 * 15) < 30, `distance ${drive.dist[drive.n - 1]} m (885 m)`);
  assert.equal(drive.header.gps.note, "GPS from this iPhone: the logger had no fix");
});

test("both: the logger's fixes keep their times, in order with the iPhone's", () => {
  const lines = [header({ from: "logger+phone", note: "GPS from the logger and this iPhone" })];
  for (let i = 0; i < 300; i++) lines.push(fix(0.5 + i / 10, "logger", 1.5));
  for (let t = 30.3; t < 61; t += 1) lines.push(fix(+t.toFixed(1), "phone", 6));
  const drive = processLog(parseLog(lines.join("\n") + "\n"));
  assert.ok(drive.hasGps);
  assert.equal(drive.raw.gps.filter((g) => g[10] === "logger").length, 300);
  assert.ok(Math.abs(drive.dist[drive.n - 1] - 60 * 15) < 40, `distance ${drive.dist[drive.n - 1]} m through the switch (900 m)`);
});
