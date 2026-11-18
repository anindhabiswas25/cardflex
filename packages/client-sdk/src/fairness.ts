// CF-Fairness v2 helpers for clients (docs/spec/cf-fairness-v2.md). Enough to
// check one's own cards against the public Merkle root right after the deal;
// full deck rebuilds are done by the verifier (cf-verify / WASM).
import { sha256 } from "@noble/hashes/sha2";
import type { PublicKey } from "@solana/web3.js";

const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const le = (v: bigint | number, n: number) => {
  const b = new Uint8Array(n);
  let x = BigInt(v);
  for (let i = 0; i < n; i++) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
};
const h = (...parts: Uint8Array[]) => sha256(cat(...parts));
export const PROTOCOL_VERSION = 2;

export const rosterHash = (seats: number[], wallets: PublicKey[]) =>
  h(enc("CF_ROSTER_V2"), Uint8Array.of(seats.length), ...seats.flatMap((s, i) => [Uint8Array.of(s), wallets[i].toBytes()]));

export const handCtx = (programId: PublicKey, table: PublicKey, handNo: bigint | number, roster: Uint8Array, rulesVersion: number) =>
  h(enc("CF_CTX_V2"), programId.toBytes(), table.toBytes(), le(handNo, 8), roster, le(rulesVersion, 2), le(PROTOCOL_VERSION, 2));

export const saltCommitment = (ctx: Uint8Array, seat: number, salt: Uint8Array) => h(enc("CF_SALT_V2"), ctx, Uint8Array.of(seat), salt);
export const vrfCallerSeed = (ctx: Uint8Array, commitments: Uint8Array[]) => h(enc("CF_VRF_SEED_V2"), ctx, ...commitments);
export const cardLeaf = (ctx: Uint8Array, pos: number, card: number, salt: Uint8Array) =>
  h(Uint8Array.of(0), enc("CF_CARD_LEAF_V2"), ctx, Uint8Array.of(pos), Uint8Array.of(card), salt);
const parent = (l: Uint8Array, r: Uint8Array) => h(Uint8Array.of(1), l, r);

/** Checks one dealt card against the public root (6 sibling hashes, spec §7). */
export function verifyCard(root: Uint8Array, ctx: Uint8Array, pos: number, card: number, salt: Uint8Array, siblings: Uint8Array[]): boolean {
  let node = cardLeaf(ctx, pos, card, salt), idx = pos;
  for (const sib of siblings) { node = idx % 2 === 0 ? parent(node, sib) : parent(sib, node); idx >>= 1; }
  return node.length === root.length && node.every((b, i) => b === root[i]);
}

/** Deck positions of the k-th seat in dealing order with n seats (spec §8). */
export const dealPositions = (k: number, n: number) => [k, k + n, k + 2 * n];

/** A random 32-byte salt from a CSPRNG (submit with submit_salt). */
export function newSalt(): Uint8Array {
  const s = new Uint8Array(32);
  crypto.getRandomValues(s);
  return s;
}
