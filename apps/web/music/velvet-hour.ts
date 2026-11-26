// "Velvet Hour": Card Flex's background music, composed for the game.
// A late-night casino lounge in A minor at 86 BPM: electric-piano chords over a
// warm bass and soft swung drums, a low pad, and in the second half a bell
// melody with a harmonic-minor edge. 16 bars (~45 s), looped.
//
// This file is the score + synthesis (Web Audio). It is NOT bundled into the
// app: `pnpm --filter @card-flex/web render-music` renders it once in headless
// Chrome and encodes public/music/velvet-hour.{ogg,m4a}, which lib/music.ts plays.

const BPM = 86;
const BEAT = 60 / BPM;
const BAR = 4 * BEAT;
const BARS = 16;
export const LOOP_SECS = BARS * BAR;
export const BAR_SECS = BAR;
/** Rendered before the loop so reverb and echo tails wrap round seamlessly. */
const LEAD_BARS = 2;

/** Seeded random numbers: every render gives the same take. */
let rngState = 20261126;
const rand = () => (rngState = (rngState * 16807) % 2147483647) / 2147483647;

const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
/** Swung eighths: the off-beat "and" comes a little late. */
const sw = (beat: number) => (beat % 1 === 0.5 ? Math.floor(beat) + 0.58 : beat);

// bass root (MIDI) and electric-piano voicing for each of the 8 bars (played twice)
const CHORDS: { root: number; keys: number[] }[] = [
  { root: 45, keys: [60, 64, 67, 71] }, // Am9
  { root: 41, keys: [57, 60, 64, 71] }, // Fmaj7#11
  { root: 38, keys: [53, 57, 60, 64] }, // Dm9
  { root: 40, keys: [56, 62, 65, 71] }, // E7b9
  { root: 45, keys: [60, 64, 67, 71] }, // Am9
  { root: 41, keys: [57, 60, 64, 69] }, // Fmaj7
  { root: 47, keys: [57, 62, 65, 69] }, // Bm7b5
  { root: 40, keys: [56, 62, 67, 71] }, // E7#9
];

// bell melody in bars 8-15: [bar, beat, midi, beats]
const MELODY: [number, number, number, number][] = [
  [8, 0.5, 76, 1], [8, 1.5, 81, 0.5], [8, 2, 79, 0.5], [8, 2.5, 76, 1.5],
  [9, 0.5, 83, 0.5], [9, 1, 81, 0.5], [9, 1.5, 76, 2],
  [10, 0.5, 77, 0.5], [10, 1, 76, 0.5], [10, 1.5, 74, 0.5], [10, 2, 72, 1.5],
  [11, 0, 71, 1], [11, 1, 68, 0.5], [11, 1.5, 71, 0.5], [11, 2, 74, 0.5], [11, 2.5, 77, 1.5],
  [12, 0.5, 76, 0.5], [12, 1, 84, 1], [12, 2, 83, 0.5], [12, 2.5, 81, 1.5],
  [13, 0.5, 79, 0.5], [13, 1, 76, 1.5], [13, 2.5, 72, 1],
  [14, 0, 74, 0.5], [14, 0.5, 77, 0.5], [14, 1, 81, 1], [14, 2.5, 80, 1],
  [15, 0, 83, 0.5], [15, 0.5, 80, 0.5], [15, 1, 76, 2],
];

type Out = AudioNode;

