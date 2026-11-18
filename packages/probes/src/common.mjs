// Shared helpers for the Devnet probes (CF-007 onward).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";

export const PROGRAM_ID = new PublicKey("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");
// Override for the local stack: CARDFLEX_VALIDATOR=mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
export const TEE_VALIDATOR = new PublicKey(process.env.CARDFLEX_VALIDATOR ?? "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const BASE_RPC = process.env.CARDFLEX_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
export const TEE_RPC = process.env.CARDFLEX_TEE_RPC ?? "https://devnet-tee.magicblock.app";
const TEE_WS = process.env.CARDFLEX_TEE_WS ?? TEE_RPC.replace(/^http/, "ws");
export const KEYPAIR = process.env.CARDFLEX_DEVNET_KEYPAIR ?? `${homedir()}/.config/cardflex/devnet-deployer.json`;
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadDiscriminators() {
  const p = `${repoRoot}/target/idl/card_flex.json`;
  if (!existsSync(p)) throw new Error("Run `pnpm build:program:devnet-poc` first (needs target/idl/card_flex.json).");
  const idl = JSON.parse(readFileSync(p, "utf8"));
  return Object.fromEntries(idl.instructions.map((i) => [i.name, Buffer.from(i.discriminator)]));
}
export const loadPayer = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));

export const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
export const stats = (xs) => (xs.length ? { n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) } : { n: 0 });
export const sleep = (t) => new Promise((r) => setTimeout(r, t));
export const log = (...a) => console.error(...a);
export const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
export const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
export const u8 = (v) => Buffer.from([v]);
export const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const vecPubkeys = (keys) => { const n = Buffer.alloc(4); n.writeUInt32LE(keys.length); return Buffer.concat([n, ...keys.map((k) => k.toBuffer())]); };

export function makeIx(disc) {
  return (name, keys, data = Buffer.alloc(0)) => {
    if (!disc[name]) throw new Error(`unknown instruction ${name}; rebuild the IDL`);
    return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc[name], data]) });
  };
}

/** Sends and confirms; retries transport errors only, never program errors. */
export async function send(conn, instructions, signers, { skipPreflight = false, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...instructions);
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      const t0 = performance.now();
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
      const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (res.value.err) { const e = new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`); e.programError = true; e.sig = sig; throw e; }
      return { sig, ms: ms(t0) };
    } catch (e) {
      if (e.programError || attempt >= retries) throw e;
      log(`  retry after: ${String(e.message ?? e).slice(0, 80)}`);
      await sleep(1000);
    }
  }
}

/** Expects the transaction to fail; returns true if it did. */
export async function rejected(conn, instructions, signers) {
  try { await send(conn, instructions, signers, { skipPreflight: true, retries: 0 }); return false; }
  catch (e) { return true; }
}

export const authFailures = [];
export async function tokenFor(kp) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
      return token;
    } catch (e) {
      const cause = String(e.cause?.code ?? e.cause?.message ?? e.message ?? e).slice(0, 100);
      authFailures.push(cause);
      if (attempt >= 4) throw new Error(`auth failed after retries: ${cause}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}
export const teeUrl = (token) => (token ? `${TEE_RPC}?token=${token}` : TEE_RPC);
export const teeConn = (token) =>
  new Connection(teeUrl(token), { commitment: "confirmed", wsEndpoint: `${TEE_WS}${token ? `?token=${token}` : ""}` });

/** Raw JSON-RPC call (for methods/encodings web3.js hides). */
export async function rawRpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return res.json();
}

export async function waitFor(fn, timeoutMs, everyMs = 250) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return { value: v, ms: ms(t0) };
    await sleep(everyMs);
  }
  return { value: null, ms: ms(t0) };
}

// Mirror of table.rs poc_test_deck + deal_positions (P1 TEST deck, not random).
export function testDeck(handNo) {
  const shift = Number((BigInt(handNo) * 7n + 3n) % 52n);
  return Array.from({ length: 52 }, (_, i) => (i + shift) % 52);
}
export const dealPositions = (k, n) => [k, k + n, k + 2 * n];

