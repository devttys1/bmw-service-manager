// The map: imagery draped over 3D terrain, the drive's path coloured by a value, and the
// car drawn by three.js where it was, pointing and tilting as it did.
//
// Everything here needs no account or key: Esri's World Imagery, OpenTopoMap and OpenStreetMap
// for the ground, and AWS's open terrain tiles (Mapzen's terrarium heights) for its shape.

import * as THREE from "three";
import { buildCar } from "./car3d.js";

const maplibregl = window.maplibregl;
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

export const BASEMAPS = {
  satellite: { label: "Satellite", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
    // Deeper tiles are "Map data not yet available" away from cities: stretch these instead.
    maxzoom: 17, attribution: "Imagery © Esri, Maxar, Earthstar Geographics", hillshade: false },
  topo: { label: "Topographic", tiles: ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17, attribution: "© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)", hillshade: true },
  streets: { label: "Streets", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    maxzoom: 19, attribution: "© OpenStreetMap contributors", hillshade: true },
};

/** Speed-style colours, slow to fast. */
const RAMP = ["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d", "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c"];

function rampColor(f) {
  const k = Math.min(1, Math.max(0, f)) * (RAMP.length - 1);
  return RAMP[Math.round(k)];
}

/** The car, drawn into the map's own WebGL context, at the drive's position. */
class CarLayer {
  constructor(options) {
    this.id = "car";
    this.type = "custom";
    this.renderingMode = "3d";
    this.options = options;
    this.pose = null;
    this.size = 1;
  }

  onAdd(map, gl) {
    this.map = map;
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(30, -20, 60);
    this.scene.add(sun);
    this.car = buildCar(this.options);
    this.scene.add(this.car.root);
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  render(gl, matrix) {
    const p = this.pose;
    if (!p) return;
    const elevation = this.map.queryTerrainElevation([p.lon, p.lat]) ?? 0;
    const merc = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat], elevation);
    const s = merc.meterInMercatorCoordinateUnits() * this.size;
    // Mercator's y runs south, so flip it: the car's x forward, y left, z up, then on the map
    // east, north, up. Turned to its heading, then pitched and rolled.
    const yaw = (90 - p.heading) * Math.PI / 180;
    const m = new THREE.Matrix4()
      .makeTranslation(merc.x, merc.y, merc.z)
      .scale(new THREE.Vector3(s, -s, s))
      .multiply(new THREE.Matrix4().makeRotationZ(yaw))
      .multiply(new THREE.Matrix4().makeRotationY(-p.pitch * Math.PI / 180))
      .multiply(new THREE.Matrix4().makeRotationX(p.roll * Math.PI / 180));
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(m);
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
  }
}

