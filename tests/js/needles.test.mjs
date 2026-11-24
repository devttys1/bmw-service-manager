// The video overlay's needle gauges (#62): the dials' scales (static/overlay/needles.js).
//   node --test tests/js/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEEDLE_STYLES, REDLINE, engineOf, niceScale, speedScale, rpmScale, needleFraction, tickLabel, ticksOf } from "../../bmw_service_manager/static/overlay/needles.js";

test("needles: five styles to pick from, Minimal arc first (the default)", () => {
  assert.deepEqual(Object.keys(NEEDLE_STYLES), ["minimal", "classic", "sport", "digital", "vintage"]);
});

test("needles: a speedometer past the top speed, by 20s or 40s", () => {
  assert.deepEqual(speedScale(60), { min: 0, max: 120, step: 20, minor: 10, red: null }, "at least to 120 km/h");
  assert.equal(speedScale(140).max, 160);
  assert.deepEqual(speedScale(183), { min: 0, max: 200, step: 40, minor: 10, red: null });
  assert.equal(speedScale(250).max, 280);
  assert.deepEqual(speedScale(70, true), { min: 0, max: 80, step: 10, minor: 5, red: null }, "mph");
  assert.equal(speedScale(NaN).max, 120, "no speed yet");
});

test("needles: a rev counter red from the engine's red line, 1,000 past it", () => {
  assert.deepEqual(rpmScale(REDLINE.diesel, 4300), { min: 0, max: 6000, step: 1000, minor: 250, red: 5000 });
  assert.deepEqual(rpmScale(REDLINE.petrol, 6500), { min: 0, max: 9000, step: 1000, minor: 500, red: 8000 });
  assert.deepEqual(rpmScale(6500, 0), { min: 0, max: 8000, step: 1000, minor: 250, red: 6500 }, "an engine's own");
  assert.equal(rpmScale(5000, 6400).max, 7000, "a drive revving past the dial stretches it");
  assert.equal(rpmScale(5000, NaN).max, 6000);
});

test("needles: the engine, from the log's car", () => {
  assert.deepEqual(engineOf({ model: "X1 xDrive18d (F48)", chassis: "F48" }), { fuel: "diesel", redline: 5000, said: false });
  assert.deepEqual(engineOf({ model: "M340i xDrive (G20)" }), { fuel: "petrol", redline: 8000, said: false });
  assert.equal(engineOf({ model: "320d" }).fuel, "diesel");
  assert.equal(engineOf({ model: "X5 M50d" }).fuel, "diesel");
  assert.equal(engineOf({ model: "RAV4" }).fuel, "petrol", "nothing said: petrol");
  assert.equal(engineOf({ model: "Car" }, ["RPM", "Soot load"]).fuel, "diesel", "a diesel's channels");
  assert.deepEqual(engineOf({ model: "320d", fuel: "petrol" }), { fuel: "petrol", redline: 8000, said: false }, "the log's fuel wins");
  assert.deepEqual(engineOf({ model: "X1 xDrive18d", redline: 4800 }), { fuel: "diesel", redline: 4800, said: true }, "the log's red line wins");
  assert.deepEqual(engineOf(), { fuel: "petrol", redline: 8000, said: false });
});

test("needles: round numbers for any value", () => {
  assert.deepEqual(niceScale(-0.5, 2, { most: 6 }), { min: -0.5, max: 2, step: 0.5, minor: 0.1, red: null });
  assert.deepEqual(niceScale(0, 113, { most: 6 }), { min: 0, max: 120, step: 20, minor: 5, red: null });
  const oil = niceScale(0, 97.3, { most: 6 });
  assert.equal(oil.max, 100);
  const s = niceScale(-1.13, 1.27, { most: 6 });
  assert.ok(s.min <= -1.13 && s.max >= 1.27 && (s.max - s.min) / s.step <= 6, JSON.stringify(s));
  assert.deepEqual(niceScale(5, 5), niceScale(5, 10), "one value: a dial around it");
});

test("needles: where the needle points, and the figures", () => {
  const sc = speedScale(183);
  assert.equal(needleFraction(sc, 100), 0.5);
  assert.equal(needleFraction(sc, 400), 1, "pinned at the end");
  assert.equal(needleFraction(sc, -5), 0);
  assert.equal(needleFraction(sc, NaN), 0, "no value: at rest");
  assert.equal(tickLabel(-0.5, 0.5), "−0.5");
  assert.equal(tickLabel(0, 0.5), "0.0");
  assert.equal(tickLabel(1.25, 0.25), "1.25");
  assert.equal(tickLabel(40, 20), "40");
  const ticks = ticksOf(sc);
  assert.equal(ticks.length, 21);
  assert.deepEqual(ticks.filter(([, big]) => big).map(([v]) => v), [0, 40, 80, 120, 160, 200]);
});
