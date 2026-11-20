"use client";
// Small synthesized sound effects (Web Audio; no audio files).
import { readSettings } from "./settings";

let ctx: AudioContext | null = null;
function tone(freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 0.08) {
  ctx ??= new AudioContext();
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

export type Sfx = "turn" | "chip" | "deal" | "win" | "lose";
export function play(s: Sfx) {
  if (typeof window === "undefined" || !readSettings().sound) return;
  try {
    if (s === "turn") { tone(880, 0, 0.12); tone(1320, 0.12, 0.18); }
    if (s === "chip") { tone(2400, 0, 0.04, "triangle", 0.05); tone(1800, 0.05, 0.05, "triangle", 0.04); }
    if (s === "deal") { [0, 0.07, 0.14].forEach((t) => tone(500, t, 0.05, "square", 0.025)); }
    if (s === "win") { [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.25, "triangle", 0.07)); }
    if (s === "lose") { tone(330, 0, 0.18, "sawtooth", 0.03); tone(247, 0.16, 0.3, "sawtooth", 0.03); }
  } catch { /* audio blocked until the first click */ }
}