function env(g: GainNode, t: number, peak: number, attack: number, decayTo: number, decay: number, end: number, release: number) {
  const p = g.gain;
  p.setValueAtTime(0.0001, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.exponentialRampToValueAtTime(Math.max(0.0001, decayTo), t + attack + decay);
  p.setValueAtTime(Math.max(0.0001, decayTo), Math.max(t + attack + decay, end));
  p.exponentialRampToValueAtTime(0.0001, Math.max(t + attack + decay, end) + release);
}

/** Electric piano: two-operator FM (soft bark on the attack) plus a short tine. */
function keys(c: BaseAudioContext, out: Out, t: number, m: number, vel: number, dur: number) {
  const f = hz(m);
  const car = c.createOscillator();
  const mod = c.createOscillator();
  const idx = c.createGain();
  const amp = c.createGain();
  const pan = c.createStereoPanner();
  car.frequency.value = f;
  mod.frequency.value = f;
  idx.gain.setValueAtTime(f * 1.9 * vel, t);
  idx.gain.exponentialRampToValueAtTime(f * 0.18, t + 0.45);
  mod.connect(idx).connect(car.frequency);
  env(amp, t, 0.16 * vel, 0.004, 0.05 * vel, 1.1, t + dur, 0.35);
  pan.pan.value = Math.max(-0.5, Math.min(0.5, (m - 62) / 22));
  car.connect(amp).connect(pan).connect(out);
  const tine = c.createOscillator();
  const tg = c.createGain();
  tine.frequency.value = f * 4.01;
  env(tg, t, 0.025 * vel, 0.002, 0.0002, 0.12, t + 0.12, 0.02);
  tine.connect(tg).connect(pan);
  const stop = t + dur + 0.5;
  for (const o of [car, mod, tine]) {
    o.start(t);
    o.stop(stop);
  }
}

/** Round, warm bass: sine + triangle through a low-pass. */
function bass(c: BaseAudioContext, out: Out, t: number, m: number, vel: number, dur: number) {
  const f = hz(m);
  const a = c.createOscillator();
  const b = c.createOscillator();
  const lp = c.createBiquadFilter();
  const amp = c.createGain();
  a.frequency.value = f;
  b.type = "triangle";
  b.frequency.value = f;
  lp.type = "lowpass";
  lp.frequency.value = 520;
  env(amp, t, 0.5 * vel, 0.008, 0.22 * vel, 0.5, t + dur, 0.12);
  a.connect(amp);
  b.connect(lp).connect(amp);
  amp.connect(out);
  for (const o of [a, b]) {
    o.start(t);
    o.stop(t + dur + 0.2);
  }
}

/** Bell: a sine with inharmonic partials, long ring. */
function bell(c: BaseAudioContext, out: Out, t: number, m: number, dur: number) {
  const f = hz(m);
  const parts: [number, number, number][] = [
    [1, 0.11, 2.2],
    [2.76, 0.03, 0.9],
    [5.4, 0.012, 0.35],
  ];
  for (const [r, g, d] of parts) {
    const o = c.createOscillator();
    const amp = c.createGain();
    o.frequency.value = f * r;
    env(amp, t, g, 0.003, g * 0.15, d, t + Math.max(d, dur * 0.6), 0.6);
    o.connect(amp).connect(out);
    o.start(t);
    o.stop(t + Math.max(d, dur * 0.6) + d + 0.8);
  }
}

/** Pad: detuned saws through a low-pass, slow swell. */
function pad(c: BaseAudioContext, out: Out, t: number, m: number, dur: number) {
  const lp = c.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 700;
  lp.Q.value = 0.4;
  const amp = c.createGain();
  env(amp, t, 0.022, 1.2, 0.018, 0.6, t + dur - 0.6, 1.2);
  lp.connect(amp).connect(out);
  for (const cents of [-8, 8]) {
    const o = c.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = hz(m);
    o.detune.value = cents;
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 1.4);
  }
}

function noiseBuffer(c: BaseAudioContext) {
  const len = Math.floor(c.sampleRate * 0.5);
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  let seed = 7;
  for (let i = 0; i < len; i++) {
    seed = (seed * 16807) % 2147483647; // fixed seed: the same take every time
    d[i] = (seed / 2147483647) * 2 - 1;
  }
  return b;
}

function noiseHit(c: BaseAudioContext, out: Out, noise: AudioBuffer, t: number, type: BiquadFilterType, freq: number, q: number, gain: number, decay: number) {
  const s = c.createBufferSource();
  const f = c.createBiquadFilter();
  const amp = c.createGain();
  s.buffer = noise;
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  env(amp, t, gain, 0.002, 0.0001, decay, t + decay, 0.01);
  s.connect(f).connect(amp).connect(out);
  s.start(t, rand() * 0.3, decay + 0.05);
}

function kick(c: BaseAudioContext, out: Out, t: number, vel: number) {
  const o = c.createOscillator();
  const amp = c.createGain();
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  env(amp, t, 0.6 * vel, 0.003, 0.0001, 0.38, t + 0.38, 0.02);
  o.connect(amp).connect(out);
  o.start(t);
  o.stop(t + 0.45);
}

/** Stereo reverb impulse: decaying noise, darker as it fades. */
function impulse(c: BaseAudioContext, secs: number) {
  const len = Math.floor(c.sampleRate * secs);
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      const k = 0.25 + 0.7 * x; // more smoothing (darker) later in the tail
      lp = lp * k + (rand() * 2 - 1) * (1 - k);
      d[i] = lp * Math.pow(1 - x, 2.4) * 2.2;
    }
  }
  return b;
}