export class ReplayMap {
  constructor(container, { driven = "front", xdrive = "rear" } = {}) {
    this.mode = "chase";
    this.basemap = "satellite";
    this.chase = { zoom: 18.6, pitch: 72 };
    this.map = new maplibregl.Map({
      container,
      style: this.style(),
      // Past 19 the terrain's heights run out of detail (and MapLibre errs reading them).
      center: [0, 0], zoom: 2, pitch: 0, maxPitch: 85, maxZoom: 19,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
      antialias: true,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    this.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
    this.carLayer = new CarLayer({ driven, xdrive, paint: 0x8f9cab });
    this.ready = new Promise((resolve) => this.map.on("load", () => {
      this.map.addLayer(this.carLayer);
      resolve();
    }));
    // In the following modes the car stays in the middle; dragging lets go of it.
    this.map.on("dragstart", () => { if (this.mode !== "free") this.setMode("free", true); });
    // Behind the car, your zoom and tilt are kept.
    const keep = (e) => { if (e.originalEvent && this.mode === "chase") this.chase = { zoom: this.map.getZoom(), pitch: this.map.getPitch() }; };
    this.map.on("zoomend", keep);
    this.map.on("pitchend", keep);
    this.onModeChange = null;
  }

  style() {
    const sources = {
      terrain: { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15,
        attribution: "Terrain: Mapzen, AWS Open Data" },
      hillshade: { type: "raster-dem", tiles: [TERRARIUM], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
      track: { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true },
      line: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
      marks: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    };
    const layers = [{ id: "bg", type: "background", paint: { "background-color": "#20262c" } }];
    for (const [id, b] of Object.entries(BASEMAPS)) {
      sources[id] = { type: "raster", tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
      layers.push({ id, type: "raster", source: id, layout: { visibility: id === this.basemap ? "visible" : "none" } });
    }
    layers.push(
      { id: "hillshade", type: "hillshade", source: "hillshade", layout: { visibility: "none" },
        paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "#3b3b3b" } },
      { id: "track-casing", type: "line", source: "track", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#000", "line-opacity": 0.45, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 4, 18, 11] } },
      { id: "track", type: "line", source: "track", layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#ff3b30", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 18, 7] } },
      { id: "start-line", type: "line", source: "line",
        paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 13, 2, 18, 6], "line-dasharray": [1, 0.6] } },
      { id: "marks", type: "circle", source: "marks",
        paint: { "circle-radius": 6, "circle-color": "#ffd60a", "circle-stroke-color": "#000", "circle-stroke-width": 1.5 } },
    );
    return { version: 8, sources, layers, terrain: { source: "terrain", exaggeration: 1 } };
  }

  setBasemap(name) {
    this.basemap = name;
    for (const id of Object.keys(BASEMAPS)) this.map.setLayoutProperty(id, "visibility", id === name ? "visible" : "none");
    this.map.setLayoutProperty("hillshade", "visibility", BASEMAPS[name].hillshade ? "visible" : "none");
  }

  setExaggeration(x) {
    this.map.setTerrain({ source: "terrain", exaggeration: x });
  }

  /** The drive's path, coloured by `series` (one value per sample) between lo and hi. */
  setTrack(drive, series, lo, hi) {
    const step = Math.max(1, Math.round(drive.n / 4000));
    const coords = [], progress = [];
    const total = drive.dist[drive.n - 1] || 1;
    let last = -1;
    for (let i = 0; i < drive.n; i += step) {
      coords.push([drive.lon[i], drive.lat[i]]);
      const p = drive.dist[i] / total;
      if (p > last + 1e-6) progress.push([p, i]);
      last = Math.max(last, p);
    }
    this.map.getSource("track").setData({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
    if (series && hi > lo && progress.length > 2) {
      // The colour at each point by its share of the distance: at most 600 stops.
      const every = Math.max(1, Math.ceil(progress.length / 600));
      const stops = [];
      for (let k = 0; k < progress.length; k += every) {
        const [p, i] = progress[k];
        const v = series[i];
        stops.push(p, Number.isFinite(v) ? rampColor((v - lo) / (hi - lo)) : "#888888");
      }
      if (stops[0] !== 0) stops.unshift(0, stops[1]);
      this.map.setPaintProperty("track", "line-gradient", ["interpolate", ["linear"], ["line-progress"], ...stops]);
    } else {
      this.map.setPaintProperty("track", "line-gradient", undefined);
    }
  }

  /** The start/finish line across the path, 30 m wide; null for none. */
  setStartLine(drive, line) {
    const features = [];
    if (line) {
      const h = line.heading * Math.PI / 180;
      const ax = Math.cos(h), ay = -Math.sin(h); // square to the way through
      const a = drive.proj.ll(line.x + ax * 15, line.y + ay * 15), b = drive.proj.ll(line.x - ax * 15, line.y - ay * 15);
      features.push({ type: "Feature", geometry: { type: "LineString", coordinates: [[a[1], a[0]], [b[1], b[0]]] }, properties: {} });
    }
    this.map.getSource("line").setData({ type: "FeatureCollection", features });
  }

  setMarks(drive) {
    const features = drive.marks.map((m) => {
      const i = Math.min(drive.n - 1, Math.round(m.t * drive.rate));
      return { type: "Feature", geometry: { type: "Point", coordinates: [drive.lon[i], drive.lat[i]] }, properties: { label: m.label } };
    });
    this.map.getSource("marks").setData({ type: "FeatureCollection", features });
  }

  fit(drive, animate = true) {
    let w = 180, e = -180, s = 90, n = -90;
    for (let i = 0; i < drive.n; i += 5) {
      w = Math.min(w, drive.lon[i]); e = Math.max(e, drive.lon[i]);
      s = Math.min(s, drive.lat[i]); n = Math.max(n, drive.lat[i]);
    }
    this.map.fitBounds([[w, s], [e, n]], { padding: 60, pitch: 50, bearing: this.map.getBearing(), duration: animate ? 1200 : 0, maxZoom: 17 });
  }

  /** "chase" (behind the car), "top" (above it, north up) or "free" (where you leave it). */
  setMode(mode, byUser = false) {
    this.mode = mode;
    const follow = mode !== "free";
    if (follow) this.map.dragPan.disable(); else this.map.dragPan.enable();
    if (mode === "chase") this.map.jumpTo({ zoom: this.chase.zoom, pitch: this.chase.pitch });
    if (mode === "top") this.map.jumpTo({ zoom: 17, pitch: 0, bearing: 0 });
    if (byUser && this.onModeChange) this.onModeChange(mode);
  }

  /** The car at `pose` ({lat, lon, heading, pitch, roll}) and the camera after it. */
  show(pose, carState) {
    this.carLayer.pose = pose;
    // Never smaller than about 34 pixels long, so it can be found zoomed out.
    const mpp = 40075016.686 * Math.cos(pose.lat * Math.PI / 180) / (512 * 2 ** this.map.getZoom());
    this.carLayer.size = Math.max(1, (48 * mpp) / 4.44);
    if (this.carLayer.car) this.carLayer.car.update(carState);
    if (this.mode === "chase") {
      this.map.jumpTo({ center: [pose.lon, pose.lat], bearing: pose.heading });
    } else if (this.mode === "top") {
      this.map.jumpTo({ center: [pose.lon, pose.lat] });
    } else {
      this.map.triggerRepaint();
    }
  }
}
