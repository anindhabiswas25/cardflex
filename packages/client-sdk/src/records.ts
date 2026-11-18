// Builds the public hand record (`cf-hand-record/2`, crates/fairness-verifier)
// from a revealed HandLog account.
import { PublicKey } from "@solana/web3.js";
import { decodeHandLog, handLogActions } from "./accounts.ts";
import { PROGRAM_ID } from "./constants.ts";

export type HandRecord = {
  format: "cf-hand-record/2";
  protocol_version: number;
  program_id: string;
  table: string;
  hand_no: string;
  rules_version: number;
  seats: { seat: number; wallet: string }[];
  salts: string[];
  vrf_output: string;
  claimed: { roster_hash: string; hand_ctx: string; salt_commitments: string[]; vrf_caller_seed: string; merkle_root: string };
  hands: { seat: number; cards: number[] }[];
  game: {
    boot: string; rake_bps: number; rake_cap: string; start_stacks: string[]; actions: string;
    end_reason: number; winners: number[]; payouts: string[]; rake: string;
  };
};

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** Null if the log isn't revealed yet. `shown` = cards players chose to show (optional). */
export function handRecordFromHandLog(data: Uint8Array, shown: { seat: number; cards: number[] }[] = [], programId: PublicKey = PROGRAM_ID): HandRecord | null {
  const l = decodeHandLog(data) as any;
  if (!l.revealed) return null;
  const n: number = l.dealing_count;
  const seats: number[] = l.seats.slice(0, n);
  const { actions } = handLogActions(data);
  return {
    format: "cf-hand-record/2",
    protocol_version: l.protocol_version,
    program_id: programId.toBase58(),
    table: (l.config as PublicKey).toBase58(),
    hand_no: String(l.hand_no),
    rules_version: l.rules_version,
    seats: seats.map((s, k) => ({ seat: s, wallet: (l.wallets[k] as PublicKey).toBase58() })),
    salts: l.salts.slice(0, n).map(hex),
    vrf_output: hex(l.vrf_output),
    claimed: {
      roster_hash: hex(l.roster_hash),
      hand_ctx: hex(l.hand_ctx),
      salt_commitments: l.salt_commitments.slice(0, n).map(hex),
      vrf_caller_seed: hex(l.vrf_caller_seed),
      merkle_root: hex(l.merkle_root),
    },
    hands: shown,
    game: {
      boot: String(l.boot),
      rake_bps: l.rake_bps,
      rake_cap: String(l.rake_cap),
      start_stacks: l.start_stacks.slice(0, n).map(String),
      actions: hex(actions),
      end_reason: l.end_reason,
      winners: seats.filter((s) => (l.winners >> s) & 1),
      payouts: l.payouts.slice(0, n).map(String),
      rake: String(l.rake),
    },
  };
}