/** Schedules one pass of the 16 bars starting at time `t0`; bars before `fromBar` are skipped. */
function schedule(c: BaseAudioContext, bus: Record<"keys" | "bass" | "drums" | "bell" | "pad", AudioNode>, noise: AudioBuffer, t0: number, fromBar = 0) {
  const at = (bar: number, beat: number) => t0 + (bar - fromBar) * BAR + sw(beat) * BEAT;
  for (let bar = fromBar; bar < BARS; bar++) {
    const ch = CHORDS[bar % 8];
    const next = CHORDS[(bar + 1) % 8];
    // electric piano comping
    const hits: [number, number, number][] = bar % 2 === 0 ? [[0, 0.9, 1.4], [1.5, 0.5, 0.4], [2.5, 0.72, 1.4]] : [[0, 0.85, 3.2], [3.5, 0.5, 0.5]];
    for (const [beat, vel, len] of hits) ch.keys.forEach((m, i) => keys(c, bus.keys, at(bar, beat) + i * 0.012, m, vel * (i === ch.keys.length - 1 ? 1 : 0.85), len * BEAT));
    // pad under the whole bar
    for (const m of ch.keys.slice(0, 3)) pad(c, bus.pad, at(bar, 0), m - 12, BAR);
    // bass: root, a pushed root, the fifth, then a step into the next chord
    const approach = next.root + (next.root > ch.root ? -1 : 1);
    bass(c, bus.bass, at(bar, 0), ch.root, 1, BEAT * 1.2);
    bass(c, bus.bass, at(bar, 1.5), ch.root, 0.6, BEAT * 0.4);
    bass(c, bus.bass, at(bar, 2), ch.root + 7, 0.8, BEAT * 0.9);
    bass(c, bus.bass, at(bar, 3.5), approach, 0.7, BEAT * 0.4);
    // drums: soft boom-bap with swung hats
    kick(c, bus.drums, at(bar, 0), 1);
    kick(c, bus.drums, at(bar, 2.5), 0.8);
    if (bar % 4 === 3) kick(c, bus.drums, at(bar, 3.5), 0.5);
    for (const beat of [1, 3]) {
      noiseHit(c, bus.drums, noise, at(bar, beat), "bandpass", 1900, 0.8, 0.32, 0.16);
      noiseHit(c, bus.drums, noise, at(bar, beat), "lowpass", 260, 1, 0.12, 0.08);
    }
    if (bar % 8 === 7) for (const beat of [3.5, 3.75]) noiseHit(c, bus.drums, noise, at(bar, beat), "bandpass", 2100, 0.9, 0.12, 0.08);
    for (let e = 0; e < 8; e++) noiseHit(c, bus.drums, noise, at(bar, e / 2), "highpass", 7200, 0.7, e % 2 ? 0.05 : 0.09, e % 2 ? 0.035 : 0.05);
  }
  for (const [bar, beat, m, len] of MELODY) if (bar >= fromBar) bell(c, bus.bell, at(bar, beat), m, len * BEAT);
}

export async function renderTheme(sampleRate = 44100): Promise<AudioBuffer> {
  rngState = 20261126;
  const lead = LEAD_BARS * BAR;
  const c = new OfflineAudioContext(2, Math.ceil((lead + LOOP_SECS) * sampleRate), sampleRate);
  const master = c.createGain();
  master.gain.value = 0.8;
  const warm = c.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 9000;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.25;
  master.connect(warm).connect(comp).connect(c.destination);

  const verb = c.createConvolver();
  verb.buffer = impulse(c, 2.4);
  const verbOut = c.createGain();
  verbOut.gain.value = 0.55;
  verb.connect(verbOut).connect(master);
  // a dotted-eighth echo for the bells
  const echo = c.createDelay(2);
  echo.delayTime.value = BEAT * 0.75;
  const fb = c.createGain();
  fb.gain.value = 0.32;
  const echoTone = c.createBiquadFilter();
  echoTone.type = "lowpass";
  echoTone.frequency.value = 2800;
  echo.connect(echoTone).connect(fb).connect(echo);
  echoTone.connect(verb);
  echoTone.connect(master);

  const busOf = (gain: number, wet: number, toEcho = false) => {
    const g = c.createGain();
    g.gain.value = gain;
    g.connect(master);
    const w = c.createGain();
    w.gain.value = wet;
    g.connect(w).connect(verb);
    if (toEcho) g.connect(echo);
    return g;
  };
  const bus = {
    keys: busOf(0.6, 0.35),
    bass: busOf(0.75, 0.05),
    drums: busOf(0.5, 0.12),
    bell: busOf(0.5, 0.6, true),
    pad: busOf(0.45, 0.5),
  };
  const noise = noiseBuffer(c);
  // the loop's last bars first (their tails become the loop's start), then the full pass
  schedule(c, bus, noise, 0, BARS - LEAD_BARS);
  schedule(c, bus, noise, lead);
  const full = await c.startRendering();

  // keep the loop, normalised so it never clips
  const start = Math.round(lead * sampleRate);
  const len = Math.round(LOOP_SECS * sampleRate);
  const out = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate });
  let peak = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = full.getChannelData(ch).subarray(start, start + len);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    out.copyToChannel(d, ch);
  }
  const k = peak > 0 ? 0.89 / peak : 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
  return out;
}
