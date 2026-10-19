"use strict";

// Icons for service-history and CBS items, matching the iOS app's ItemStyle.swift.
// Stroke icons from Tabler Icons (https://tabler.io/icons, MIT, © Paweł Kuna),
// inlined so the page works offline in the car. "oilcan" and "brake" are drawn
// here in the same style (Tabler has neither).

const ICON_PATHS = {
  oilcan: '<path d="M4 11h9a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-9a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z" /><path d="M7 11v-2h3v2" /><path d="M5.5 9h6" /><path d="M14 14.5l6.5 -4.5" /><path d="M20.5 13c0 .7 .3 1.2 .75 1.2s.75 -.5 .75 -1.2s-.75 -1.6 -.75 -1.6s-.75 .9 -.75 1.6z" /><path d="M3 13.5h-1" />',
  brake: '<path d="M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0" /><path d="M12 9v3.5" /><path d="M12 15h.01" /><path d="M4.2 6.5a9 9 0 0 0 0 11" /><path d="M19.8 6.5a9 9 0 0 1 0 11" />',
  droplet: '<path d="M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546z" />',
  "droplet-half": '<path d="M7.502 19.423c2.602 2.105 6.395 2.105 8.996 0c2.602 -2.105 3.262 -5.708 1.566 -8.546l-4.89 -7.26c-.42 -.625 -1.287 -.803 -1.936 -.397a1.376 1.376 0 0 0 -.41 .397l-4.893 7.26c-1.695 2.838 -1.035 6.441 1.567 8.546z" /><path d="M5 14h14" />',
  "air-conditioning": '<path d="M8 16a3 3 0 0 1 -3 3" /><path d="M16 16a3 3 0 0 0 3 3" /><path d="M12 16v4" /><path d="M3 5m0 2a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" /><path d="M7 13v-3a1 1 0 0 1 1 -1h8a1 1 0 0 1 1 1v3" />',
  propeller: '<path d="M12 13m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M14.167 10.5c.722 -1.538 1.156 -3.043 1.303 -4.514c.22 -1.63 -.762 -2.986 -3.47 -2.986s-3.69 1.357 -3.47 2.986c.147 1.471 .581 2.976 1.303 4.514" /><path d="M13.169 16.751c.97 1.395 2.057 2.523 3.257 3.386c1.3 1 2.967 .833 4.321 -1.512c1.354 -2.345 .67 -3.874 -.85 -4.498c-1.348 -.608 -2.868 -.985 -4.562 -1.128" /><path d="M8.664 13c-1.693 .143 -3.213 .52 -4.56 1.128c-1.522 .623 -2.206 2.153 -.852 4.498s3.02 2.517 4.321 1.512c1.2 -.863 2.287 -1.991 3.258 -3.386" />',
  bolt: '<path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11" />',
  wind: '<path d="M5 8h8.5a2.5 2.5 0 1 0 -2.34 -3.24" /><path d="M3 12h15.5a2.5 2.5 0 1 1 -2.34 3.24" /><path d="M4 16h5.5a2.5 2.5 0 1 1 -2.34 3.24" />',
  "gas-station": '<path d="M14 11h1a2 2 0 0 1 2 2v3a1.5 1.5 0 0 0 3 0v-7l-3 -3" /><path d="M4 20v-14a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v14" /><path d="M3 20l12 0" /><path d="M18 7v1a1 1 0 0 0 1 1h1" /><path d="M4 11l10 0" />',
  tools: '<path d="M3 21h4l13 -13a1.5 1.5 0 0 0 -4 -4l-13 13v4" /><path d="M14.5 5.5l4 4" /><path d="M12 8l-5 -5l-4 4l5 5" /><path d="M7 8l-1.5 1.5" /><path d="M16 12l5 5l-4 4l-5 -5" /><path d="M16 17l-1.5 1.5" />',
  tool: '<path d="M7 10h3v-3l-3.5 -3.5a6 6 0 0 1 8 8l6 6a2 2 0 0 1 -3 3l-6 -6a6 6 0 0 1 -8 -8l3.5 3.5" />',
  package: '<path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" /><path d="M12 12l8 -4.5" /><path d="M12 12l0 9" /><path d="M12 12l-8 -4.5" /><path d="M16 5.25l-8 4.5" />',
  road: '<path d="M4 19l4 -14" /><path d="M16 5l4 14" /><path d="M12 8v-2" /><path d="M12 13v-2" /><path d="M12 18v-2" />',
  "rosette-check": '<path d="M5 7.2a2.2 2.2 0 0 1 2.2 -2.2h1a2.2 2.2 0 0 0 1.55 -.64l.7 -.7a2.2 2.2 0 0 1 3.12 0l.7 .7c.412 .41 .97 .64 1.55 .64h1a2.2 2.2 0 0 1 2.2 2.2v1c0 .58 .23 1.138 .64 1.55l.7 .7a2.2 2.2 0 0 1 0 3.12l-.7 .7a2.2 2.2 0 0 0 -.64 1.55v1a2.2 2.2 0 0 1 -2.2 2.2h-1a2.2 2.2 0 0 0 -1.55 .64l-.7 .7a2.2 2.2 0 0 1 -3.12 0l-.7 -.7a2.2 2.2 0 0 0 -1.55 -.64h-1a2.2 2.2 0 0 1 -2.2 -2.2v-1a2.2 2.2 0 0 0 -.64 -1.55l-.7 -.7a2.2 2.2 0 0 1 0 -3.12l.7 -.7a2.2 2.2 0 0 0 .64 -1.55v-1" /><path d="M9 12l2 2l4 -4" />',
  cloud: '<path d="M6.657 18c-2.572 0 -4.657 -2.007 -4.657 -4.483c0 -2.475 2.085 -4.482 4.657 -4.482c.393 -1.762 1.794 -3.2 3.675 -3.773c1.88 -.572 3.956 -.193 5.444 1c1.488 1.19 2.162 3.007 1.77 4.769h.99c1.913 0 3.464 1.56 3.464 3.486c0 1.927 -1.551 3.487 -3.465 3.487h-11.878" />',
  // A garage: roof, door and its panels (drawn here in Tabler's style).
  garage: '<path d="M3 21v-11l9 -6l9 6v11" /><path d="M6.5 21v-8.5h11v8.5" /><path d="M6.5 15.5h11" /><path d="M6.5 18.5h11" />',
  building: '<path d="M3 21l18 0" /><path d="M9 8l1 0" /><path d="M9 12l1 0" /><path d="M9 16l1 0" /><path d="M14 8l1 0" /><path d="M14 12l1 0" /><path d="M14 16l1 0" /><path d="M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16" />',
  calendar: '<path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z" /><path d="M16 3v4" /><path d="M8 3v4" /><path d="M4 11h16" /><path d="M11 15h1" /><path d="M12 15v3" />',
};

