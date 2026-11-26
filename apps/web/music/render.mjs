// Renders music/velvet-hour.ts in headless Chrome (Web Audio's
// OfflineAudioContext) and encodes public/music/velvet-hour.{ogg,m4a}.
// Needs google-chrome (or $CHROME) and ffmpeg. Usage:
//   pnpm --filter @card-flex/web render-music
// The file = [last bar of the loop] + [loop] + [first second of the loop], so
// the player can loop between two marks whatever start padding a decoder keeps.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "../e2e/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "music");
const RATE = 44100;
const score = stripTypeScriptTypes(readFileSync(join(here, "velvet-hour.ts"), "utf8")).replace(/^export /gm, "");

const b = await launch(9420);
try {
  const p = await b.page("render");
  await p.eval(`(() => { ${score}\n window.__score = { renderTheme, BAR_SECS, LOOP_SECS }; })()`);
  const r = await p.eval(`(async () => {
    const { renderTheme, BAR_SECS } = window.__score;
    const loop = await renderTheme(${RATE});
    const n = loop.length, bar = Math.round(BAR_SECS * ${RATE}), tail = ${RATE};
    const chans = [0, 1].map((ch) => {
      const d = loop.getChannelData(ch), o = new Float32Array(bar + n + tail);
      o.set(d.subarray(n - bar), 0); o.set(d, bar); o.set(d.subarray(0, tail), bar + n);
      return o;
    });
    const len = chans[0].length, pcm = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) for (let ch = 0; ch < 2; ch++) pcm[i * 2 + ch] = Math.max(-1, Math.min(1, chans[ch][i])) * 32767;
    const u8 = new Uint8Array(pcm.buffer); let bin = "";
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    return { pcm: btoa(bin), secs: len / ${RATE} };
  })()`);
  const tmp = mkdtempSync(join(tmpdir(), "cf-music-"));
  const raw = join(tmp, "velvet-hour.s16le");
  writeFileSync(raw, Buffer.from(r.pcm, "base64"));
  mkdirSync(out, { recursive: true });
  const input = ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "2", "-i", raw];
  execFileSync("ffmpeg", [...input, "-c:a", "libopus", "-b:a", "96k", join(out, "velvet-hour.ogg")]);
  execFileSync("ffmpeg", [...input, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(out, "velvet-hour.m4a")]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`rendered ${r.secs.toFixed(2)} s -> public/music/velvet-hour.{ogg,m4a}`);
} finally {
  b.close();
}
