// The drivetrain for the X-ray view, built from simple solids in the shapes of the real parts:
// the engine with its pistons, rods and crankshaft turning, its turbo spinning on boost; the
// gearbox and its gears; xDrive's power take-off or transfer case, propshafts with their joints,
// the clutch pack, the differentials' ring and pinion, and halfshafts with CV joints and boots.
//
// Two layouts, as BMW builds them:
// - front-drive based (UKL: F48 X1, F39 X2, F45, F40 1 Series), engine across the car. An angle
//   drive at the front differential feeds the propshaft; xDrive's clutch sits ahead of the rear
//   final drive.
// - rear-drive based (CLAR, F15 X5, G-series), an in-line six along the car, an eight-speed
//   with planetary sets behind it, and a transfer case whose clutch and chain drive the front.
//
// Axes are the car's: x forward, y left, z up, metres, origin on the ground between the axles.
// Parts are made along their local y axis and turned into place. They glow by the torque through
// them (`heatColor`), on metal that reads as metal at rest.

import * as THREE from "three";

const UP = new THREE.Vector3(0, 1, 0);
const FINAL_DRIVE = 3.2;

// MARK: shapes, each along local y

/** A solid of revolution around y from [radius, y] pairs. */
function lathe(profile, segments = 32) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** A spur gear around y: `teeth` around radius `r`, `width` thick, an optional hole. */
function gear(teeth, r, width, hole = 0) {
  const h = Math.min(0.012, r * 0.16), ri = r - h, step = (Math.PI * 2) / teeth;
  const s = new THREE.Shape();
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    [[ri, a], [r, a + step * 0.22], [r, a + step * 0.48], [ri, a + step * 0.7]].forEach(([rr, aa], k) => {
      const x = rr * Math.cos(aa), y = rr * Math.sin(aa);
      if (i === 0 && k === 0) s.moveTo(x, y); else s.lineTo(x, y);
    });
  }
  s.closePath();
  if (hole) { const p = new THREE.Path(); p.absarc(0, 0, hole, 0, Math.PI * 2, true); s.holes.push(p); }
  const g = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 3 });
  g.translate(0, 0, -width / 2);
  g.rotateX(-Math.PI / 2); // its axis z → y
  return g;
}

/** A box with rounded edges, centred. */
function roundedBox(sx, sy, sz, r = 0.02) {
  r = Math.min(r, sx / 2.01, sy / 2.01, sz / 2.01);
  const s = new THREE.Shape(), w = sx / 2 - r, h = sy / 2 - r;
  s.moveTo(-w, -h - r); s.lineTo(w, -h - r); s.quadraticCurveTo(w + r, -h - r, w + r, -h);
  s.lineTo(w + r, h); s.quadraticCurveTo(w + r, h + r, w, h + r); s.lineTo(-w, h + r);
  s.quadraticCurveTo(-w - r, h + r, -w - r, h); s.lineTo(-w - r, -h); s.quadraticCurveTo(-w - r, -h - r, -w, -h - r);
  const g = new THREE.ExtrudeGeometry(s, { depth: sz - 2 * r, bevelEnabled: true, bevelThickness: r, bevelSize: r * 0.98, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -(sz - 2 * r) / 2);
  return g;
}

/** A rubber boot: ribs of a CV joint's bellows, `len` long, from radius r0 to r1. */
function boot(len, r0, r1, ribs = 5) {
  const pts = [];
  for (let i = 0; i <= ribs * 4; i++) {
    const f = i / (ribs * 4);
    pts.push([r0 + (r1 - r0) * f + 0.006 * Math.sin(f * ribs * Math.PI * 2), f * len]);
  }
  return lathe(pts, 18);
}

/** A group at `pos` whose local y points along `dir`. */
function mount(parent, pos, dir = UP) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  parent.add(g);
  return g;
}

