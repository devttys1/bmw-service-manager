// Drive Replay's Economy channel (static/replay/drivelog.js), as the iOS Economy gauge (#41):
//   node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { economy } from "../../bmw_service_manager/static/replay/drivelog.js";

test("economy: 6 l/h at 60 km/h is 10 l/100 km, 1 l over 10 km in ten minutes", () => {
  const rate = 25, n = 600 * rate;
  const ch = (v) => ({ values: new Float32Array(n).fill(v) });
  const e = economy(ch(6), ch(60), n, rate);
  assert.ok(Math.abs(e.values[100] - 10) < 1e-6);
  assert.ok(Math.abs(e.litres - 1) < 1e-6 && Math.abs(e.km - 10) < 1e-6);
});

test("economy: blank below 5 km/h, none without the fuel rate", () => {
  const e = economy({ values: Float32Array.of(1, 1) }, { values: Float32Array.of(3, 50) }, 2, 25);
  assert.ok(Number.isNaN(e.values[0]) && Math.abs(e.values[1] - 2) < 1e-6);
  assert.equal(economy(undefined, { values: Float32Array.of(50) }, 1, 25), null);
});
