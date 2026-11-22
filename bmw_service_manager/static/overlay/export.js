// Burning the overlay into the video, in the browser with WebCodecs: each frame is decoded from
// the file, drawn with the overlay on a canvas, encoded as H.264, and written to a new MP4 with
// the video's own sound copied across untouched. Nothing leaves the computer.
//
// Where the browser can write straight to a file (Chrome, Edge: the File System Access API), the
// MP4 is streamed to disk as it's made, so a long 4K video doesn't have to fit in memory; other
// browsers build it in memory and download it at the end.

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from "../vendor/mp4-muxer.mjs";
import { readSamples, sampleTime, videoCodec } from "./mp4.js";

/** Whether this browser can export at all. */
export const canExport = () => typeof VideoDecoder !== "undefined" && typeof VideoEncoder !== "undefined";

/** The video track's frame rate (frames a second), from its sample times. */
export function frameRate(track) {
  const t = track.table;
  if (t.n < 2) return 30;
  return (t.n - 1) / ((t.dts[t.n - 1] - t.dts[0]) / track.timescale);
}

/** The exported frame's size: upright (rotation applied), no taller than maxHeight, even numbers. */
export function outputSize(track, maxHeight) {
  const { width, height } = track.entry;
  let w = width, h = height;
  if (track.rotation === 90 || track.rotation === 270) [w, h] = [h, w];
  const short = Math.min(w, h);
  const k = maxHeight && short > maxHeight ? maxHeight / short : 1;
  return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}

/** The first H.264 (or other) setup the browser will encode at this size: {config, muxCodec}. */
async function encoderConfig(width, height, fps, bitrate) {
  const base = { width, height, bitrate, framerate: fps, latencyMode: "quality", bitrateMode: "variable" };
  // High profile, levels 4.0 (1080p) to 6.2 (8K).
  for (const level of ["28", "2a", "32", "33", "34", "3c", "3d", "3e"]) {
    for (const hw of ["prefer-hardware", "no-preference"]) {
      const config = { ...base, codec: `avc1.6400${level}`, avc: { format: "avc" }, hardwareAcceleration: hw };
      try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, muxCodec: "avc" }; } catch { /* next */ }
    }
  }
  const hevc = { ...base, codec: "hvc1.1.6.L153.B0", hevc: { format: "hevc" } };
  try { if ((await VideoEncoder.isConfigSupported(hevc)).supported) return { config: hevc, muxCodec: "hevc" }; } catch { /* none */ }
  return null;
}

/** How the video will decode here, or a sentence saying why it won't. */
export async function decoderConfig(track) {
  const codec = videoCodec(track);
  if (!codec) return { error: `This browser can't read ${track.format} video.` };
  const config = { codec, description: track.entry.config, codedWidth: track.entry.width, codedHeight: track.entry.height };
  try {
    if ((await VideoDecoder.isConfigSupported(config)).supported) return { config };
  } catch { /* below */ }
  const name = codec.startsWith("hvc") || codec.startsWith("hev") ? "HEVC (H.265)" : codec;
  return { error: `This browser can't decode ${name} video. Try Chrome or Safari on a Mac, or Edge on Windows with the HEVC extension.` };
}

/**
 * Exports video time [t0, t1] with `draw(g, W, H, videoTime)` drawing the overlay on each frame.
 * opts: {maxHeight, quality (bits per pixel per frame), handle (a FileSystemFileHandle, optional),
 * onProgress(fraction, frames), signal (AbortSignal)}. Returns a Blob when there's no handle.
 */