/** A mesh in `parent` at local y `y` (and x, z), of geometry `geo`. */
function put(parent, geo, mat, y = 0, x = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

// MARK: materials

const metal = (color, rough = 0.42, metalness = 0.85) => new THREE.MeshStandardMaterial({ color, metalness, roughness: rough });
/** A see-through casting, so what turns inside shows. */
const casting = (color = 0xaab3bd, opacity = 0.26) => new THREE.MeshStandardMaterial({
  color, metalness: 0.5, roughness: 0.4, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
});

/** The parts each carry's torque lights: housings faintly, gears and shafts more. */
function family() {
  return { housing: casting(), gear: metal(0xa9b2bb, 0.34), shaft: metal(0x7d858d, 0.36) };
}

// MARK: assemblies

/** A halfshaft from `a` (the differential) to `b` (the hub): joint, boot, shaft, boot, CV bell. */
function halfshaft(parent, a, b, mats, spinners, rate) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const g = mount(parent, a, dir), spin = new THREE.Group();
  g.add(spin);
  put(spin, lathe([[0.001, 0], [0.042, 0.005], [0.046, 0.03], [0.044, 0.07], [0.03, 0.085], [0.001, 0.09]]), mats.shaft, 0);
  put(spin, boot(0.1, 0.034, 0.018), mats.rubber, 0.08);
  put(spin, new THREE.CylinderGeometry(0.014, 0.014, len - 0.32, 10), mats.shaft, len / 2);
  const outer = put(spin, boot(0.1, 0.034, 0.018), mats.rubber, len - 0.1);
  outer.rotation.x = Math.PI; outer.position.y = len - 0.08;
  put(spin, lathe([[0.001, 0], [0.025, 0.004], [0.05, 0.03], [0.052, 0.055], [0.04, 0.08], [0.001, 0.085]]), mats.shaft, len - 0.08);
  spinners.push({ spin, rate });
}

/** A propshaft from `a` to `b`: flex disc at the front, a centre bearing, universal joints. */
function propshaft(parent, a, b, mats, spinners, rate) {
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  const g = mount(parent, a, dir), spin = new THREE.Group();
  g.add(spin);
  put(spin, new THREE.CylinderGeometry(0.05, 0.05, 0.022, 20), mats.rubber, 0.012); // flex disc
  for (let k = 0; k < 3; k++) {
    const bolt = put(spin, new THREE.CylinderGeometry(0.007, 0.007, 0.03, 6), mats.gear, 0.012);
    const a2 = (k / 3) * Math.PI * 2; bolt.position.x = Math.cos(a2) * 0.035; bolt.position.z = Math.sin(a2) * 0.035;
  }
  const half = len / 2;
  put(spin, lathe([[0.03, 0.025], [0.034, 0.05], [0.034, half - 0.05], [0.025, half - 0.02]], 16), mats.shaft, 0);
  put(spin, lathe([[0.025, half + 0.04], [0.036, half + 0.08], [0.036, len - 0.06], [0.028, len - 0.03]], 16), mats.shaft, 0);
  // Universal joints: two yokes at right angles and the cross between.
  for (const y of [half + 0.01, len - 0.02]) {
    for (const turn of [0, Math.PI / 2]) {
      const yoke = new THREE.Group(); yoke.position.y = y; yoke.rotation.y = turn; spin.add(yoke);
      for (const s of [1, -1]) put(yoke, new THREE.BoxGeometry(0.012, 0.045, 0.02), mats.gear, turn ? 0.012 : -0.012, s * 0.028);
    }
    put(spin, new THREE.BoxGeometry(0.07, 0.01, 0.01), mats.gear, y);
    put(spin, new THREE.BoxGeometry(0.01, 0.01, 0.07), mats.gear, y);
  }
  // The centre bearing doesn't turn: a rubber ring in a bracket.
  put(g, new THREE.TorusGeometry(0.048, 0.014, 8, 20).rotateX(Math.PI / 2), mats.rubber, half + 0.01);
  put(g, new THREE.BoxGeometry(0.2, 0.03, 0.02), mats.bracket, half + 0.01, 0, 0.06);
  spinners.push({ spin, rate });
}

