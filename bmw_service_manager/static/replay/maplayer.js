// The map: imagery draped over 3D terrain, the drive's path coloured by a value, and the
// car drawn by three.js where it was, pointing and tilting as it did.
//
// Everything here needs no account or key: for the ground, the NSW, Queensland and Tasmanian
// governments' aerial photos where the drive is in those states, Esri's World Imagery elsewhere,
// OpenTopoMap and OpenStreetMap; for its shape, AWS's open terrain tiles (Mapzen's terrarium heights).

import * as THREE from "three";
import { RoomEnvironment } from "../vendor/RoomEnvironment.js";
import { buildCar } from "./car3d.js";

const maplibregl = window.maplibregl;
const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
const ESRI_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics";

/**
 * State governments' aerial photos: flown, not from a satellite, a few cm to 50 cm a pixel,
 * where Esri often has 60 cm. Tried first for tiles in their box, zoomed in from `from` (further
 * out, Esri's one picture looks better than states' edges). Victoria's Vicmap Basemaps is a paid
 * service, so isn't here. `tilemap`: the service says which tiles it has, as Esri's does.
 */
const AERIAL = [
  { name: "NSW", bounds: [140.99, -37.51, 153.64, -28.15], from: 14, to: 21,
    tiles: "https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer",
    credit: "Aerial imagery © State of New South Wales (Spatial Services, DCS), CC BY" },
  { name: "Queensland", bounds: [137.99, -29.18, 153.56, -9.14], from: 14, to: 20, tilemap: true,
    tiles: "https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer",
    credit: "Aerial imagery © State of Queensland, CC BY 4.0" },
  { name: "Tasmania", bounds: [143.8, -43.75, 148.5, -39.5], from: 14, to: 19, tilemap: true,
    tiles: "https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/Orthophoto/MapServer",
    credit: "Aerial imagery © State of Tasmania, CC BY-NC-ND 3.0 AU" },
];

/** The credits for the imagery around a drive's [west, south, east, north]: the states it's in, and Esri. */
export function imageryCredit(bounds) {
  const states = AERIAL.filter((a) => !bounds || (bounds[0] < a.bounds[2] && bounds[2] > a.bounds[0] && bounds[1] < a.bounds[3] && bounds[3] > a.bounds[1]));
  return [...states.map((a) => a.credit), ESRI_CREDIT].join(" · ");
}

// On a Retina screen, MapLibre still picks imagery by CSS pixels: half the screen's detail.
// Calling the tiles half as big makes it fetch the next level down, sharp to the pixel.
const RETINA = (window.devicePixelRatio || 1) >= 1.5;

export const BASEMAPS = {
  satellite: { label: "Satellite",
    // As deep as there is where the car is (see imageryTile): 21 in NSW, 20 in some cities, often 18 in the country.
    tiles: ["imagery://{z}/{y}/{x}"], tileSize: RETINA ? 128 : 256,
    maxzoom: 21, attribution: ESRI_CREDIT, hillshade: false },
  topo: { label: "Topographic", tiles: ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17, attribution: "© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)", hillshade: true },
  streets: { label: "Streets", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    maxzoom: 19, attribution: "© OpenStreetMap contributors", hillshade: true },
};

/** A drive's [west, south, east, north]. */
export function driveBounds(drive) {
  let w = 180, e = -180, s = 90, n = -90;
  for (let i = 0; i < drive.n; i += 5) {
    w = Math.min(w, drive.lon[i]); e = Math.max(e, drive.lon[i]);
    s = Math.min(s, drive.lat[i]); n = Math.max(n, drive.lat[i]);
  }
  return [w, s, e, n];
}

/** Speed-style colours, slow to fast. */
const RAMP = ["#2c7bb6", "#00a6ca", "#00ccbc", "#90eb9d", "#ffff8c", "#f9d057", "#f29e2e", "#e76818", "#d7191c"];

function rampColor(f) {
  const k = Math.min(1, Math.max(0, f)) * (RAMP.length - 1);
  return RAMP[Math.round(k)];
}

/**
 * Imagery, only the tiles there are. How deep each goes varies by place: past it, Esri sends a
 * "Map data not yet available" picture, or with blankTile=false a 404 without the CORS header
 * (an error in the console for every tile); the states send a tiny blank or a 404. So ask a
 * tilemap first where there is one, which says for a block of 32 × 32 tiles which exist, and
 * fail the missing ones here: MapLibre then stretches the tile above, as it does for any tile
 * it can't load.
 */
const BLOCK = 32, DEEP = 17; // shallower than DEEP, Esri has the whole world
const BLANK = 1500; // bytes: a state's "nothing here" tile is 549 to 876; a real one is several kB
const tilemaps = new Map();

function tilemapHas(service, z, y, x) {
  const top = y - (y % BLOCK), left = x - (x % BLOCK), key = `${service} ${z}/${top}/${left}`;
  if (!tilemaps.has(key)) {
    tilemaps.set(key, fetch(`${service}/tilemap/${z}/${top}/${left}/${BLOCK}/${BLOCK}`)
      .then((r) => r.ok ? r.json() : null)
      .then((j) => (j?.valid && j.location?.top === top && j.location?.left === left ? j.data : null))
      .catch(() => null));
  }
  // Not known (the tilemap failed): fetch it anyway.
  return tilemaps.get(key).then((data) => !data || data[(y - top) * BLOCK + (x - left)] === 1);
}