// ---- CF-Fairness v2 (docs/spec/cf-fairness-v2.md), node:crypto only ----
import { createHash } from "node:crypto";
export const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const le16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
export const rosterHash = (seats, wallets) =>
  sha256(Buffer.from("CF_ROSTER_V2"), Buffer.from([seats.length]), ...seats.flatMap((s, i) => [Buffer.from([s]), wallets[i].toBuffer()]));
export const handCtx = (programId, table, handNo, roster, rulesVersion) =>
  sha256(Buffer.from("CF_CTX_V2"), programId.toBuffer(), table.toBuffer(), u64(handNo), roster, le16(rulesVersion), le16(2));
export const saltCommitment = (ctx, seat, salt) => sha256(Buffer.from("CF_SALT_V2"), ctx, Buffer.from([seat]), salt);

// TableRuntime byte offsets (8-byte Anchor discriminator first). Keep in sync
// with programs/card-flex/src/table.rs.
export const RT = {
  occupied: 73, wallets: 74, sessions: 266, hand_no: 458, dealt: 466, locked: 467, grants: 468, phase: 469,
  hand_ctx: 470, roster_hash: 502, salts_in: 534, dealing_order: 535, dealing_count: 541, salt_commitments: 542,
  vrf_caller_seed: 734, merkle_root: 766, vrf_request_slot: 798, cancelled_hands: 806,
  stacks: 810, commit_seq: 858,
  // CF-020 rules and live hand (checked by tests/test_game.rs runtime_byte_offsets).
  boot: 866, rake_bps: 874, rake_cap: 876, rake_owed: 884, action_seq: 892, game: 900,
  side_show_viewers: 1140, side_show_hand_no: 1146, turn_deadline: 1154, button: 1162,
};
// GameState offsets inside TableRuntime (absolute). Seats are 20 bytes each:
// dealt, active, seen, blind_turns (1 each), stack u64, contributed u64.
export const GAME = {
  boot: 900, seats: 935, seat_len: 20, order: 1055, n: 1061, turn: 1062, stake: 1063, pot: 1071,
  phase: 1079, ss_requester: 1080, ss_target: 1081, end_reason: 1082, winners: 1083, payouts: 1084, rake: 1132,
};
export const ACTION = { SEE: 0, CHAAL: 1, PACK: 2, SHOW: 3, SIDE_SHOW: 4, SIDE_SHOW_RESPOND: 5 };
// TableConfig byte offsets (ADR 0004 fields).
export const TC = { status: 82, validator: 83, refund_timeout_secs: 115, min_buy_in: 119, max_buy_in: 127, seated: 135, last_sync_time: 136, last_synced_seq: 144 };
// SeatLedger: config(8) seat(40) wallet(41) buy_in(73) synced_stack(81).
export const SL = { seat: 40, wallet: 41, buy_in: 73, synced_stack: 81 };
export const PHASE = { IDLE: 0, SALTS_PENDING: 1, SALTS_DONE: 2, VRF_PENDING: 3, SEEDED: 4, DEALT: 5, HAND_COMPLETE: 6, REVEALED: 7, POC_DONE: 8 };
// SeatHand byte offsets (table.rs HAND_*).
export const HAND = { cards: 49, positions: 52, leaf_salts: 55, proofs: 151, len: 727 };
// Spec §7: leaf, parent and proof check.
export const cardLeaf = (ctx, pos, card, salt) => sha256(Buffer.from([0]), Buffer.from("CF_CARD_LEAF_V2"), ctx, Buffer.from([pos]), Buffer.from([card]), salt);
const parentHash = (l, r) => sha256(Buffer.from([1]), l, r);
export function verifyCard(root, ctx, pos, card, salt, siblings) {
  let h = cardLeaf(ctx, pos, card, salt), idx = pos;
  for (const sib of siblings) { h = idx % 2 === 0 ? parentHash(h, sib) : parentHash(sib, h); idx >>= 1; }
  return h.equals(root);
}
export const vrfCallerSeed = (ctx, commitments) => sha256(Buffer.from("CF_VRF_SEED_V2"), ctx, ...commitments);

