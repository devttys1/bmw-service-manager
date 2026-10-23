// The car in 3D, for the map and the close-up: an X1-sized SUV (F48: 4.44 m long, 2.67 m
// wheelbase) built from simple shapes, with its drivetrain inside for the X-ray view.
//
// Axes are the car's (ISO 8855): x forward, y left, z up, metres, the origin on the ground
// halfway between the axles. `update(state)` turns the wheels at their own speeds, steers the
// front ones, and lights the drivetrain by the torque through it: the engine and the axle it
// always drives, and xDrive's clutch, propshaft and the other axle.

import * as THREE from "three";

export const WHEELBASE = 2.67;
const TRACK = 1.56;
const WHEEL_R = 0.345;
const WHEEL_W = 0.225;
const FRONT = WHEELBASE / 2, REAR = -WHEELBASE / 2;

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

/** Stripes around a shaft, so it can be seen turning. */
function stripes(color) {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 8;
  const g = c.getContext("2d");
  g.fillStyle = color; g.fillRect(0, 0, 64, 8);
  g.fillStyle = "rgba(0,0,0,0.45)";
  for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 6, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The body's side view (x forward, z up), wheel arches cut out, as a 2D shape. */
function bodyProfile() {
  const s = new THREE.Shape();
  const arch = 0.41, archZ = WHEEL_R;
  s.moveTo(2.12, 0.24);
  s.lineTo(2.19, 0.42);            // front bumper
  s.lineTo(2.18, 0.66);
  s.quadraticCurveTo(2.15, 0.78, 1.95, 0.82); // nose into the bonnet
  s.lineTo(0.92, 0.99);            // bonnet to the windscreen's foot
  s.lineTo(0.12, 1.52);            // windscreen
  s.quadraticCurveTo(0.0, 1.58, -0.2, 1.58);
  s.lineTo(-1.62, 1.56);           // roof
  s.quadraticCurveTo(-1.95, 1.55, -2.1, 1.32); // rear window and spoiler
  s.lineTo(-2.24, 1.0);            // tailgate
  s.lineTo(-2.26, 0.46);           // rear bumper
  s.lineTo(-2.2, 0.26);
  s.lineTo(REAR - arch - 0.06, 0.26);
  s.absarc(REAR, archZ, arch, Math.PI, 0, true); // rear arch, over the wheel
  s.lineTo(FRONT - arch, 0.22);    // sill
  s.absarc(FRONT, archZ, arch, Math.PI, 0, true);
  s.lineTo(2.12, 0.24);
  return s;
}

/** A side window band (x forward, z up). */
function windowProfile() {
  const s = new THREE.Shape();
  s.moveTo(0.78, 1.05);
  s.lineTo(0.1, 1.47);
  s.lineTo(-1.6, 1.47);
  s.lineTo(-1.98, 1.1);
  s.lineTo(-1.95, 1.05);
  s.lineTo(0.78, 1.05);
  return s;
}

/** A shape in the x–z plane extruded across y, `width` wide, centred. */
function extrudeAcross(shape, width, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, width - 2 * bevel), bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8,
    bevelSegments: 3, curveSegments: 18,
  });
  geo.rotateX(Math.PI / 2);                 // shape's y → z; extrusion → −y
  geo.translate(0, width / 2 - bevel, 0);    // centred on y = 0
  return geo;
}

function cylinderBetween(a, b, r, material, segments = 16) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const geo = new THREE.CylinderGeometry(r, r, dir.length(), segments, 1);
  const m = new THREE.Mesh(geo, material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return m;
}

/** An arrow along +x, length 1, for scaling by torque. */
function arrow(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, transparent: true, opacity: 0.9 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 10), mat);
  shaft.rotation.z = -Math.PI / 2; shaft.position.x = 0.35;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.3, 14), mat);
  head.rotation.z = -Math.PI / 2; head.position.x = 0.85;
  g.add(shaft, head);
  g.userData.material = mat;
  return g;
}

/**
 * Builds a car. Options: paint colour, `xray` (see-through body, drivetrain shown),
 * `driven` ("front" or "rear": the axle that always drives), `xdrive` ("rear", "front" or "none").
 */