/** A differential: housing, its pinion's nose towards `noseDir`, ring gear and carrier inside. */
function differential(parent, centre, noseDir, mats, spinners, axleRate, size = 1) {
  const s = size;
  const housing = mount(parent, centre, UP); // its axis across the car
  put(housing, lathe([[0.05 * s, -0.17 * s], [0.07 * s, -0.15 * s], [0.13 * s, -0.11 * s], [0.155 * s, -0.04 * s],
    [0.15 * s, 0.05 * s], [0.11 * s, 0.1 * s], [0.06 * s, 0.13 * s], [0.05 * s, 0.17 * s]]), mats.housing);
  for (const y of [-0.13 * s, 0.11 * s]) put(housing, new THREE.TorusGeometry(0.085 * s, 0.008, 6, 24).rotateX(Math.PI / 2), mats.housing, y);
  // Ring gear and carrier turn with the axle; the spider gears inside the carrier.
  const ring = new THREE.Group(); housing.add(ring);
  put(ring, gear(41, 0.105 * s, 0.026 * s, 0.07 * s), mats.gear, -0.03 * s);
  put(ring, lathe([[0.02, -0.1 * s], [0.06 * s, -0.06 * s], [0.065 * s, 0.03 * s], [0.03, 0.07 * s]], 20), mats.shaft);
  for (const k of [0, 1]) {
    const spider = put(ring, new THREE.ConeGeometry(0.022 * s, 0.03 * s, 12), mats.gear, 0, 0, (k ? 1 : -1) * 0.032 * s);
    spider.rotation.x = k ? Math.PI / 2 : -Math.PI / 2;
  }
  spinners.push({ spin: ring, rate: axleRate });
  // The pinion's nose and the pinion, turning FINAL_DRIVE times faster.
  const nose = mount(parent, centre.clone().addScaledVector(noseDir, 0.06 * s).setY(centre.y - 0.03 * s), noseDir);
  put(nose, lathe([[0.085 * s, 0], [0.08 * s, 0.06 * s], [0.06 * s, 0.13 * s], [0.045 * s, 0.17 * s], [0.05 * s, 0.18 * s], [0.03, 0.19 * s]]), mats.housing);
  const pinion = new THREE.Group(); nose.add(pinion);
  put(pinion, gear(11, 0.034 * s, 0.03 * s), mats.gear, 0.01 * s);
  put(pinion, new THREE.CylinderGeometry(0.016, 0.016, 0.17 * s, 10), mats.shaft, 0.09 * s);
  spinners.push({ spin: pinion, rate: () => axleRate() * FINAL_DRIVE });
  return { housing, top: centre.clone().add(new THREE.Vector3(0, 0, 0.2 * s)) };
}

/** xDrive's multi-plate clutch along `dir`: a drum, plates in turn on its input and output. */
function clutchPack(parent, centre, dir, mats, spinners, inRate, outRate, { r = 0.1, len = 0.24 } = {}) {
  const g = mount(parent, centre, dir);
  put(g, lathe([[r * 0.45, -len / 2], [r, -len / 2 + 0.02], [r * 1.04, 0], [r, len / 2 - 0.02], [r * 0.45, len / 2]]), mats.housing);
  for (let k = -2; k <= 2; k++) put(g, new THREE.TorusGeometry(r * 1.02, 0.005, 4, 24).rotateX(Math.PI / 2), mats.housing, k * len / 6);
  const inner = new THREE.Group(), outer = new THREE.Group();
  g.add(inner, outer);
  const plates = [];
  for (let k = 0; k < 11; k++) {
    const steel = k % 2 === 1;
    const p = put(steel ? outer : inner, steel ? gear(28, r * 0.86, 0.008, r * 0.45) : gear(20, r * 0.78, 0.01, r * 0.3), steel ? mats.plate : mats.friction);
    plates.push(p);
  }
  put(inner, new THREE.CylinderGeometry(0.018, 0.018, len, 10), mats.shaft);
  spinners.push({ spin: inner, rate: inRate }, { spin: outer, rate: outRate });
  return { group: g, plates, len };
}

/**
 * An in-line engine, `n` cylinders, built along local y (the crank), up z, intake on +x and
 * exhaust and turbo on −x; the pulleys at −y and the flywheel at +y. Returns its group and an
 * update for the crank angle and the turbo's.
 */
