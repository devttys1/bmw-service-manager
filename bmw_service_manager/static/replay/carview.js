// The close-up: the car on a patch of ground that tilts as the road did, seen from a camera you
// can turn (drag) and zoom (scroll), with its drivetrain shown through the body and labelled.

import * as THREE from "three";
import { OrbitControls } from "../vendor/OrbitControls.js";
import { buildCar } from "./car3d.js";

export class CarView {
  constructor(container, { driven = "front", xdrive = "rear" } = {}) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-4.1, 3.5, 2.1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.55);
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI * 0.62;
    this.controls.update();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.8));
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(4, -6, 10);
    this.scene.add(sun);

    // The world tilts (the road's slope and the body's lean); the camera and horizon don't.
    this.world = new THREE.Group();
    this.scene.add(this.world);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48),
      new THREE.MeshStandardMaterial({ color: 0x59636e, transparent: true, opacity: 0.35, roughness: 1 }));
    this.world.add(ground);
    const grid = new THREE.GridHelper(12, 24, 0x8894a0, 0x8894a0);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true; grid.material.opacity = 0.35;
    grid.position.z = 0.002;
    this.world.add(grid);
    this.gridLines = grid;
    this.car = buildCar({ driven, xdrive, xray: true, arrows: true, paint: 0x8f9cab });
    this.world.add(this.car.root);

    // Labels over the drivetrain, placed each frame.
    this.labels = {};
    for (const key of ["engine", "primary", "secondary"]) {
      if (!this.car.anchors[key]) continue;
      const el = document.createElement("div");
      el.className = "car-label";
      container.appendChild(el);
      this.labels[key] = el;
    }
    this.resize();
    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setXray(on) { this.car.setXray(on); for (const el of Object.values(this.labels)) el.hidden = !on; }

  /** pose: pitch and roll (°); state: as car3d's update, plus label texts. */
  render(pose, state, texts = {}) {
    this.world.rotation.set(0, 0, 0);
    this.world.rotateY(-pose.pitch * Math.PI / 180);
    this.world.rotateX(pose.roll * Math.PI / 180);
    // The ground slides under the car as it moves.
    const step = 0.5;
    this.gridLines.position.x = -((pose.distance || 0) % step);
    this.car.update(state);
    this.renderer.render(this.scene, this.camera);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.world.updateMatrixWorld();
    for (const [key, el] of Object.entries(this.labels)) {
      const p = this.car.anchors[key].clone().applyMatrix4(this.world.matrixWorld).project(this.camera);
      el.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px) translate(-50%, -100%)`;
      el.textContent = texts[key] ?? "";
      el.style.visibility = texts[key] && !el.hidden ? "visible" : "hidden";
    }
  }
}