export function buildCar({ paint = 0x8a96a3, xray = false, driven = "front", xdrive = "rear", arrows = false } = {}) {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const paintMat = new THREE.MeshStandardMaterial({ color: paint, metalness: 0.55, roughness: 0.38, transparent: true, side: THREE.DoubleSide });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d141c, metalness: 0.9, roughness: 0.12, transparent: true, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.3, roughness: 0.7, transparent: true });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xcfd6dd, metalness: 1, roughness: 0.25, transparent: true });

  const shell = new THREE.Mesh(extrudeAcross(bodyProfile(), 1.8, 0.07), paintMat);
  body.add(shell);
  // Glass: the side windows just outside the body, the windscreen and rear window over it.
  for (const side of [1, -1]) {
    const w = new THREE.Mesh(extrudeAcross(windowProfile(), 0.02), glassMat);
    w.position.y = side * 0.895;
    body.add(w);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.11), paintMat);
    mirror.position.set(0.72, side * 1.0, 1.08);
    body.add(mirror);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.04, 0.05), chromeMat);
    rail.position.set(-0.75, side * 0.62, 1.6);
    body.add(rail);
    // Headlights and tail lights.
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.38, 0.09),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdde8ff, emissiveIntensity: 0.8, transparent: true }));
    head.position.set(2.17, side * 0.6, 0.7);
    head.rotation.y = 0.2;
    body.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x8a0000, emissive: 0xff1a1a, emissiveIntensity: 0.6, transparent: true }));
    tail.position.set(-2.22, side * 0.62, 1.02);
    body.add(tail);
    tail.userData.brake = true;
    // Kidney grille.
    const kidney = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.2), trimMat);
    kidney.position.set(2.19, side * 0.14, 0.62);
    body.add(kidney);
  }
  // Windscreen and rear window: thin panels just proud of the body's slopes.
  const pane = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0), nx = -(z1 - z0) / len * 0.015, nz = (x1 - x0) / len * 0.015;
    const s = new THREE.Shape();
    s.moveTo(x0 + nx, z0 + nz); s.lineTo(x1 + nx, z1 + nz); s.lineTo(x1 + 3 * nx, z1 + 3 * nz); s.lineTo(x0 + 3 * nx, z0 + 3 * nz);
    return new THREE.Mesh(extrudeAcross(s, 1.56), glassMat);
  };
  body.add(pane(0.86, 1.02, 0.16, 1.49), pane(-2.08, 1.33, -1.8, 1.53));
  const cladding = new THREE.Mesh(extrudeAcross((() => {
    const s = new THREE.Shape();
    s.moveTo(FRONT - 0.42, 0.21); s.lineTo(REAR + 0.42, 0.21); s.lineTo(REAR + 0.42, 0.33); s.lineTo(FRONT - 0.42, 0.33);
    return s;
  })(), 1.83), trimMat);
  body.add(cladding);

  // Wheels: steer (front) → spin → tyre, rim, spokes. The brake disc and calliper don't spin.
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9, emissive: 0x000000 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bfc6, metalness: 0.9, roughness: 0.3 });
  const discMat = new THREE.MeshStandardMaterial({ color: 0x6d6f72, metalness: 0.8, roughness: 0.4, emissive: 0x000000 });
  const wheels = [];
  for (const [x, y] of [[FRONT, TRACK / 2], [FRONT, -TRACK / 2], [REAR, TRACK / 2], [REAR, -TRACK / 2]]) {
    const steer = new THREE.Group();
    steer.position.set(x, y, WHEEL_R);
    const spin = new THREE.Group();
    steer.add(spin);
    const tm = tyreMat.clone();
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 28), tm);
    spin.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, WHEEL_W + 0.01, 24), rimMat);
    spin.add(rim);
    const out = Math.sign(y);
    for (let k = 0; k < 5; k++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.02, 0.42), new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.6 }));
      spoke.position.y = out * (WHEEL_W / 2 + 0.008);
      spoke.rotation.y = (k / 5) * Math.PI * 2;
      spin.add(spoke);
    }
    const dm = discMat.clone();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 20), dm);
    disc.position.y = -out * 0.04;
    steer.add(disc);
    root.add(steer);
    wheels.push({ steer, spin, tyre: tm, disc: dm, angle: 0, front: x > 0 });
  }

  // The drivetrain, shown through the body in X-ray: engine and gearbox across the front,
  // shafts to the driven wheels, and xDrive's propshaft, clutch and differential.
  const drive = new THREE.Group();
  root.add(drive);
  const glow = (color = 0x4d8ef0) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, metalness: 0.4, roughness: 0.5 });
  const engineMat = glow(0x6b7785), primaryMat = glow(), secondaryMat = glow();
  const shaftTex = stripes("#9aa5b1");
  const primaryShaftMat = new THREE.MeshStandardMaterial({ map: shaftTex, emissive: 0x000000, metalness: 0.5, roughness: 0.4 });
  const secondaryShaftMat = new THREE.MeshStandardMaterial({ map: shaftTex.clone(), emissive: 0x000000, metalness: 0.5, roughness: 0.4 });
  const primaryAxle = driven === "rear" ? REAR : FRONT;
  const otherAxle = driven === "rear" ? FRONT : REAR;
  const engine = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.62, 0.5), engineMat);
  const gearbox = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.36), primaryMat);
  if (driven === "front") { // transverse, as in the F48
    engine.position.set(1.62, 0.18, 0.68);
    gearbox.position.set(1.48, -0.35, 0.52);
  } else { // in line, as in the F15 and G-series
    engine.geometry = new THREE.BoxGeometry(0.75, 0.5, 0.5);
    engine.position.set(1.35, 0, 0.7);
    gearbox.position.set(0.55, 0, 0.5);
  }
  drive.add(engine, gearbox);
  const shafts = { primary: [], secondary: [] };
  const axleZ = WHEEL_R;
  for (const side of [1, -1]) {
    const s = cylinderBetween(new THREE.Vector3(primaryAxle, 0, axleZ), new THREE.Vector3(primaryAxle, side * (TRACK / 2 - 0.12), axleZ), 0.03, primaryShaftMat);
    shafts.primary.push(s); drive.add(s);
  }
  const diffMat = glow(0x6b7785);
  const primaryDiff = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), primaryMat);
  primaryDiff.position.set(primaryAxle, 0, axleZ);
  drive.add(primaryDiff);
  const hasXDrive = xdrive === "rear" || xdrive === "front";
  let clutch = null;
  if (hasXDrive) {
    const prop = cylinderBetween(new THREE.Vector3(primaryAxle - Math.sign(primaryAxle) * 0.18, 0, axleZ + 0.02),
      new THREE.Vector3(otherAxle - Math.sign(otherAxle) * 0.42, 0, axleZ + 0.02), 0.04, secondaryShaftMat);
    shafts.secondary.push(prop); drive.add(prop);
    // xDrive's clutch: a stack of plates at the rear differential's input (F48) or in the transfer case.
    clutch = new THREE.Group();
    clutch.position.set(otherAxle - Math.sign(otherAxle) * 0.3, 0, axleZ + 0.02);
    const plates = [];
    for (let k = 0; k < 7; k++) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.012, 24), k % 2 ? glow(0xb0b8c0) : secondaryMat);
      p.rotation.z = Math.PI / 2;
      clutch.add(p);
      plates.push(p);
    }
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.2, 24, 1, true),
      new THREE.MeshStandardMaterial({ color: 0x5a636c, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    housing.rotation.z = Math.PI / 2;
    clutch.add(housing);
    clutch.userData.plates = plates;
    drive.add(clutch);
    const diff = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), secondaryMat);
    diff.position.set(otherAxle, 0, axleZ);
    drive.add(diff);
    for (const side of [1, -1]) {
      const s = cylinderBetween(new THREE.Vector3(otherAxle, 0, axleZ), new THREE.Vector3(otherAxle, side * (TRACK / 2 - 0.12), axleZ), 0.03, secondaryShaftMat);
      shafts.secondary.push(s); drive.add(s);
    }
  } else {
    const diff = new THREE.Mesh(new THREE.BoxGeometry(0.12, TRACK - 0.3, 0.06), diffMat);
    diff.position.set(otherAxle, 0, axleZ);
    drive.add(diff);
  }

  // Torque arrows over each axle's wheels, for the close-up.
  const arrowsByAxle = { primary: [], secondary: [] };
  if (arrows) {
    for (const side of [1, -1]) {
      for (const [axle, x] of [["primary", primaryAxle], ["secondary", otherAxle]]) {
        if (axle === "secondary" && !hasXDrive) continue;
        const a = arrow(0x4d8ef0);
        a.position.set(x + 0.1, side * (TRACK / 2 + 0.28), WHEEL_R);
        drive.add(a);
        arrowsByAxle[axle].push(a);
      }
    }
  }

  const bodyMaterials = [paintMat, glassMat, trimMat, chromeMat];
  body.traverse((o) => { if (o.material && !bodyMaterials.includes(o.material)) bodyMaterials.push(o.material); });
  const brakeLights = [];
  body.traverse((o) => { if (o.userData.brake) brakeLights.push(o.material); });

  function setXray(on) {
    for (const m of bodyMaterials) {
      m.opacity = on ? (m === glassMat ? 0.12 : 0.16) : 1;
      m.depthWrite = !on;
    }
    drive.visible = on;
  }
  setXray(xray);

  const tmp = new THREE.Color();
  /**
   * state: wheels [FL, FR, RL, RR] km/h, speed km/h (for slip), steer (° left), dt (s),
   * engine (Nm at the crank, max ~400), secondary (Nm through xDrive's clutch, max ~1000),
   * braking (0...1).
   */
  function update(state) {
    const dt = state.dt || 0;
    const ref = Math.max(state.speed ?? 0, 5);
    wheels.forEach((w, i) => {
      const kmh = state.wheels?.[i] ?? state.speed ?? 0;
      w.angle = (w.angle + (kmh / 3.6 / WHEEL_R) * dt) % (Math.PI * 2);
      w.spin.rotation.y = w.angle;
      if (w.front) w.steer.rotation.z = (state.steer || 0) * Math.PI / 180;
      // Slip: a wheel faster or slower than the car glows on its tyre.
      const slip = Math.abs(kmh - (state.speed ?? kmh)) / ref;
      w.tyre.emissive.setRGB(slip > 0.03 ? Math.min(1, slip * 6) : 0, slip > 0.03 ? Math.min(0.45, slip * 2.5) : 0, 0);
      w.disc.emissive.setRGB((state.braking || 0) * 0.9, (state.braking || 0) * 0.15, 0);
    });
    for (const m of brakeLights) m.emissiveIntensity = 0.6 + 2.4 * (state.braking || 0);
    const engineF = Math.max(0, state.engine || 0) / 380;
    const secondF = Math.max(0, state.secondary || 0) / 1000;
    for (const m of [primaryMat]) { heatColor(engineF, m.emissive); m.emissiveIntensity = 0.25 + 1.2 * engineF; }
    heatColor(engineF * 0.6, engineMat.emissive); engineMat.emissiveIntensity = 0.15 + 0.6 * engineF;
    heatColor(secondF, secondaryMat.emissive); secondaryMat.emissiveIntensity = 0.2 + 1.4 * secondF;
    heatColor(engineF, tmp); primaryShaftMat.emissive.copy(tmp).multiplyScalar(0.25 + engineF);
    heatColor(secondF, tmp); secondaryShaftMat.emissive.copy(tmp).multiplyScalar(0.15 + secondF);
    // Shafts turn with the wheels; the propshaft only does real work when the clutch closes.
    const turn = ((state.speed ?? 0) / 3.6 / WHEEL_R) * dt;
    primaryShaftMat.map.offset.x = (primaryShaftMat.map.offset.x + turn / (Math.PI * 2)) % 1;
    secondaryShaftMat.map.offset.x = (secondaryShaftMat.map.offset.x + turn * 3 / (Math.PI * 2)) % 1;
    if (clutch) {
      // Plates spread when open, packed tight when the clutch closes.
      const gap = 0.012 + 0.03 * (1 - Math.min(1, secondF * 2.2));
      clutch.userData.plates.forEach((p, k) => { p.position.x = (k - 3) * gap; });
    }
    for (const a of arrowsByAxle.primary) { a.scale.set(0.25 + engineF * 1.6, 1, 1); heatColor(engineF, a.userData.material.color); a.userData.material.emissive.copy(a.userData.material.color); }
    for (const a of arrowsByAxle.secondary) { a.visible = secondF > 0.01; a.scale.set(0.25 + secondF * 1.6, 1, 1); heatColor(secondF, a.userData.material.color); a.userData.material.emissive.copy(a.userData.material.color); }
  }

  /** Where to put labels: the two axles' centres and the clutch, in the car's axes. */
  const anchors = {
    primary: new THREE.Vector3(primaryAxle, 0, axleZ + 0.25),
    secondary: hasXDrive ? new THREE.Vector3(otherAxle - Math.sign(otherAxle) * 0.3, 0, axleZ + 0.3) : null,
    engine: engine.position.clone().add(new THREE.Vector3(0, 0, 0.35)),
  };

  return { root, body, drive, update, setXray, anchors, hasXDrive, driven };
}
