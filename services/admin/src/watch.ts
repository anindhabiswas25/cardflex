// CF-056: operator alarms. `assess` is pure (tested offline); `scan` reads
// one operator's tables from the base layer. Read-only: needs no key.
//
// What each alarm means and what to do: docs/runbooks/alarms.md.
import type { Connection, PublicKey } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, TABLE_STATUS, decodeLedger, decodeRuntime, decodeTableConfig, ledgerPda, sizeOf, tableAddresses,
  type TableConfig, type TableRuntime,
} from "@card-flex/client-sdk";

export type Level = "critical" | "warning" | "info";
export type Alert = { level: Level; code: string; table: string; detail: string };

export type TableFacts = {
  config: string;
  cfg: TableConfig;
  /** Last committed runtime (base-layer copy); null if unreadable. */
  rt: TableRuntime | null;
  /** Runtime currently delegated to the PER (a live table). */
  live: boolean;
  vaultLamports: bigint;
  vaultRentFloor: bigint;
  /** synced_stack of every seated ledger (TableConfig.seated). */
  ledgerStacks: bigint[];
  nowSecs: bigint;
};

/** Thresholds; defaults suit Devnet and the CF-056 production timeout (1,800 s). */
export type Limits = {
  /** Warn once this share of the refund timeout has passed without a sync. */
  refundWarnShare: number;
  /** Warn when cancelled hands exceed this share of all hands (selective-abort risk). */
  cancelShare: number;
  /** ...but only after this many hands, so one early cancel isn't noise. */
  cancelMinHands: number;
};
export const DEFAULT_LIMITS: Limits = { refundWarnShare: 0.5, cancelShare: 0.2, cancelMinHands: 10 };

export function assess(f: TableFacts, l: Limits = DEFAULT_LIMITS): Alert[] {
  const out: Alert[] = [];
  const a = (level: Level, code: string, detail: string) => out.push({ level, code, table: f.config, detail });
  const { cfg } = f;

  // Vault = rent + Σ synced stacks + unswept rake (check_vault, ADR 0005).
  const owed = f.ledgerStacks.reduce((s, x) => s + x, 0n);
  const rake = cfg.synced_rake - cfg.rake_swept;
  const expected = f.vaultRentFloor + owed + rake;
  if (f.vaultLamports < expected) a("critical", "VAULT_SHORT", `vault ${f.vaultLamports} < owed ${expected} (short ${expected - f.vaultLamports} lamports)`);
  else if (f.vaultLamports > expected) a("warning", "VAULT_SURPLUS", `vault holds ${f.vaultLamports - expected} lamports more than it owes (sent straight to the vault?)`);

  // Only a live table has a running refund clock; a closed (undelegated)
  // one is expected to be old.
  if (cfg.status === TABLE_STATUS.ACTIVE && f.live) {
    const since = f.nowSecs - BigInt(cfg.last_sync_time);
    const timeout = BigInt(cfg.refund_timeout_secs);
    if (since >= timeout) a("critical", "REFUND_DUE", `no sync for ${since} s (timeout ${timeout} s): anyone can call emergency_refund now`);
    else if (Number(since) >= l.refundWarnShare * Number(timeout)) a("warning", "REFUND_NEAR", `no sync for ${since} s of ${timeout} s: is the keeper running?`);
  }
  if (cfg.status === TABLE_STATUS.REFUNDED) {
    const unclaimed = f.ledgerStacks.filter((x) => x > 0n).length;
    if (unclaimed) a("warning", "CLAIMS_PENDING", `refunded; ${unclaimed} seat(s) not claimed yet (claim_refund is permissionless)`);
  }
  if (f.rt) {
    const hands = Number(f.rt.hand_no);
    const cancelled = Number(f.rt.cancelled_hands);
    if (hands >= l.cancelMinHands && cancelled > l.cancelShare * hands) {
      a("warning", "CANCEL_RATE", `${cancelled} of ${hands} hands cancelled (> ${Math.round(l.cancelShare * 100)}%): selective-abort or stuck-player check`);
    }
  }
  return out;
}

/** Reads one operator's tables (or the given ones) and assesses each. */
export async function scan(base: Connection, o: { authority?: PublicKey; tables?: PublicKey[]; limits?: Limits }): Promise<Alert[]> {
  let configs: PublicKey[] = o.tables ?? [];
  if (!o.tables) {
    const filters: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[] = [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }];
    if (o.authority) filters.push({ memcmp: { offset: 8, bytes: o.authority.toBase58() } });
    configs = (await base.getProgramAccounts(PROGRAM_ID, { filters: filters as never, dataSlice: { offset: 0, length: 0 } })).map((x) => x.pubkey);
  }
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  const alerts: Alert[] = [];
  const rentCache = new Map<number, bigint>();
  const rentFor = async (len: number) => {
    if (!rentCache.has(len)) rentCache.set(len, BigInt(await base.getMinimumBalanceForRentExemption(len)));
    return rentCache.get(len)!;
  };
  // Bounded parallelism: one operator can own hundreds of tables.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, configs.length) }, async () => {
    while (next < configs.length) await one(configs[next++]);
  }));
  return alerts;

  async function one(config: PublicKey) {
    // One table that can't be read (e.g. made by an older program layout)
    // must not hide alarms on the others.
    try {
      const t = tableAddresses(config);
      const [c, r, v] = await base.getMultipleAccountsInfo([config, t.runtime, t.vault]);
      if (!c || !v) return;
      const cfg = decodeTableConfig(c.data);
      const seats = [0, 1, 2, 3, 4, 5].filter((s) => (cfg.seated >> s) & 1);
      const ledgers = seats.length ? await base.getMultipleAccountsInfo(seats.map((s) => ledgerPda(config, s))) : [];
      let rt: TableRuntime | null = null;
      try { rt = r ? decodeRuntime(r.data) : null; } catch { /* older runtime layout: skip the cancel-rate check */ }
      alerts.push(...assess({
        config: config.toBase58(), cfg, rt, live: !!r?.owner.equals(DELEGATION_PROGRAM_ID),
        vaultLamports: BigInt(v.lamports), vaultRentFloor: await rentFor(v.data.length),
        ledgerStacks: ledgers.map((x) => (x ? BigInt(decodeLedger(x.data).synced_stack) : 0n)), nowSecs,
      }, o.limits));
    } catch (e) {
      alerts.push({ level: "info", code: "UNREADABLE", table: config.toBase58(), detail: `skipped: ${String((e as Error).message ?? e).slice(0, 120)}` });
    }
  }
}
