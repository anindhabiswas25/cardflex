// Test helpers: encode a hand record back into HandLog account bytes, as the
// program would have written them (for indexer and SDK tests).
import { PublicKey } from "@solana/web3.js";
import { discriminatorOf } from "./accounts.ts";
import { encode, sizeOf } from "./borsh.ts";
import type { HandRecord } from "./records.ts";

const b = (h: string) => Uint8Array.from(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []);
const pad = <T>(xs: T[], fill: T) => [...xs, ...Array(6 - xs.length).fill(fill)];

export function handLogBytes(rec: HandRecord, runtime: PublicKey = PublicKey.default): Uint8Array {
  const z32 = new Uint8Array(32);
  const seats = rec.seats.map((s) => s.seat);
  let winners = 0;
  for (const w of rec.game.winners) winners |= 1 << w;
  const log = {
    runtime, config: new PublicKey(rec.table), hand_no: BigInt(rec.hand_no), rules_version: rec.rules_version,
    protocol_version: rec.protocol_version, dealing_count: seats.length,
    seats: pad(seats, 0), wallets: pad(rec.seats.map((s) => new PublicKey(s.wallet)), PublicKey.default),
    salts: pad(rec.salts.map(b), z32), salt_commitments: pad(rec.claimed.salt_commitments.map(b), z32),
    hand_ctx: b(rec.claimed.hand_ctx), roster_hash: b(rec.claimed.roster_hash), vrf_caller_seed: b(rec.claimed.vrf_caller_seed),
    vrf_output: b(rec.vrf_output), merkle_root: b(rec.claimed.merkle_root), revealed: true,
    boot: BigInt(rec.game.boot), rake_bps: rec.game.rake_bps, rake_cap: BigInt(rec.game.rake_cap),
    start_stacks: pad(rec.game.start_stacks.map(BigInt), 0n), end_reason: rec.game.end_reason, winners,
    payouts: pad(rec.game.payouts.map(BigInt), 0n), rake: BigInt(rec.game.rake), bump: 255,
  };
  const out: number[] = [...discriminatorOf("HandLog")];
  encode({ defined: { name: "HandLog" } }, log, out);
  const tailAt = 8 + sizeOf({ defined: { name: "HandLog" } });
  const actions = b(rec.game.actions);
  const data = new Uint8Array(tailAt + 10 + 1600);
  data.set(out, 0);
  const v = new DataView(data.buffer);
  v.setBigUint64(tailAt, BigInt(rec.hand_no), true);
  v.setUint16(tailAt + 8, actions.length, true);
  data.set(actions, tailAt + 10);
  return data;
}
