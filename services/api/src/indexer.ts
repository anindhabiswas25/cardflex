// Indexer core (CF-018): tables for the lobby, and every revealed hand —
// rebuilt as a cf-hand-record/2, verified with the WASM verifier (CF-040),
// and replayed with the rules to get each seat's bets and net result.
import { DELEGATION_PROGRAM_ID, decodeRuntime, decodeTableConfig, dealPositions, handRecordFromHandLog, rules, type Verifier } from "@card-flex/client-sdk";
import type { ChainSource } from "./source.ts";
import type { Store, HandSeatRow } from "./store.ts";

const s = (x: bigint | number) => x.toString();

export type IndexStats = { tables: number; newHands: number; invalidHands: number; errors: string[] };

export async function indexOnce(src: ChainSource, store: Store, verifier: Verifier, now = Date.now()): Promise<IndexStats> {
  const stats: IndexStats = { tables: 0, newHands: 0, invalidHands: 0, errors: [] };
  for (const t of await src.listTables()) {
    const config = t.config.toBase58();
    try {
      const cfg = decodeTableConfig(t.configData);
      const rt = t.runtimeData ? decodeRuntime(t.runtimeData) : null;
      const live = !!t.runtimeOwner?.equals(DELEGATION_PROGRAM_ID);
      const seats = rt
        ? [0, 1, 2, 3, 4, 5]
            .filter((i) => ((rt.occupied | rt.departed) >> i) & 1)
            .map((i) => ({ seat: i, wallet: rt.wallets[i].toBase58(), stack: s(rt.stacks[i]), left: ((rt.departed >> i) & 1) === 1 }))
        : [];
      store.upsertTable({
        config, authority: cfg.authority.toBase58(), table_id: s(cfg.table_id), max_seats: cfg.max_seats, status: cfg.status,
        live: live ? 1 : 0, boot: s(rt?.boot ?? 0n), min_buy_in: s(cfg.min_buy_in), max_buy_in: s(cfg.max_buy_in),
        rake_bps: rt?.rake_bps ?? 0, rake_cap: s(rt?.rake_cap ?? 0n), seated: seats.filter((x) => !x.left).length,
        phase: rt?.phase ?? 0, hand_no: s(rt?.hand_no ?? 0n), seats_json: JSON.stringify(seats),
        last_sync_time: Number(cfg.last_sync_time), updated_at: now,
      });
      stats.tables++;

      const logData = await src.handLog(t.config, live);
      const r = logData ? indexHand(config, logData, store, verifier, now) : "none";
      if (r === "valid" || r === "invalid") stats.newHands++;
      if (r === "invalid") stats.invalidHands++;
    } catch (e) {
      stats.errors.push(`${config}: ${String((e as Error).message ?? e)}`);
    }
  }
  return stats;
}

/**
 * Stores the revealed hand in `logData` (HandLog bytes) if it's new: rebuilt
 * as cf-hand-record/2, verified, replayed for per-seat bets and nets. Used by
 * the polling indexer and by the keeper (before next_hand, so no hand is
 * missed). Returns "none" (not revealed), "known", "valid" or "invalid".
 */
export function indexHand(config: string, logData: Uint8Array, store: Store, verifier: Verifier, now = Date.now()): "none" | "known" | "valid" | "invalid" {
  const record = handRecordFromHandLog(logData);
  if (!record) return "none";
  if (store.hasHand(config, record.hand_no)) return "known";
  const report = verifier.verify(record);
  const n = record.seats.length;
  const order = record.seats.map((x) => x.seat);
  const cards = report.deck ? order.map((_, k) => dealPositions(k, n).map((p) => report.deck![p])) : order.map(() => [] as number[]);
  let contributed = order.map(() => 0n);
  if (report.overall === "VALID") {
    const stacks = Array<bigint>(6).fill(0n), keys = Array<number>(6).fill(0);
    order.forEach((seat, k) => { stacks[seat] = BigInt(record.game.start_stacks[k]); keys[seat] = rules.handKey(cards[k]); });
    const hand = rules.replay(
      { boot: BigInt(record.game.boot), rakeBps: record.game.rake_bps, rakeCap: BigInt(record.game.rake_cap) },
      stacks, order, Uint8Array.from(record.game.actions.match(/../g)?.map((x) => parseInt(x, 16)) ?? []), keys,
    );
    contributed = order.map((seat) => hand.seats[seat].contributed);
  }
  const pot = contributed.reduce((a, b) => a + b, 0n);
  const seatRows: HandSeatRow[] = order.map((seat, k) => {
    const payout = BigInt(record.game.payouts[k]);
    return {
      config, hand_no: record.hand_no, seat, wallet: record.seats[k].wallet, start_stack: record.game.start_stacks[k],
      contributed: s(contributed[k]), payout: s(payout), net: s(payout - contributed[k]),
      cards_json: JSON.stringify(cards[k]), won: record.game.winners.includes(seat) ? 1 : 0,
    };
  });
  store.insertHand({
    config, hand_no: record.hand_no, end_reason: ["last_player", "show", "pot_limit"][record.game.end_reason] ?? "unknown",
    winners_json: JSON.stringify(record.game.winners), pot: s(pot), rake: record.game.rake,
    verified: report.overall === "VALID" ? 1 : 0, verify_json: JSON.stringify(report.checks), record_json: JSON.stringify(record), indexed_at: now,
  }, seatRows);
  return report.overall === "VALID" ? "valid" : "invalid";
}
