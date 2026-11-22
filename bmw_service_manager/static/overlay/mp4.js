// Reading MP4 and QuickTime (.mov) files in the browser, without loading them whole: GoPro and
// phone videos run to gigabytes. Only the boxes that describe the file (moov) are read; each
// sample (a video frame, a block of audio, a block of GoPro telemetry) is read from the file
// when it's wanted, with Blob.slice.
//
// Handles the plain (not fragmented) layout every camera and phone writes: a moov with each
// track's sample tables (stts, ctts, stsc, stsz, stco/co64, stss) and an edit list.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "dinf"]);

/** A four-character code from 4 bytes. */
const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Seconds from 1904-01-01 (QuickTime's epoch) to a Date; null for 0 (not set). */
function macDate(seconds) {
  if (!seconds) return null;
  return new Date(Date.UTC(1904, 0, 1) + seconds * 1000);
}

/** u64 as a Number (exact up to 2^53, plenty for offsets and durations). */
const u64 = (dv, o) => dv.getUint32(o) * 2 ** 32 + dv.getUint32(o + 4);

/** The top-level boxes of a file: [{type, start, size, header}], reading 16 bytes per box. */
async function topBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const dv = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = dv.getUint32(0), header = 8;
    const type = fourcc(dv, 4);
    if (size === 1) { size = u64(dv, 8); header = 16; } else if (size === 0) size = file.size - pos;
    if (size < header) throw new Error("This video file is damaged (a box of the wrong size).");
    boxes.push({ type, start: pos, size, header });
    pos += size;
  }
  return boxes;
}

/** The child boxes within bytes [start, end) of a DataView. */
function* children(dv, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos), header = 8;
    const type = fourcc(dv, pos + 4);
    if (size === 1) { size = u64(dv, pos + 8); header = 16; } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return;
    yield { type, start: pos, size, body: pos + header, end: pos + size };
    pos += size;
  }
}

/** A tree of the boxes in moov: {type, body, end, kids: [...]} with kids for containers. */
function tree(dv, start, end) {
  const out = [];
  for (const b of children(dv, start, end)) {
    if (CONTAINERS.has(b.type)) b.kids = tree(dv, b.body, b.end);
    else if (b.type === "meta") {
      // QuickTime's meta starts with its children; ISO's with 4 bytes of version and flags.
      const quicktime = fourcc(dv, b.body + 4) === "hdlr";
      b.kids = tree(dv, b.body + (quicktime ? 0 : 4), b.end);
    }
    out.push(b);
  }
  return out;
}

const find = (boxes, type) => boxes?.find((b) => b.type === type);
const path = (box, ...types) => types.reduce((b, t) => (b ? find(b.kids, t) : undefined), box);