function engine(n, mats) {
  const g = new THREE.Group();
  const pitch = 0.092, L = n * pitch, ys = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * pitch);
  const r = 0.045, rod = 0.145;
  // The castings: block, head, sump; the cam cover on top.
  put(g, roundedBox(0.3, L + 0.07, 0.32, 0.03), mats.block).position.set(0, 0, 0.1);
  put(g, roundedBox(0.28, L + 0.05, 0.12, 0.025), mats.block).position.set(0, 0, 0.32);
  put(g, roundedBox(0.26, L - 0.02, 0.14, 0.04), mats.block).position.set(0.01, 0, -0.13);
  const cover = put(g, roundedBox(0.2, L - 0.01, 0.07, 0.03), mats.cover);
  cover.position.set(0.02, 0, 0.41);
  for (const y of ys) { const rib = put(g, new THREE.BoxGeometry(0.16, 0.012, 0.012), mats.cover, y + pitch / 2); rib.position.set(0.02, y + pitch / 2, 0.45); }
  // Bores, pistons and rods; the crankshaft with a counterweight to each throw.
  const phases = n === 6 ? [0, 4, 2, 2, 4, 0].map((k) => (k * Math.PI) / 3) : [0, Math.PI, Math.PI, 0];
  const pistons = [];
  for (let i = 0; i < n; i++) {
    put(g, new THREE.CylinderGeometry(0.043, 0.043, 0.2, 18, 1, true).rotateX(Math.PI / 2), mats.bore, ys[i], 0, 0.16);
    const piston = put(g, new THREE.CylinderGeometry(0.041, 0.041, 0.06, 18).rotateX(Math.PI / 2), mats.piston, ys[i]);
    const conrod = put(g, new THREE.BoxGeometry(0.016, 0.014, 1), mats.internal, ys[i]);
    pistons.push({ piston, conrod, phase: phases[i], y: ys[i] });
  }
  const crank = new THREE.Group(); g.add(crank);
  put(crank, new THREE.CylinderGeometry(0.02, 0.02, L + 0.12, 10), mats.internal);
  for (let i = 0; i < n; i++) {
    for (const off of [-0.025, 0.025]) {
      put(crank, new THREE.CylinderGeometry(0.075, 0.075, 0.016, 16, 1, false, phases[i] + Math.PI / 2, Math.PI), mats.internal, ys[i] + off);
    }
    const pin = put(crank, new THREE.CylinderGeometry(0.018, 0.018, 0.05, 10), mats.internal, ys[i]);
    pin.position.x = r * Math.sin(phases[i]); pin.position.z = r * Math.cos(phases[i]);
  }
  // Flywheel and its starter ring at +y; the pulleys at −y.
  put(crank, gear(96, 0.15, 0.02, 0.03), mats.internal, L / 2 + 0.07);
  put(crank, lathe([[0.02, 0], [0.08, 0.002], [0.082, 0.012], [0.072, 0.016], [0.082, 0.02], [0.08, 0.03], [0.02, 0.032]], 24), mats.internal, -L / 2 - 0.08);
  put(g, new THREE.CylinderGeometry(0.055, 0.055, 0.1, 16), mats.cover, -L / 2 + 0.04, 0.16, 0.02);
  put(g, new THREE.CylinderGeometry(0.03, 0.03, 0.03, 14), mats.internal, -L / 2 - 0.07, 0.16, 0.02);
  // Intake: a plenum along the +x side, a runner to each port.
  put(g, roundedBox(0.09, L * 0.92, 0.1, 0.03), mats.cover).position.set(0.27, 0, 0.17);
  for (const y of ys) {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.27, y, 0.21), new THREE.Vector3(0.29, y, 0.33), new THREE.Vector3(0.14, y, 0.31));
    put(g, new THREE.TubeGeometry(curve, 10, 0.02, 8), mats.cover);
  }
  // Exhaust: a short stub from each port into one collector along the head, down to the turbo.
  const turboY = -L * 0.12;
  for (const y of ys) put(g, new THREE.CylinderGeometry(0.019, 0.019, 0.09, 10).rotateZ(Math.PI / 2), mats.exhaust, y, -0.18, 0.29);
  put(g, new THREE.CylinderGeometry(0.03, 0.03, L - 0.02, 14), mats.exhaust, 0, -0.235, 0.27);
  const drop = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-0.235, turboY + 0.05, 0.27), new THREE.Vector3(-0.29, turboY + 0.05, 0.27), new THREE.Vector3(-0.3, turboY + 0.05, 0.16));
  put(g, new THREE.TubeGeometry(drop, 10, 0.028, 10), mats.exhaust);
  // The turbo: turbine and compressor housings on one shaft, the compressor wheel inside.
  const turbo = mount(g, new THREE.Vector3(-0.3, turboY, 0.1), UP);
  put(turbo, new THREE.TorusGeometry(0.05, 0.03, 10, 20).rotateX(Math.PI / 2), mats.exhaust, 0.05);
  put(turbo, new THREE.CylinderGeometry(0.028, 0.028, 0.08, 12), mats.internal, -0.01);
  put(turbo, new THREE.TorusGeometry(0.058, 0.032, 10, 22).rotateX(Math.PI / 2), mats.turboCold, -0.07);
  put(turbo, lathe([[0.04, -0.09], [0.042, -0.15], [0.05, -0.2]], 18), mats.turboCold);
  const wheel = new THREE.Group(); wheel.position.y = -0.08; turbo.add(wheel);
  put(wheel, new THREE.ConeGeometry(0.018, 0.05, 12).rotateX(Math.PI), mats.internal, -0.01);
  for (let k = 0; k < 10; k++) {
    const blade = put(wheel, new THREE.BoxGeometry(0.003, 0.04, 0.03), k % 2 ? mats.internal : mats.blade, -0.01);
    const a = (k / 10) * Math.PI * 2;
    blade.position.x = Math.cos(a) * 0.022; blade.position.z = Math.sin(a) * 0.022;
    blade.rotation.y = -a; blade.rotation.z = 0.5;
  }
  put(turbo, new THREE.CylinderGeometry(0.028, 0.03, 0.22, 12), mats.exhaust, 0.05, 0, -0.14).rotation.x = 0.15; // downpipe

  const pinPos = new THREE.Vector3();
  function update(theta, turboAngle) {
    crank.rotation.y = theta;
    for (const p of pistons) {
      const a = theta + p.phase;
      pinPos.set(r * Math.sin(a), p.y, r * Math.cos(a));
      const pinZ = r * Math.cos(a) + Math.sqrt(rod * rod - (r * Math.sin(a)) ** 2);
      p.piston.position.set(0, p.y, pinZ + 0.02);
      // The rod from the crank pin to the piston's pin.
      const dx = -pinPos.x, dz = pinZ - pinPos.z;
      p.conrod.position.set(pinPos.x + dx / 2, p.y, pinPos.z + dz / 2);
      p.conrod.scale.z = Math.hypot(dx, dz);
      p.conrod.rotation.y = Math.atan2(dx, dz);
    }
    wheel.rotation.y = turboAngle;
  }
  return { group: g, update, length: L };
}

