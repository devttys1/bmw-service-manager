// What this copy of Drive Replay shows. The local app (web.py) shows everything. The hosted page
// (tools/build-replay-site.sh) sets `window.REPLAY_SITE` in its index.html: which imagery and
// car models it may use on a page that sits next to a store (their licences differ: see
// docs/master-plan/workpacks/WP-C1-licences.md), and the URLs it was built for.
//
// The app's copy (--app) sets `embedded` too: it shows only the player.
//
// The detail level: "lite" on a phone or a tablet (no 4× terrain sharpening, the map's usual
// tile size, the close-up at no more than 2× pixels), else "full". `?detail=lite|full` overrides.

const site = globalThis.REPLAY_SITE || {};
const asked = new URLSearchParams(globalThis.location?.search || "").get("detail");
const touch = !!globalThis.matchMedia?.("(pointer: coarse)").matches && !globalThis.matchMedia?.("(pointer: fine)").matches;

/** Built as a static site (no Python server: no service history, no video overlay links). */
export const HOSTED = !!site.hosted;
/** Inside an app's web view (Boostbook on the iPhone and iPad): no header and no page to drop a
 *  file on. The app opens drives itself (window.replay.open) and has its own title bar. */
export const EMBEDDED = !!site.embedded;
/** The 32 car models (CC BY-NC-SA); without them, the drawn car. */
export const CAR_MODELS = site.carModels !== false;
/** The states' aerial imagery it may use, by name ("NSW", "Queensland", "Tasmania"); null: all. */
export const AERIAL = Array.isArray(site.aerial) ? site.aerial : null;
/** "lite" or "full". */
export const DETAIL = asked === "lite" || asked === "full" ? asked : site.detail || (touch ? "lite" : "full");
export const LITE = DETAIL === "lite";
/** The screen's pixels to draw at: capped at 2 in lite. */
export const PIXEL_RATIO = Math.min(globalThis.devicePixelRatio || 1, LITE ? 2 : Infinity);

/** A file beside the page's scripts (static/…), wherever the page is served from. */
export const asset = (path) => new URL(`../${path}`, import.meta.url).href;
