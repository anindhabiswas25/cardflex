// CF-060: keeper health, served on HEALTH_PORT (GET /health) and polled by
// `cf-admin watch --keeper-url`. Pure, so the rules are tested offline.
import type { TableState } from "./keeper.ts";
import type { RunStatus } from "./run.ts";

/** A batched PER read should succeed every tick; this long without one is down. */
export const READ_STALE_MS = 30_000;
/** Consecutive failed steps on one table before it counts as failing. */
export const TABLE_FAILING = 5;
/**
 * Runtime lamports above rent below which a table is at risk. CF-073
 * (measured on Devnet): per delegation the first 25 commits are free, then
 * each commit moves 2,000,000 lamports from the runtime to MagicBlock's fee
 * vault; with less than that above rent every commit fails
 * (`InsufficientFundsForRent`). The runtime can't be topped up while live, so
 * warn while ~5 commits are left: close and reopen (`table open` funds a
 * reserve) before it runs out.
 */
export const COMMIT_COST = 2_000_000;
export const HEADROOM_MIN = 5 * COMMIT_COST;

export type TableHealth = { table: string; hands: number; failures: number; progressAgeSecs: number; lastCommitSecs: number };
export type Health = { ok: boolean; reasons: string[]; uptimeSecs: number; tables: number; lastReadAgeSecs: number | null; perTable: TableHealth[] };

export function health(tables: Map<string, TableState>, run: RunStatus, now: number = Date.now()): Health {
  const reasons: string[] = [];
  const readAge = run.lastReadAt ? now - run.lastReadAt : null;
  if (run.tables > 0 && (readAge === null ? now - run.startedAt > READ_STALE_MS : readAge > READ_STALE_MS)) {
    reasons.push(`no successful PER read for ${Math.round((readAge ?? now - run.startedAt) / 1000)} s`);
  }
  const perTable: TableHealth[] = [];
  for (const [table, st] of tables) {
    perTable.push({ table, hands: st.hands, failures: st.failures, progressAgeSecs: Math.round((now - st.progressAt) / 1000), lastCommitSecs: Number(st.lastCommitSecs) });
    if (st.failures >= TABLE_FAILING) reasons.push(`${table.slice(0, 8)}: ${st.failures} failed steps in a row`);
    if (st.headroom !== undefined && st.headroom < HEADROOM_MIN) reasons.push(`${table.slice(0, 8)}: runtime has only ${st.headroom} lamports above rent; each commit costs ~${COMMIT_COST} after the free ones and it can't be topped up while live (close it at a quiet moment, refund players or reopen with a reserve)`);
    if (st.notKeeper) reasons.push(`${table.slice(0, 8)}: table hasn't named this keeper (cf-admin table keeper); hands sync only every 240 s`);
  }
  return { ok: reasons.length === 0, reasons, uptimeSecs: Math.round((now - run.startedAt) / 1000), tables: run.tables, lastReadAgeSecs: readAge === null ? null : Math.round(readAge / 1000), perTable };
}
