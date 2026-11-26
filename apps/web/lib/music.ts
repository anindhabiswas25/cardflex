"use client";
// Background music: "Velvet Hour" (score in music/velvet-hour.ts, rendered to
// public/music by `pnpm --filter @card-flex/web render-music`). Decoded with
// Web Audio and looped sample-accurately between two marks. The file holds one
// bar before the loop and a second after it, so the loop stays seamless however
// much start padding a browser's decoder keeps.
import { audioCtx } from "./audio";

const BAR_SECS = (4 * 60) / 86; // must match music/velvet-hour.ts
const LOOP_SECS = 16 * BAR_SECS;
const VOLUME = 0.3;

let theme: Promise<AudioBuffer> | null = null;
let src: AudioBufferSourceNode | null = null;
let gain: GainNode | null = null;
let wanted = false;

function load(c: AudioContext) {
  const ogg = typeof Audio !== "undefined" && new Audio().canPlayType('audio/ogg; codecs="opus"') !== "";
  const url = ogg ? "/music/velvet-hour.ogg" : "/music/velvet-hour.m4a";
  return fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`music ${r.status}`);
      return r.arrayBuffer();
    })
    .then((b) => c.decodeAudioData(b));
}

export async function startMusic() {
  wanted = true;
  const c = audioCtx();
  if (!c || src) return;
  theme ??= load(c).catch((e) => {
    theme = null; // try again next time
    throw e;
  });
  let b: AudioBuffer;
  try {
    b = await theme;
  } catch {
    return;
  }
  if (!wanted || src) return;
  gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, c.currentTime);
  gain.gain.exponentialRampToValueAtTime(VOLUME, c.currentTime + 3);
  src = c.createBufferSource();
  src.buffer = b;
  src.loop = true;
  src.loopStart = BAR_SECS;
  src.loopEnd = BAR_SECS + LOOP_SECS;
  src.connect(gain).connect(c.destination);
  src.start(c.currentTime, BAR_SECS);
}

export function stopMusic() {
  wanted = false;
  const c = audioCtx();
  if (!c || !src || !gain) return;
  const s = src;
  const g = gain;
  src = null;
  gain = null;
  g.gain.cancelScheduledValues(c.currentTime);
  g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.8);
  s.stop(c.currentTime + 0.85);
}
