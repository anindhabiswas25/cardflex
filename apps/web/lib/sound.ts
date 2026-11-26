"use client";
// Small synthesized sound effects (Web Audio; no audio files). They share the
// context in lib/audio.ts, which is unlocked by the player's first tap.
import { audioCtx } from "./audio";
import { readSettings } from "./settings";

function tone(freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 0.08) {
  const ctx = audioCtx();
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + at);
  g.gain.linearRampToValueAtTime(gain, ctx.currentTime + at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + at);
  o.stop(ctx.currentTime + at + dur + 0.02);
}

/** A card sliding off the deck: a short band-passed noise "flick". */
function flick(at: number, gain = 0.22) {
  const ctx = audioCtx();
  if (!ctx) return;
  const len = Math.floor(ctx.sampleRate * 0.09);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = buf;
  bp.type = "bandpass";
  bp.frequency.value = 2600 + Math.random() * 900;
  bp.Q.value = 0.9;
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(ctx.currentTime + at);
}

/** A button press: a soft wooden "tok" (quick falling sine + a tiny click). */
function tap() {
  const ctx = audioCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(900, t);
  o.frequency.exponentialRampToValueAtTime(380, t + 0.05);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.11, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + 0.08);
  flick(0, 0.05);
}

/** Deal timing, shared with the table's fly-in animation so sound and cards match. */
export const DEAL_LEAD_MS = 250;
export const DEAL_STEP_MS = 160;

export type Sfx = "turn" | "chip" | "deal" | "win" | "lose" | "tap";
/** `n`: for "deal", how many players are dealt in (3 cards each, round the table). */
export function play(s: Sfx, n = 1) {
  if (typeof window === "undefined" || !readSettings().sound) return;
  try {
    if (s === "turn") { tone(880, 0, 0.12); tone(1320, 0.12, 0.18); }
    if (s === "chip") { tone(2400, 0, 0.04, "triangle", 0.05); tone(1800, 0.05, 0.05, "triangle", 0.04); }
    if (s === "deal") { for (let i = 0; i < 3 * Math.max(1, n); i++) flick((DEAL_LEAD_MS + i * DEAL_STEP_MS + 180) / 1000); }
    if (s === "win") { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.09, 0.3, "triangle", 0.07)); [0.5, 0.62, 0.74].forEach((t) => tone(2093, t, 0.12, "sine", 0.03)); }
    if (s === "tap") tap();
    if (s === "lose") { tone(330, 0, 0.18, "sawtooth", 0.03); tone(247, 0.16, 0.3, "sawtooth", 0.03); }
  } catch { /* audio blocked until the first click */ }
}
