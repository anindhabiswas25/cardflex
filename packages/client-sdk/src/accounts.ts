// Account decoders, driven by the IDL. Field names are the program's
// (snake_case); u64 values are bigint, pubkeys PublicKey.
import type { PublicKey } from "@solana/web3.js";
import { decode, sizeOf } from "./borsh.ts";
import { idl } from "./idl.ts";

export type AccountName = "GlobalConfig" | "TableConfig" | "TableRuntime" | "SeatLedger" | "HandLog" | "TableVault";

const DISC = new Map(idl.accounts.map((a) => [a.name, Uint8Array.from(a.discriminator)]));

export function discriminatorOf(name: AccountName): Uint8Array {
  const d = DISC.get(name);
  if (!d) throw new Error(`no discriminator for ${name}`);
  return d;
}

/** Decodes a program account; throws if the discriminator doesn't match. */
export function decodeAccount<T = Record<string, unknown>>(name: AccountName, data: Uint8Array): T {
  const d = discriminatorOf(name);
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) throw new Error(`not a ${name} account`);
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return decode({ defined: { name } }, v, 8)[0] as T;
}

// ---- typed views of the accounts clients use most ----
export type GameSeat = { dealt: boolean; active: boolean; seen: boolean; blind_turns: number; stack: bigint; contributed: bigint };
export type GameState = {
  boot: bigint; chaal_limit_boots: bigint; pot_limit_boots: bigint; max_blind_turns: number; rake_bps: number; rake_cap: bigint;
  seats: GameSeat[]; order: number[]; n: number; turn: number; stake: bigint; pot: bigint;
  phase: number; ss_requester: number; ss_target: number; end_reason: number; winners: number; payouts: bigint[]; rake: bigint;
};
export type TableRuntime = {
  config: PublicKey; authority: PublicKey; max_seats: number; occupied: number; wallets: PublicKey[]; session_keys: PublicKey[];
  hand_no: bigint; dealt: boolean; locked: boolean; grants: number; phase: number; hand_ctx: Uint8Array; roster_hash: Uint8Array;
  salts_in: number; dealing_order: number[]; dealing_count: number; salt_commitments: Uint8Array[]; vrf_caller_seed: Uint8Array;
  merkle_root: Uint8Array; vrf_request_slot: bigint; cancelled_hands: bigint; stacks: bigint[]; commit_seq: bigint;
  boot: bigint; rake_bps: number; rake_cap: bigint; rake_owed: bigint; action_seq: bigint; game: GameState;
  side_show_viewers: number[]; side_show_hand_no: bigint; turn_deadline: bigint; button: number; seat_epoch: number[];
  leaving: number; departed: number; salts_deadline: bigint; missed_salts: number[]; last_hand_end: bigint; bump: number;
  /** CF-064 */ last_paid_commit: bigint; paid_commit_hash: Uint8Array;
  /** CF-065: the keeper's read key (PublicKey.default = none) */ keeper: PublicKey;
  /** CF-076: per seat, how much of the ledger's deposits (buy_in) is already in `stacks` */ credited: bigint[];
  /** CF-084: commit_seq when the table last left the PER; commit_seq - session_base_seq = commits this session */ session_base_seq: bigint;
};
export type TableConfig = {
  authority: PublicKey; table_id: bigint; max_seats: number; runtime: PublicKey; bump: number; status: number; validator: PublicKey;
  refund_timeout_secs: number; min_buy_in: bigint; max_buy_in: bigint; seated: number; last_sync_time: bigint; last_synced_seq: bigint;
  vault_bump: number; seat_epochs: number[]; wallets: PublicKey[]; sessions: PublicKey[]; ever_delegated: boolean;
  synced_rake: bigint; rake_swept: bigint;
};
export type SeatLedger = {
  config: PublicKey; seat: number; wallet: PublicKey; buy_in: bigint; synced_stack: bigint; bump: number;
  epoch: number; session_key: PublicKey; left: boolean;
};
export type GlobalConfig = { authority: PublicKey; treasury: PublicKey; max_rake_bps: number; paused: boolean; bump: number };
export type HandLog = Record<string, unknown> & { hand_no: bigint; dealing_count: number; seats: number[]; revealed: boolean };

export const decodeRuntime = (d: Uint8Array) => decodeAccount<TableRuntime>("TableRuntime", d);
export const decodeTableConfig = (d: Uint8Array) => decodeAccount<TableConfig>("TableConfig", d);
export const decodeLedger = (d: Uint8Array) => decodeAccount<SeatLedger>("SeatLedger", d);
export const decodeGlobal = (d: Uint8Array) => decodeAccount<GlobalConfig>("GlobalConfig", d);
export const decodeHandLog = (d: Uint8Array) => decodeAccount<HandLog>("HandLog", d);

/** The public action log in the raw tail of HandLog (rules v1 §7). */
export function handLogActions(data: Uint8Array): { handNo: bigint; actions: Uint8Array } {
  const off = 8 + sizeOf({ defined: { name: "HandLog" } });
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const handNo = v.getBigUint64(off, true);
  const count = v.getUint16(off + 8, true);
  return { handNo, actions: data.slice(off + 10, off + 10 + count) };
}

/** Byte layout of a private SeatHand (table.rs HAND_*). Readable only by its session key. */
export const SEAT_HAND = { len: 727, handNo: 41, cards: 49, positions: 52, leafSalts: 55, proofs: 151 } as const;

export function decodeSeatHand(data: Uint8Array) {
  if (data.length < SEAT_HAND.len) throw new Error("not a SeatHand");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cards = [0, 1, 2].map((j) => data[SEAT_HAND.cards + j]);
  const positions = [0, 1, 2].map((j) => data[SEAT_HAND.positions + j]);
  const leafSalts = [0, 1, 2].map((j) => data.slice(SEAT_HAND.leafSalts + 32 * j, SEAT_HAND.leafSalts + 32 * (j + 1)));
  const proofs = [0, 1, 2].map((j) =>
    Array.from({ length: 6 }, (_, l) => data.slice(SEAT_HAND.proofs + (6 * j + l) * 32, SEAT_HAND.proofs + (6 * j + l + 1) * 32)),
  );
  return { seat: data[40], handNo: v.getBigUint64(SEAT_HAND.handNo, true), cards, positions, leafSalts, proofs, dealt: positions[1] !== 0 };
}