/** A tile's [west, south, east, north]. */
function tileBounds(z, y, x) {
  const n = 2 ** z, lon = (i) => (i / n) * 360 - 180;
  const lat = (j) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

class NoImagery extends Error {}

async function imageryTile(params, abort) {
  const [z, y, x] = params.url.slice("imagery://".length).split("/").map(Number);
  const [w, s, e, n] = tileBounds(z, y, x);
  for (const a of AERIAL) {
    if (z < a.from || z > a.to || w > a.bounds[2] || e < a.bounds[0] || s > a.bounds[3] || n < a.bounds[1]) continue;
    if (a.tilemap && !(await tilemapHas(a.tiles, z, y, x))) continue;
    try {
      const r = await fetch(`${a.tiles}/tile/${z}/${y}/${x}`, { signal: abort.signal });
      if (r.ok && r.headers.get("content-type")?.startsWith("image/")) {
        const data = await r.arrayBuffer();
        if (data.byteLength > BLANK) return { data };
      }
    } catch (err) {
      if (abort.signal.aborted) throw err;
    }
  }
  if (z >= DEEP && !(await tilemapHas(ESRI, z, y, x))) throw new NoImagery(`No imagery at ${z}/${y}/${x}`);
  const r = await fetch(`${ESRI}/tile/${z}/${y}/${x}?blankTile=false`, { signal: abort.signal });
  if (!r.ok) throw new NoImagery(`No imagery at ${z}/${y}/${x}`);
  return { data: await r.arrayBuffer() };
}

maplibregl.addProtocol("imagery", imageryTile);

/**
 * With 3D terrain, MapLibre first paints the imagery and the path into a texture per terrain
 * tile, then drapes those over the ground. Its textures are 1024 pixels for a tile that's up to
 * 2048 CSS pixels across: on a Retina screen that's a quarter of the screen's detail, so the
 * ground went soft and the path's edges stair-stepped close to the car. On a Retina screen,
 * rebuild the pool with textures twice as wide (MapLibre 4.7's private Terrain.qualityFactor and
 * painter.renderToTexture).
 *
 * The pool makes textures as they're needed and, when they run out, draws what it has and
 * starts again. Chasing the car, 50 to 60 tiles reach the horizon: 30 textures (MapLibre's
 * limit) at 2048 pixels would be nearly 1 GB and stuttered (41 fps, 320 ms stalls on an M3 Max),
 * so the limit shrinks to keep MapLibre's own memory, about 250 MB, which kept 60 fps.
 */
function sharpenTerrain(map) {
  const terrain = map.terrain, painter = map.painter, rtt = painter?.renderToTexture;
  if (!terrain || !rtt || rtt.sharpened) return;
  rtt.sharpened = true;
  const gl = painter.context.gl;
  const quality = (window.devicePixelRatio || 1) > 1.25 ? 4 : 2; // a power of two; 2 is MapLibre's
  if (quality === terrain.qualityFactor || terrain.sourceCache.tileSize * quality > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return;
  const textures = Math.max(8, Math.floor(rtt.pool._size * (terrain.qualityFactor / quality) ** 2));
  terrain.qualityFactor = quality;
  rtt.pool.destruct();
  const sharper = new rtt.constructor(painter, terrain);
  sharper.pool._size = textures;
  sharper.sharpened = true;
  painter.renderToTexture = sharper;
  map.triggerRepaint();
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

  /** The car: a model from car3d's loadModel, painted by its code, or null for the simple one. */
  setModel(model, paintCode = null) {
    this.options = { ...this.options, model, paintCode };
    if (!this.scene) return;
    this.scene.remove(this.car.root);
    this.car = buildCar(this.options);
    this.scene.add(this.car.root);
    this.map.triggerRepaint();
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
    // Made here rather than in onAdd: it draws, and MapLibre expects that only while rendering.
    if (!this.scene.environment) {
      this.scene.environment = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
      this.scene.environmentIntensity = 0.7;
      this.renderer.resetState();
    }
    this.renderer.render(this.scene, this.camera);
  }
}

export class ReplayMap {
  /** bounds: the drive's [west, south, east, north], for the imagery's credits. */
  constructor(container, { driven = "front", xdrive = "rear", bounds = null } = {}) {
    this.bounds = bounds;
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
    // Missing imagery is expected (imageryTile); anything else, MapLibre's way, in the console.
    this.map.on("error", (e) => {
      if (!(e.error instanceof NoImagery || e.error?.message?.startsWith("No imagery"))) console.error(e.error);
    });
    // Every setTerrain makes a new render-to-texture pool at MapLibre's own size: sharpen each.
    this.map.on("terrain", () => sharpenTerrain(this.map));
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
    const layers = [{ id: "bg", type: "background", paint: { "background-color": "#0b1630" } }];
    for (const [id, b] of Object.entries(BASEMAPS)) {
      const attribution = id === "satellite" ? imageryCredit(this.bounds) : b.attribution;
      sources[id] = { type: "raster", tiles: b.tiles, tileSize: b.tileSize || 256, maxzoom: b.maxzoom, attribution };
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
    // Tilted towards the horizon, the far ground fades into a Midnight sky, as the page around it.
    const sky = { "sky-color": "#0b1630", "horizon-color": "#2a4a80", "fog-color": "#16264a",
      "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.75, "atmosphere-blend": 0 };
    return { version: 8, sources, layers, sky, terrain: { source: "terrain", exaggeration: 1 } };
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
    const [w, s, e, n] = driveBounds(drive);
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
