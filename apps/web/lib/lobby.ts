// The tables shown in the lobby. Names, tiers and colours are display-only;
// everything else (boot, buy-in, seats, players, stacks) is read on chain.
// Operators add a table here after `cf-admin table create` + `table open`
// + `table keeper` (docs/runbooks).
import lobby from "../lobby.json";

export type Tone = { a: string; b: string; c: string; glow: string };
export type LobbyMeta = { config: string; name: string; tier: string; tone?: keyof typeof TONES; hot?: boolean };

export const TONES = {
  violet: { a: "#f0abfc", b: "#c026d3", c: "#581c87", glow: "217 70 239" },
  ember: { a: "#fdba74", b: "#f43f5e", c: "#7f1d1d", glow: "249 115 22" },
  moon: { a: "#a5b4fc", b: "#4f46e5", c: "#1e1b4b", glow: "99 102 241" },
  gold: { a: "#fde68a", b: "#d97706", c: "#78350f", glow: "251 191 36" },
  neon: { a: "#bef264", b: "#16a34a", c: "#14532d", glow: "132 204 22" },
  velvet: { a: "#f9a8d4", b: "#db2777", c: "#500724", glow: "236 72 153" },
} satisfies Record<string, Tone>;

export const LOBBY: LobbyMeta[] = lobby as LobbyMeta[];

const TONE_KEYS = Object.keys(TONES) as (keyof typeof TONES)[];
/** Display data for any table address (lobby entry, or a stable default). */
export function metaFor(config: string): LobbyMeta & { toneValue: Tone } {
  const m = LOBBY.find((x) => x.config === config);
  const h = [...config].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tone = m?.tone ?? TONE_KEYS[h % TONE_KEYS.length];
  return { config, name: m?.name ?? `Table ${config.slice(0, 4)}`, tier: m?.tier ?? "Table", tone, hot: m?.hot, toneValue: TONES[tone] };
}
