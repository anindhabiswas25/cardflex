import { rules } from "@card-flex/client-sdk";
// Same card encoding as crates/card-types: id = suit * 13 + (rank - 2),
// suits clubs 0, diamonds 1, hearts 2, spades 3; rank 14 = ace.
export const cardRank = (id: number) => (id % 13) + 2;
export const cardSuit = (id: number) => Math.floor(id / 13);
export const card = (rank: number, suit: number) => suit * 13 + (rank - 2);

/** The card art in public/cards/ (e.g. "/cards/As.webp", "/cards/10h.webp"). */
const ART_SUIT = ["c", "d", "h", "s"];
const ART_RANK: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
export const cardArt = (id: number) => `/cards/${ART_RANK[cardRank(id)] ?? cardRank(id)}${ART_SUIT[cardSuit(id)]}.webp`;

/**
 * Hand strength for the meter: the share of all 22,100 three-card hands this
 * hand beats (ties count half), using the frozen rules-v1 ranking key.
 */
let allKeys: Uint32Array | null = null;
export function strengthPct(cards: number[]): number {
  if (!allKeys) {
    const ks: number[] = [];
    for (let a = 0; a < 52; a++) for (let b = a + 1; b < 52; b++) for (let c = b + 1; c < 52; c++) ks.push(rules.handKey([a, b, c]));
    allKeys = Uint32Array.from(ks).sort();
  }
  const k = rules.handKey(cards);
  const lower = (x: number) => { let lo = 0, hi = allKeys!.length; while (lo < hi) { const m = (lo + hi) >> 1; if (allKeys![m] < x) lo = m + 1; else hi = m; } return lo; };
  const below = lower(k), upTo = lower(k + 1);
  return Math.round(((below + (upTo - below) / 2) / allKeys.length) * 100);
}