/** Planetary gear sets along local y, as in the eight-speed: ring, sun, three planets each. */
function planetarySets(parent, positions, mats, spinners, rate) {
  for (const [k, y] of positions.entries()) {
    const set = new THREE.Group(); set.position.y = y; parent.add(set);
    put(set, new THREE.TorusGeometry(0.1, 0.012, 6, 32).rotateX(Math.PI / 2), mats.gear);
    put(set, gear(18, 0.035, 0.03), mats.gear);
    const carrier = new THREE.Group(); set.add(carrier);
    for (let p = 0; p < 3; p++) {
      const a = (p / 3) * Math.PI * 2;
      put(carrier, gear(14, 0.03, 0.028), mats.gear, 0, Math.cos(a) * 0.066, Math.sin(a) * 0.066);
    }
    spinners.push({ spin: set, rate: () => rate() * (1 - k * 0.15) }, { spin: carrier, rate: () => -rate() * 0.4 });
  }
}

// MARK: the car's drivetrain

/**
 * driven: "front" or "rear", the axle that always drives (front means the engine across the car);
 * xdrive: "rear", "front" or "none". front, rear, track, wheelR: the car's axles (x), track and
 * wheel radius. Returns { group, update(state, dt), anchors, axles: {primary, secondary} }.
 */