/** One track's sample table, as plain arrays: offset, size, time (dts) and composition offset in the track's timescale. */
function sampleTable(dv, stbl) {
  const box = (t) => find(stbl.kids, t);
  // Sizes.
  let sizes;
  const stsz = box("stsz"), stz2 = box("stz2");
  if (stsz) {
    const fixed = dv.getUint32(stsz.body + 4), count = dv.getUint32(stsz.body + 8);
    sizes = new Uint32Array(count);
    if (fixed) sizes.fill(fixed);
    else for (let i = 0; i < count; i++) sizes[i] = dv.getUint32(stsz.body + 12 + 4 * i);
  } else if (stz2) {
    const field = dv.getUint8(stz2.body + 7), count = dv.getUint32(stz2.body + 8);
    sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      if (field === 16) sizes[i] = dv.getUint16(stz2.body + 12 + 2 * i);
      else if (field === 8) sizes[i] = dv.getUint8(stz2.body + 12 + i);
      else sizes[i] = (dv.getUint8(stz2.body + 12 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15;
    }
  } else sizes = new Uint32Array(0);
  const n = sizes.length;

  // Chunk offsets.
  let chunks = [];
  const stco = box("stco"), co64 = box("co64");
  if (stco) { const c = dv.getUint32(stco.body + 4); for (let i = 0; i < c; i++) chunks.push(dv.getUint32(stco.body + 8 + 4 * i)); }
  else if (co64) { const c = dv.getUint32(co64.body + 4); for (let i = 0; i < c; i++) chunks.push(u64(dv, co64.body + 8 + 8 * i)); }

  // Samples per chunk → each sample's offset.
  const offsets = new Float64Array(n);
  const stsc = box("stsc");
  if (stsc && chunks.length) {
    const entries = dv.getUint32(stsc.body + 4);
    const runs = [];
    for (let i = 0; i < entries; i++) {
      const o = stsc.body + 8 + 12 * i;
      runs.push([dv.getUint32(o) - 1, dv.getUint32(o + 4)]);
    }
    let s = 0;
    for (let r = 0; r < runs.length && s < n; r++) {
      const [first, per] = runs[r];
      const last = r + 1 < runs.length ? runs[r + 1][0] : chunks.length;
      for (let c = first; c < last && s < n; c++) {
        let pos = chunks[c];
        for (let k = 0; k < per && s < n; k++) { offsets[s] = pos; pos += sizes[s]; s++; }
      }
    }
  }

  // Times.
  const dts = new Float64Array(n), durations = new Float64Array(n);
  const stts = box("stts");
  if (stts) {
    const entries = dv.getUint32(stts.body + 4);
    let s = 0, t = 0;
    for (let i = 0; i < entries && s < n; i++) {
      const count = dv.getUint32(stts.body + 8 + 8 * i), delta = dv.getUint32(stts.body + 12 + 8 * i);
      for (let k = 0; k < count && s < n; k++) { dts[s] = t; durations[s] = delta; t += delta; s++; }
    }
  }
  const cts = new Float64Array(n);
  const ctts = box("ctts");
  if (ctts) {
    const version = dv.getUint8(ctts.body), entries = dv.getUint32(ctts.body + 4);
    let s = 0;
    for (let i = 0; i < entries && s < n; i++) {
      const count = dv.getUint32(ctts.body + 8 + 8 * i);
      const off = version ? dv.getInt32(ctts.body + 12 + 8 * i) : dv.getUint32(ctts.body + 12 + 8 * i);
      for (let k = 0; k < count && s < n; k++) cts[s++] = off;
    }
  }
  // Sync samples (key frames); without stss every sample is one.
  let keys = null;
  const stss = box("stss");
  if (stss) {
    const c = dv.getUint32(stss.body + 4);
    keys = new Set();
    for (let i = 0; i < c; i++) keys.add(dv.getUint32(stss.body + 8 + 4 * i) - 1);
  }
  return { n, sizes, offsets, dts, cts, durations, keys };
}

/** The sample description's first entry: {format, box: the whole entry, and the fields each kind needs}. */
function sampleEntry(dv, stbl, handler) {
  const stsd = find(stbl.kids, "stsd");
  if (!stsd) return null;
  const entry = children(dv, stsd.body + 8, stsd.end).next().value;
  if (!entry) return null;
  const out = { format: entry.type };
  if (handler === "vide") {
    out.width = dv.getUint16(entry.body + 24);
    out.height = dv.getUint16(entry.body + 26);
    for (const b of children(dv, entry.body + 78, entry.end)) {
      if (["avcC", "hvcC", "vpcC", "av1C"].includes(b.type)) {
        out.configType = b.type;
        out.config = new Uint8Array(dv.buffer, dv.byteOffset + b.body, b.end - b.body).slice();
      }
    }
  } else if (handler === "soun") {
    const version = dv.getUint16(entry.body + 8);
    out.channels = dv.getUint16(entry.body + 16);
    out.sampleRate = dv.getUint32(entry.body + 24) / 65536;
    const extra = version === 1 ? 16 : version === 2 ? 36 : 0;
    if (version === 2) { out.sampleRate = dv.getFloat64(entry.body + 32); out.channels = dv.getUint32(entry.body + 40); }
    for (const b of children(dv, entry.body + 28 + extra, entry.end)) {
      if (b.type === "esds") out.esds = esdsConfig(dv, b.body + 4, b.end);
      else if (b.type === "wave") {
        for (const w of children(dv, b.body, b.end)) if (w.type === "esds") out.esds = esdsConfig(dv, w.body + 4, w.end);
      }
    }
  }
  return out;
}

/** The AudioSpecificConfig (decoder-specific info, tag 5) in an esds's descriptors. */
function esdsConfig(dv, start, end) {
  let pos = start;
  const length = () => { let len = 0; for (let i = 0; i < 4; i++) { const b = dv.getUint8(pos++); len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return len; };
  let objectType = 0x40;
  while (pos < end) {
    const tag = dv.getUint8(pos++);
    const len = length();
    if (tag === 3) { const flags = dv.getUint8(pos + 2); pos += 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + dv.getUint8(pos + 3) : 0) + (flags & 0x20 ? 2 : 0); }
    else if (tag === 4) { objectType = dv.getUint8(pos); pos += 13; }
    else if (tag === 5) return { objectType, config: new Uint8Array(dv.buffer, dv.byteOffset + pos, len).slice() };
    else pos += len;
  }
  return { objectType, config: null };
}

/** The rotation (0, 90, 180, 270, clockwise) in a track header's matrix. */
function rotation(dv, tkhd) {
  const version = dv.getUint8(tkhd.body);
  const m = tkhd.body + (version ? 52 : 40);
  const a = dv.getInt32(m) / 65536, b = dv.getInt32(m + 4) / 65536;
  return ((Math.round(Math.atan2(b, a) * 180 / Math.PI) % 360) + 360) % 360;
}

/**
 * The file's tracks and when it was made. Each track: {id, handler ("vide", "soun", "meta"),
 * format ("avc1", "hvc1", "mp4a", "gpmd", …), timescale, duration (s), table, entry, rotation,
 * start (s: where the track's media starts in the movie, from the edit list)}.
 */
export async function readMp4(file) {
  const boxes = await topBoxes(file);
  const moovBox = boxes.find((b) => b.type === "moov");
  if (!moovBox) {
    if (boxes.some((b) => b.type === "moof")) throw new Error("This video is a fragmented MP4, which isn't supported yet.");
    throw new Error("This isn't an MP4 or MOV video (no moov box).");
  }
  if (moovBox.size > 512 * 1024 * 1024) throw new Error("This video's index is too big to read.");
  const buf = await file.slice(moovBox.start + moovBox.header, moovBox.start + moovBox.size).arrayBuffer();
  const dv = new DataView(buf);
  const moov = { kids: tree(dv, 0, buf.byteLength) };

  const mvhd = find(moov.kids, "mvhd");
  let created = null, movieScale = 1000, movieDuration = 0;
  if (mvhd) {
    const v = dv.getUint8(mvhd.body);
    created = macDate(v ? u64(dv, mvhd.body + 4) : dv.getUint32(mvhd.body + 4));
    movieScale = dv.getUint32(mvhd.body + (v ? 20 : 12));
    movieDuration = v ? u64(dv, mvhd.body + 24) : dv.getUint32(mvhd.body + 16);
  }

  const tracks = [];
  for (const trak of moov.kids.filter((b) => b.type === "trak")) {
    const tkhd = find(trak.kids, "tkhd"), mdhd = path(trak, "mdia", "mdhd"), hdlr = path(trak, "mdia", "hdlr");
    const stbl = path(trak, "mdia", "minf", "stbl");
    if (!tkhd || !mdhd || !hdlr || !stbl) continue;
    const tv = dv.getUint8(tkhd.body), mv = dv.getUint8(mdhd.body);
    const id = dv.getUint32(tkhd.body + (tv ? 20 : 12));
    const timescale = dv.getUint32(mdhd.body + (mv ? 20 : 12));
    const mediaDuration = mv ? u64(dv, mdhd.body + 24) : dv.getUint32(mdhd.body + 16);
    const handler = fourcc(dv, hdlr.body + 8);
    // The edit list: an empty edit first delays the track; a media time skips into it.
    let start = 0, skip = 0;
    const elst = path(trak, "edts", "elst");
    if (elst) {
      const ev = dv.getUint8(elst.body), count = dv.getUint32(elst.body + 4);
      let o = elst.body + 8;
      for (let i = 0; i < count; i++) {
        const dur = ev ? u64(dv, o) : dv.getUint32(o);
        const mediaTime = ev ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        o += ev ? 20 : 12;
        if (mediaTime === -1) start += dur / movieScale;
        else { skip = mediaTime / timescale; break; }
      }
    }
    const table = sampleTable(dv, stbl), entry = sampleEntry(dv, stbl, handler);
    tracks.push({
      id, handler, timescale, duration: mediaDuration / timescale, start, skip,
      table, entry, format: entry?.format,
      rotation: rotation(dv, tkhd),
    });
  }
  return { file, created, duration: movieDuration / movieScale, tracks };
}

/** A sample's bytes. */
export async function readSample(file, track, i) {
  const t = track.table;
  return new Uint8Array(await file.slice(t.offsets[i], t.offsets[i] + t.sizes[i]).arrayBuffer());
}

/**
 * Samples i0..i1-1 in as few reads as possible (they're usually side by side within a chunk):
 * calls `each(i, bytes)` in order. Reads up to `budget` bytes at once.
 */
export async function readSamples(file, track, i0, i1, each, budget = 8 * 1024 * 1024) {
  const t = track.table;
  let i = i0;
  while (i < i1) {
    let j = i + 1, end = t.offsets[i] + t.sizes[i];
    while (j < i1 && t.offsets[j] === end && end - t.offsets[i] + t.sizes[j] <= budget) { end += t.sizes[j]; j++; }
    const buf = new Uint8Array(await file.slice(t.offsets[i], end).arrayBuffer());
    for (let k = i; k < j; k++) {
      const o = t.offsets[k] - t.offsets[i];
      await each(k, buf.subarray(o, o + t.sizes[k]));
    }
    i = j;
  }
}

/** A sample's presentation time in the movie, seconds. */
export function sampleTime(track, i) {
  const t = track.table;
  return track.start + (t.dts[i] + t.cts[i]) / track.timescale - track.skip;
}

/** The codec string WebCodecs wants for a video track (from its avcC / hvcC), or null. */
export function videoCodec(track) {
  const e = track.entry, c = e?.config;
  if (!c) return null;
  const hex = (v) => v.toString(16).padStart(2, "0");
  if (e.configType === "avcC") return `avc1.${hex(c[1])}${hex(c[2])}${hex(c[3])}`;
  if (e.configType === "hvcC") {
    // hvc1.<profile space+idc>.<compat flags reversed, hex>.<tier><level>.<constraint bytes>
    const space = ["", "A", "B", "C"][c[1] >> 6], tier = (c[1] >> 5) & 1, idc = c[1] & 31;
    let flags = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = (rev << 1) | (flags & 1); flags >>>= 1; }
    const level = c[12];
    const cons = [c[6], c[7], c[8], c[9], c[10], c[11]];
    while (cons.length && cons.at(-1) === 0) cons.pop();
    const tail = cons.map((b) => b.toString(16).toUpperCase()).join(".");
    return `${e.format}.${space}${idc}.${(rev >>> 0).toString(16).toUpperCase()}.${tier ? "H" : "L"}${level}${tail ? "." + tail : ""}`;
  }
  if (e.configType === "vpcC") return `vp09.${hex(c[4])}.${hex(c[5])}.${hex(c[6] >> 4)}`;
  if (e.configType === "av1C") {
    const profile = c[1] >> 5, level = c[1] & 31, tier = c[2] >> 7, bits = (c[2] >> 6) & 1 ? ((c[2] >> 5) & 1 ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, "0")}${tier ? "H" : "M"}.${String(bits).padStart(2, "0")}`;
  }
  return null;
}