export async function exportVideo(mp4, t0, t1, draw, opts = {}) {
  const video = mp4.tracks.find((t) => t.handler === "vide");
  if (!video) throw new Error("This file has no video track.");
  const dec = await decoderConfig(video);
  if (dec.error) throw new Error(dec.error);
  const fps = frameRate(video);
  const [W, H] = outputSize(video, opts.maxHeight);
  const bitrate = Math.round(W * H * Math.min(fps, 60) * (opts.quality ?? 0.12));
  const enc = await encoderConfig(W, H, fps, bitrate);
  if (!enc) throw new Error(`This browser can't encode H.264 at ${W} × ${H}. Try a smaller size.`);

  // Sound: AAC copied across as it is.
  const audio = mp4.tracks.find((t) => t.handler === "soun" && t.format === "mp4a" && t.entry?.esds?.config);
  const writable = opts.handle ? await opts.handle.createWritable() : null;
  const target = writable ? new FileSystemWritableFileStreamTarget(writable) : new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: writable ? false : "in-memory",
    firstTimestampBehavior: "cross-track-offset",
    video: { codec: enc.muxCodec, width: W, height: H, frameRate: Math.round(fps * 1000) / 1000 },
    audio: audio ? { codec: "aac", numberOfChannels: audio.entry.channels, sampleRate: audio.entry.sampleRate } : undefined,
  });

  // The frames to decode: from the key frame before t0 to the first frame after t1 (in decode order).
  const tab = video.table;
  const order = Array.from({ length: tab.n }, (_, i) => i);
  let first = order.findIndex((i) => sampleTime(video, i) >= t0 - 1e-6);
  if (first < 0) first = tab.n - 1;
  let k0 = first;
  while (k0 > 0 && !(tab.keys ? tab.keys.has(k0) : true)) k0--;
  let k1 = k0;
  while (k1 < tab.n && tab.dts[k1] / video.timescale + video.start - video.skip <= t1 + 1) k1++;
  const expected = order.slice(k0, k1).filter((i) => { const t = sampleTime(video, i); return t >= t0 - 1e-6 && t < t1 - 1e-6; }).length;

  const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(W, H) : Object.assign(document.createElement("canvas"), { width: W, height: H });
  const g = canvas.getContext("2d");
  const rot = video.rotation;

  let error = null, written = 0, audioNext = 0;
  const audioSamples = [];
  if (audio) {
    for (let i = 0; i < audio.table.n; i++) {
      const t = sampleTime(audio, i);
      if (t >= t0 - 0.05 && t < t1) audioSamples.push(i);
    }
  }
  const audioMeta = audio ? { decoderConfig: { codec: `mp4a.40.${audio.entry.esds.config[0] >> 3}`, numberOfChannels: audio.entry.channels, sampleRate: audio.entry.sampleRate, description: audio.entry.esds.config } } : null;
  // The sound up to time t (video's), read a batch at a time.
  const pendingAudio = [];
  const feedAudio = (upTo) => {
    while (pendingAudio.length && pendingAudio[0].t <= upTo) {
      const a = pendingAudio.shift();
      muxer.addAudioChunkRaw(a.bytes, "key", Math.max(0, (a.t - t0) * 1e6), a.dur * 1e6, audioNext++ === 0 ? audioMeta : undefined);
    }
  };
  let audioRead = 0;
  const readAudioUntil = async (upTo) => {
    if (!audio) return;
    while (audioRead < audioSamples.length && sampleTime(audio, audioSamples[audioRead]) <= upTo + 1) {
      const end = Math.min(audioSamples.length, audioRead + 256);
      const i0 = audioSamples[audioRead], i1 = audioSamples[end - 1] + 1;
      await readSamples(mp4.file, audio, i0, i1, (i, bytes) => {
        pendingAudio.push({ t: sampleTime(audio, i), dur: audio.table.durations[i] / audio.timescale, bytes: bytes.slice() });
      });
      audioRead = end;
    }
  };

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      feedAudio(t0 + chunk.timestamp / 1e6);
      muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, chunk.duration ?? 1e6 / fps, meta);
    },
    error: (e) => { error = e; },
  });
  encoder.configure(enc.config);
  const keyEvery = Math.max(1, Math.round(fps * 2));

  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      if (error || t < t0 - 1e-6 || t >= t1 - 1e-6) { frame.close(); return; }
      g.save();
      if (rot === 90) { g.translate(W, 0); g.rotate(Math.PI / 2); g.drawImage(frame, 0, 0, H, W); }
      else if (rot === 180) { g.translate(W, H); g.rotate(Math.PI); g.drawImage(frame, 0, 0, W, H); }
      else if (rot === 270) { g.translate(0, H); g.rotate(-Math.PI / 2); g.drawImage(frame, 0, 0, H, W); }
      else g.drawImage(frame, 0, 0, W, H);
      g.restore();
      const duration = frame.duration ?? 1e6 / fps;
      frame.close();
      try { draw(g, W, H, t); } catch (e) { error = e; return; }
      const out = new VideoFrame(canvas, { timestamp: Math.round((t - t0) * 1e6), duration });
      encoder.encode(out, { keyFrame: written % keyEvery === 0 });
      out.close();
      written++;
      opts.onProgress?.(Math.min(1, written / Math.max(1, expected)), written);
    },
    error: (e) => { error = e; },
  });
  decoder.configure({ ...dec.config, optimizeForLatency: false });

  const waitQueues = async () => {
    while (!error && (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 6)) {
      await new Promise((r) => setTimeout(r, 4));
    }
  };
  const ptsOffset = video.start - video.skip; // presentation time = cts/timescale + this
  try {
    await readSamples(mp4.file, video, k0, k1, async (i, bytes) => {
      if (error) throw error;
      if (opts.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      await waitQueues();
      const pts = (tab.dts[i] + tab.cts[i]) / video.timescale + ptsOffset;
      await readAudioUntil(pts);
      decoder.decode(new EncodedVideoChunk({
        type: !tab.keys || tab.keys.has(i) ? "key" : "delta",
        timestamp: Math.round(pts * 1e6),
        duration: Math.round(tab.durations[i] / video.timescale * 1e6),
        data: bytes,
      }));
    }, 16 * 1024 * 1024);
    await decoder.flush();
    await encoder.flush();
    if (error) throw error;
    await readAudioUntil(t1 + 1);
    feedAudio(t1 + 1);
    muxer.finalize();
    if (writable) { await writable.close(); return null; }
    return new Blob([target.buffer], { type: "video/mp4" });
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch { /* closed */ } }
    throw error || e;
  } finally {
    if (decoder.state !== "closed") decoder.close();
    if (encoder.state !== "closed") encoder.close();
  }
}