export function buildDrivetrain({ driven = "front", xdrive = "rear", front, rear, track, wheelR }) {
  const group = new THREE.Group();
  const spinners = [];
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.85 });
  const bracket = metal(0x30353b, 0.6, 0.5);
  const primary = { ...family(), rubber, bracket, plate: metal(0xb7c0c8, 0.3), friction: metal(0x3a2f28, 0.8, 0.2) };
  const secondary = { ...family(), rubber, bracket, plate: metal(0xb7c0c8, 0.3), friction: metal(0x3a2f28, 0.8, 0.2) };
  const eng = {
    block: casting(0xb5bcc4, 0.22), cover: new THREE.MeshStandardMaterial({ color: 0x1d2126, roughness: 0.55, metalness: 0.2, transparent: true, opacity: 0.55, depthWrite: false }),
    bore: casting(0xd0d6dc, 0.12), piston: metal(0xd9dee3, 0.3), internal: metal(0x9aa2aa, 0.32),
    exhaust: metal(0x4a4643, 0.6, 0.7), turboCold: casting(0xc8ced4, 0.5), blade: metal(0x6cb4ff, 0.3, 0.6),
  };
  const hasXDrive = xdrive === "rear" || xdrive === "front";
  const primaryAxle = driven === "rear" ? rear : front, otherAxle = driven === "rear" ? front : rear;
  const hub = (x, side) => new THREE.Vector3(x, side * (track / 2 - 0.09), wheelR);

  // Speeds (rad/s), set each update from the wheels and the engine.
  const w = { front: 0, rear: 0, crank: 0, turbo: 0 };
  const axleRate = (x) => () => (x === front ? w.front : w.rear);

  let eng6, clutch = null, primaryDiff, otherDiff = null;
  if (driven === "front") {
    // Across the car: crank along y, engine on the right, gearbox on the left, intake forward.
    eng6 = engine(4, eng);
    const crankAt = new THREE.Vector3(front + 0.2, -0.14, 0.44);
    eng6.group.position.copy(crankAt);
    eng6.group.rotation.y = -0.15; // leaning back towards the bulkhead
    group.add(eng6.group);
    const gy = crankAt.y + eng6.length / 2 + 0.1;
    const box = mount(group, new THREE.Vector3(crankAt.x, gy, crankAt.z), UP);
    put(box, lathe([[0.2, 0], [0.205, 0.04], [0.18, 0.1], [0.16, 0.13]]), primary.housing);
    const caseAt = new THREE.Vector3(front + 0.1, gy + 0.27, 0.43);
    put(group, roundedBox(0.44, 0.28, 0.4, 0.06), primary.housing).position.copy(caseAt);
    // Gears on the input shaft, turning with the engine; the output gear to the differential.
    const input = mount(group, new THREE.Vector3(crankAt.x, gy + 0.2, crankAt.z), UP);
    const inSpin = new THREE.Group(); input.add(inSpin);
    [[0.085, 0], [0.065, 0.06], [0.075, 0.12], [0.05, 0.18]].forEach(([r, y]) => put(inSpin, gear(Math.round(r * 400), r, 0.026), primary.gear, y));
    spinners.push({ spin: inSpin, rate: () => w.crank * 0.35 });
    primaryDiff = differential(group, new THREE.Vector3(front, gy + 0.36, wheelR), new THREE.Vector3(1, 0, 0), primary, spinners, axleRate(front), 0.85);
    halfshaft(group, new THREE.Vector3(front, gy + 0.5, wheelR), hub(front, 1), primary, spinners, axleRate(front));
    // The right side: an intermediate shaft under the engine, then its halfshaft.
    const midEnd = new THREE.Vector3(front, -0.32, wheelR);
    const mid = mount(group, new THREE.Vector3(front, gy + 0.2, wheelR), new THREE.Vector3(0, -1, 0));
    const midSpin = new THREE.Group(); mid.add(midSpin);
    put(midSpin, new THREE.CylinderGeometry(0.018, 0.018, gy + 0.2 - midEnd.y, 10), primary.shaft, (gy + 0.2 - midEnd.y) / 2);
    spinners.push({ spin: midSpin, rate: () => -w.front });
    halfshaft(group, midEnd, hub(front, -1), primary, spinners, axleRate(front));
    if (hasXDrive) {
      // The angle drive on the differential, turning the propshaft.
      const ptoAt = new THREE.Vector3(front, 0.08, wheelR);
      const pto = mount(group, ptoAt, UP);
      put(pto, lathe([[0.04, -0.07], [0.09, -0.05], [0.095, 0.04], [0.05, 0.07]]), secondary.housing);
      const ptoRing = new THREE.Group(); pto.add(ptoRing);
      put(ptoRing, gear(30, 0.075, 0.02, 0.03), secondary.gear, 0.02);
      spinners.push({ spin: ptoRing, rate: axleRate(front) });
      const nose = mount(group, ptoAt.clone().add(new THREE.Vector3(-0.05, 0, 0)), new THREE.Vector3(-1, 0, 0));
      put(nose, lathe([[0.065, 0], [0.055, 0.08], [0.04, 0.14], [0.03, 0.16]]), secondary.housing);
      const ptoPinion = new THREE.Group(); nose.add(ptoPinion);
      put(ptoPinion, gear(12, 0.032, 0.026), secondary.gear, 0.03);
      const propRate = () => w.front * FINAL_DRIVE;
      spinners.push({ spin: ptoPinion, rate: propRate });
      // Propshaft to xDrive's clutch, then the rear final drive behind it.
      const clutchAt = new THREE.Vector3(rear + 0.33, 0, wheelR + 0.02);
      propshaft(group, ptoAt.clone().add(new THREE.Vector3(-0.21, -0.02, 0)), clutchAt.clone().add(new THREE.Vector3(0.13, 0, 0)), secondary, spinners, propRate);
      clutch = clutchPack(group, clutchAt, new THREE.Vector3(-1, 0, 0), secondary, spinners, propRate, () => w.rear * FINAL_DRIVE);
      // Its electric actuator and pump on the side.
      put(group, new THREE.CylinderGeometry(0.038, 0.038, 0.12, 14), secondary.housing).position.set(rear + 0.33, -0.14, wheelR + 0.07);
      otherDiff = differential(group, new THREE.Vector3(rear, 0, wheelR), new THREE.Vector3(1, 0, 0), secondary, spinners, axleRate(rear));
      for (const side of [1, -1]) halfshaft(group, new THREE.Vector3(rear, side * 0.16, wheelR), hub(rear, side), secondary, spinners, axleRate(rear));
    }
  } else {
    // Along the car: an in-line six, the eight-speed behind it, then the transfer case.
    eng6 = engine(6, eng);
    const crankAt = new THREE.Vector3(front - 0.06, 0, 0.56);
    eng6.group.position.copy(crankAt);
    eng6.group.rotation.z = Math.PI / 2; // crank along x: flywheel to the rear, intake to the left
    group.add(eng6.group);
    const flywheelX = crankAt.x - eng6.length / 2 - 0.1;
    const box = mount(group, new THREE.Vector3(flywheelX, 0, crankAt.z), new THREE.Vector3(-1, 0, 0));
    put(box, lathe([[0.215, 0], [0.22, 0.05], [0.19, 0.14], [0.165, 0.18], [0.16, 0.5], [0.13, 0.7], [0.1, 0.78], [0.06, 0.8]]), primary.housing);
    planetarySets(box, [0.25, 0.37, 0.49, 0.61], primary, spinners, () => w.crank * 0.35);
    const endX = flywheelX - 0.8;
    const rearRate = () => w.rear * FINAL_DRIVE;
    let rearPropFrom = new THREE.Vector3(endX, 0, crankAt.z);
    if (hasXDrive) {
      // Transfer case: the clutch on the main shaft, a chain down and left to the front propshaft.
      const tc = new THREE.Vector3(endX - 0.15, 0.05, crankAt.z - 0.08);
      put(group, roundedBox(0.3, 0.32, 0.4, 0.05), secondary.housing).position.copy(tc);
      clutch = clutchPack(group, new THREE.Vector3(endX - 0.1, 0, crankAt.z), new THREE.Vector3(-1, 0, 0), secondary, spinners, rearRate, () => w.front * FINAL_DRIVE, { r: 0.085, len: 0.16 });
      const sprocketMain = new THREE.Vector3(endX - 0.22, 0, crankAt.z), sprocketFront = new THREE.Vector3(endX - 0.22, 0.15, crankAt.z - 0.2);
      for (const [at, rate] of [[sprocketMain, rearRate], [sprocketFront, () => w.front * FINAL_DRIVE]]) {
        const m = mount(group, at, new THREE.Vector3(1, 0, 0)), s = new THREE.Group(); m.add(s);
        put(s, gear(24, 0.07, 0.03), secondary.gear);
        spinners.push({ spin: s, rate });
      }
      const chainPath = new THREE.CatmullRomCurve3([
        sprocketMain.clone().add(new THREE.Vector3(0, -0.07, 0.02)), sprocketMain.clone().add(new THREE.Vector3(0, 0, 0.075)),
        sprocketMain.clone().add(new THREE.Vector3(0, 0.07, 0.01)), sprocketFront.clone().add(new THREE.Vector3(0, 0.075, 0)),
        sprocketFront.clone().add(new THREE.Vector3(0, 0, -0.075)), sprocketFront.clone().add(new THREE.Vector3(0, -0.07, 0)),
      ], true);
      put(group, new THREE.TubeGeometry(chainPath, 64, 0.008, 6, true), secondary.gear);
      const frontDiffAt = new THREE.Vector3(front, 0.14, wheelR);
      propshaft(group, sprocketFront.clone().add(new THREE.Vector3(0.03, 0, 0)), frontDiffAt.clone().add(new THREE.Vector3(-0.21, 0, -0.03)), secondary, spinners, () => -w.front * FINAL_DRIVE);
      otherDiff = differential(group, frontDiffAt, new THREE.Vector3(-1, 0, 0), secondary, spinners, axleRate(front), 0.85);
      halfshaft(group, frontDiffAt.clone().add(new THREE.Vector3(0, 0.13, 0)), hub(front, 1), secondary, spinners, axleRate(front));
      halfshaft(group, frontDiffAt.clone().add(new THREE.Vector3(0, -0.13, 0)), hub(front, -1), secondary, spinners, axleRate(front));
      rearPropFrom = new THREE.Vector3(endX - 0.3, 0, crankAt.z);
    }
    const rearDiffAt = new THREE.Vector3(rear, 0, wheelR);
    propshaft(group, rearPropFrom, rearDiffAt.clone().add(new THREE.Vector3(0.24, 0, 0.0)), primary, spinners, rearRate);
    primaryDiff = differential(group, rearDiffAt, new THREE.Vector3(1, 0, 0), primary, spinners, axleRate(rear));
    for (const side of [1, -1]) halfshaft(group, new THREE.Vector3(rear, side * 0.16, wheelR), hub(rear, side), primary, spinners, axleRate(rear));
  }

  // Speeds on screen: the real ratios, but slowed past a few turns a second, or they'd strobe.
  const calm = (x, top) => (x === 0 ? 0 : (top * Math.tanh(x / top)) / x);
  let theta = 0, turboAngle = 0;
  const tmp = new THREE.Color();
  const glowFamily = (mats, f) => {
    heatColor(f, tmp);
    mats.housing.emissive.copy(tmp).multiplyScalar(0.12 * f);
    mats.gear.emissive.copy(tmp).multiplyScalar(0.04 + 0.42 * f);
    mats.shaft.emissive.copy(tmp).multiplyScalar(0.03 + 0.32 * f);
  };

  /** state: wheels [FL, FR, RL, RR] and speed km/h, rpm, boost (bar), engine and secondary (Nm). */
  function update(state, dt) {
    const kmh = (i) => state.wheels?.[i] ?? state.speed ?? 0;
    w.front = ((kmh(0) + kmh(1)) / 2) / 3.6 / wheelR;
    w.rear = ((kmh(2) + kmh(3)) / 2) / 3.6 / wheelR;
    const k = calm(Math.max(w.front, w.rear) * FINAL_DRIVE, 14);
    for (const s of spinners) s.spin.rotation.y += s.rate() * k * dt;
    w.crank = Number.isFinite(state.rpm) ? state.rpm / 60 * Math.PI * 2 : 0;
    theta += w.crank * calm(w.crank, 9) * dt;
    const boost = Number.isFinite(state.boost) ? (state.boost > 0.8 ? state.boost - 1 : state.boost) : 0;
    turboAngle += (2 + 26 * Math.min(1, Math.max(0, boost / 1.2))) * dt;
    eng6.update(theta, turboAngle);
    if (clutch) {
      // Packed tight when the clutch closes, spread when open.
      const f = Math.min(1, Math.max(0, state.secondary || 0) / 1000 * 2.2);
      const gap = 0.011 + 0.012 * (1 - f);
      clutch.plates.forEach((p, i) => { p.position.y = (i - (clutch.plates.length - 1) / 2) * gap; });
    }
    const engineF = Math.max(0, state.engine || 0) / 380, secondF = Math.max(0, state.secondary || 0) / 1000;
    glowFamily(primary, engineF);
    glowFamily(secondary, secondF);
    heatColor(engineF, tmp);
    eng.piston.emissive.copy(tmp).multiplyScalar(0.25 * engineF);
    eng.internal.emissive.copy(tmp).multiplyScalar(0.16 * engineF);
    eng.exhaust.emissive.setRGB(0.9, 0.22, 0.04).multiplyScalar(0.02 + 0.3 * engineF);
  }

  const anchors = {
    engine: eng6.group.position.clone().add(new THREE.Vector3(0, 0, 0.42)),
    primary: primaryDiff.top,
    secondary: clutch ? clutch.group.position.clone().add(new THREE.Vector3(0, 0, 0.18)) : null,
  };
  return { group, update, anchors, hasXDrive, axles: { primary: primaryAxle, secondary: otherAxle } };
}

/** Torque 0...1 as a colour: cool blue, through amber, to hot red. */
export function heatColor(f, target = new THREE.Color()) {
  const k = Math.min(1, Math.max(0, f));
  const stops = [[0, [0.18, 0.32, 0.55]], [0.35, [0.1, 0.65, 0.95]], [0.65, [1.0, 0.62, 0.1]], [1, [1.0, 0.15, 0.08]]];
  for (let i = 1; i < stops.length; i++) {
    if (k <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i];
      const s = (k - a) / (b - a);
      return target.setRGB(ca[0] + (cb[0] - ca[0]) * s, ca[1] + (cb[1] - ca[1]) * s, ca[2] + (cb[2] - ca[2]) * s);
    }
  }
  return target.setRGB(...stops.at(-1)[1]);
}