function icon(name, cls = "ico") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ICON_PATHS.tool}</svg>`;
}

// Item codes are shared by service history and CBS. Tints are CSS color names from style.css.
function itemStyle(code) {
  switch (Number(code)) {
    case 1: return { icon: "oilcan", tint: "orange" };
    case 2: case 6: return { icon: "brake", tint: "red" };
    case 3: return { icon: "droplet", tint: "red" };
    case 4: return { icon: "air-conditioning", tint: "teal" };
    case 5: return { icon: "propeller", tint: "teal" };
    case 10: return { icon: "bolt", tint: "yellow" };
    case 11: return { icon: "wind", tint: "teal" };
    case 12: return { icon: "gas-station", tint: "indigo" };
    case 0x0D: return { icon: "droplet-half", tint: "cyan" };
    case 0x11: case 100: return { icon: "tools", tint: "blue" };
    case 20: return { icon: "package", tint: "purple" };
    case 21: return { icon: "road", tint: "purple" };
    case 32: return { icon: "rosette-check", tint: "green" };
    case 33: return { icon: "cloud", tint: "green" };
    default: return { icon: "tool", tint: "gray" };
  }
}

// Record and item status: carried out, late, incomplete/overdue.
function statusTint(status) {
  return { 1: "green", 2: "orange" }[Number(status)] || "red";
}

// The item's icon on a tinted rounded square.
function itemIcon(code, size = "") {
  const s = itemStyle(code);
  return `<span class="icon-tile ${size}" style="--tint: var(--${s.tint})">${icon(s.icon)}</span>`;
}