// HandLog byte offsets (table.rs HandLog, 8-byte discriminator first).
export const HL = {
  config: 40, hand_no: 72, rules_version: 80, protocol_version: 82, dealing_count: 84, seats: 85,
  wallets: 91, salts: 283, salt_commitments: 475, hand_ctx: 667, roster_hash: 699,
  vrf_caller_seed: 731, vrf_output: 763, merkle_root: 795, revealed: 827,
  // CF-021 game summary (written at reveal, dealing order) and action tail.
  boot: 828, rake_bps: 836, rake_cap: 838, start_stacks: 846, end_reason: 894, winners: 895,
  payouts: 896, rake: 944, actions_hand_no: 953, action_count: 961, actions: 963, len: 2563,
};

/** Builds a `cf-hand-record/2` (crates/fairness-verifier) from raw HandLog bytes. */
export function handRecordFromLog(d, shownHands = []) {
  const n = d[HL.dealing_count];
  const h = (off) => d.subarray(off, off + 32).toString("hex");
  const key = (off) => new PublicKey(d.subarray(off, off + 32)).toBase58();
  return {
    format: "cf-hand-record/2",
    protocol_version: d.readUInt16LE(HL.protocol_version),
    program_id: PROGRAM_ID.toBase58(),
    table: key(HL.config),
    hand_no: d.readBigUInt64LE(HL.hand_no).toString(),
    rules_version: d.readUInt16LE(HL.rules_version),
    seats: Array.from({ length: n }, (_, k) => ({ seat: d[HL.seats + k], wallet: key(HL.wallets + 32 * k) })),
    salts: Array.from({ length: n }, (_, k) => h(HL.salts + 32 * k)),
    vrf_output: h(HL.vrf_output),
    claimed: {
      roster_hash: h(HL.roster_hash),
      hand_ctx: h(HL.hand_ctx),
      salt_commitments: Array.from({ length: n }, (_, k) => h(HL.salt_commitments + 32 * k)),
      vrf_caller_seed: h(HL.vrf_caller_seed),
      merkle_root: h(HL.merkle_root),
    },
    hands: shownHands,
    game: {
      boot: d.readBigUInt64LE(HL.boot).toString(),
      rake_bps: d.readUInt16LE(HL.rake_bps),
      rake_cap: d.readBigUInt64LE(HL.rake_cap).toString(),
      start_stacks: Array.from({ length: n }, (_, k) => d.readBigUInt64LE(HL.start_stacks + 8 * k).toString()),
      actions: d.subarray(HL.actions, HL.actions + d.readUInt16LE(HL.action_count)).toString("hex"),
      end_reason: d[HL.end_reason],
      winners: Array.from({ length: n }, (_, k) => d[HL.seats + k]).filter((s) => (d[HL.winners] >> s) & 1),
      payouts: Array.from({ length: n }, (_, k) => d.readBigUInt64LE(HL.payouts + 8 * k).toString()),
      rake: d.readBigUInt64LE(HL.rake).toString(),
    },
  };
}

// ---- CF-030: GlobalConfig (ADR 0005) ----
export const GLOBAL = PublicKey.findProgramAddressSync([Buffer.from("global")], PROGRAM_ID)[0];
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const PROGRAM_DATA = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], UPGRADEABLE_LOADER)[0];
// GlobalConfig: authority(8) treasury(40) max_rake_bps(72) paused(74).
export const GC = { authority: 8, treasury: 40, max_rake_bps: 72, paused: 74 };

/** Creates GlobalConfig once on this cluster if missing. `admin` must be the
 * program's upgrade authority (the devnet deployer). Treasury = admin. */
export async function ensureGlobal(conn, ix, admin, maxRakeBps = 1_000) {
  if (await conn.getAccountInfo(GLOBAL)) return false;
  const data = Buffer.alloc(34);
  admin.publicKey.toBuffer().copy(data, 0);
  data.writeUInt16LE(maxRakeBps, 32);
  await send(conn, [ix("init_global", [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: GLOBAL, isSigner: false, isWritable: true },
    { pubkey: PROGRAM_ID, isSigner: false, isWritable: false }, { pubkey: PROGRAM_DATA, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ], data)], [admin]);
  return true;
}
