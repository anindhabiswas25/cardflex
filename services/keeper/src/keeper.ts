// Keeper executor (CF-051): reads each table, asks decide() for the next
// step and sends it. Every instruction it sends is permissionless; the keeper
// key only pays fees. It reads PER with an operator-issued read token (a
// token grants reads, never signatures).
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  abortLostHand, confirmByPolling, isProgramError, cancelHand, joinSeat, PHASE, cancelSalts, commitHand, dealHand, decodeRuntime, decodeTableConfig, delegationRecordPda, nextHand, requestShuffle,
  revealHand, sideShowView, startHand, syncHand, tableAddresses, timeoutTurn, type TableRuntime,
} from "@card-flex/client-sdk";
import { indexHand } from "@card-flex/api/indexer";
import type { Store } from "@card-flex/api/store";
import type { Verifier } from "@card-flex/client-sdk";
import { decide, inProgress, viewerPairs, type Step } from "./decide.ts";

export type KeeperOpts = {
  base: Connection;
  per: Connection; // with a read token
  key: Keypair;
  heartbeatSecs: bigint;
  handGapSecs: bigint;
  /** CF-057: MagicBlock's fee vault (`magicFeeVault()`); without it only 10 commits per table work. */
  feeVault?: PublicKey;
  /** CF-053: a hand with no progress for this long is checked for lost state (default 120 s). */
  stuckSecs?: number;
  store?: Store; // index every hand before next_hand (closes the indexer's gap)
  verifier?: Verifier;
  log?: (msg: string) => void;
};

/** A runtime read taken by the scheduler (run.ts) with the PER slot at that time. */
export type Snapshot = { rt: TableRuntime | null; slot: bigint };

export type TableState = {
  lastCommitSecs: bigint; departedSynced: number; backoffUntil: number; failures: number; hands: number;
  /** CF-053: last seen hand progress and when it changed (ms). */
  progress: string; progressAt: number;
  /** Base-layer TableConfig, re-read at most every few seconds while idle. */
  cfg?: { at: number; seated: number; epochs: number[] };
  /** join_seat failures per "seat:epoch"; skipped after 2 so a bad ledger can't block the table. */
  joinFails: Map<string, number>;
  /** The table hasn't named this keeper's key (set_keeper): its per-hand commits are refused. */
  notKeeper?: boolean;
};

export class Keeper {
  readonly o: KeeperOpts;
  readonly tables = new Map<string, TableState>();
  constructor(o: KeeperOpts) {
    this.o = o;
  }
  private log(m: string) {
    (this.o.log ?? console.log)(`${new Date().toISOString()} ${m}`);
  }

  private async send(conn: Connection, ixs: TransactionInstruction[], label: string, skipPreflight = true) {
    const tx = new Transaction().add(...ixs);
    const bh = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;
    tx.feePayer = this.o.key.publicKey;
    tx.sign(this.o.key);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
    const err = await confirmByPolling(conn, sig);
    if (err) throw new Error(`${label}: ${JSON.stringify(err)}`);
    return sig;
  }

  private async readRuntime(config: PublicKey): Promise<TableRuntime | null> {
    const a = await this.o.per.getAccountInfo(tableAddresses(config).runtime);
    return a ? decodeRuntime(a.data) : null;
  }

  /** Seats bought in on the base layer but not seated in the runtime (CF-057 follow-up). */
  private async waitingSeats(config: PublicKey, rt: TableRuntime, st: TableState): Promise<number[]> {
    if (!st.cfg || Date.now() - st.cfg.at > 3_000) {
      const c = await this.o.base.getAccountInfo(config);
      if (!c) return [];
      const cfg = decodeTableConfig(c.data);
      st.cfg = { at: Date.now(), seated: cfg.seated, epochs: cfg.seat_epochs };
    }
    const { seated, epochs } = st.cfg;
    return [0, 1, 2, 3, 4, 5].filter((s) =>
      ((seated >> s) & 1) === 1 && ((rt.occupied >> s) & 1) === 0 && epochs[s] > rt.seat_epoch[s] &&
      (st.joinFails.get(`${s}:${epochs[s]}`) ?? 0) < 2);
  }

  private async commitAndSync(config: PublicKey, st: TableState, rt: TableRuntime) {
    const t = tableAddresses(config);
    const seq0 = decodeRuntime((await this.o.base.getAccountInfo(t.runtime))!.data).commit_seq;
    let committed = true;
    try {
      await this.send(this.o.per, [commitHand({ payer: this.o.key.publicKey, config, feeVault: this.o.feeVault })], "commit_hand");
    } catch (e) {
      // CF-064: someone else had the table pay for a commit < 240 s ago (or
      // nothing changed). Fine: just make sure that commit is synced.
      if (!isProgramError(e, "CommitNotNeeded")) throw e;
      committed = false;
      // Only the table's named keeper may commit right after a hand (CF-064
      // review); anyone else waits for the 240 s gap, so hands sync late.
      const mine = rt.keeper.equals(this.o.key.publicKey);
      if (!mine && !st.notKeeper) this.log(`${config.toBase58().slice(0, 8)} WARNING: this table hasn't named keeper ${this.o.key.publicKey.toBase58()}; run \`cf-admin table keeper ${config.toBase58()} ${this.o.key.publicKey.toBase58()}\``);
      st.notKeeper = !mine;
    }
    const t0 = Date.now();
    for (;;) {
      const b = await this.o.base.getAccountInfo(t.runtime);
      if (!committed || (b && decodeRuntime(b.data).commit_seq > seq0)) break;
      if (Date.now() - t0 > 90_000) throw new Error("commit did not land within 90 s");
      await new Promise((r) => setTimeout(r, 500));
    }
    const cfg = decodeTableConfig((await this.o.base.getAccountInfo(config))!.data);
    try {
      await this.send(this.o.base, [syncHand({ config, delegationRecord: delegationRecordPda(t.runtime), seated: cfg.seated })], "sync_hand", false);
    } catch (e) {
      // Preflight: already synced (StaleCommit) is fine only after a refused commit.
      if (committed || !isProgramError(e, "StaleCommit")) throw e;
    }
    st.lastCommitSecs = BigInt(Math.floor(Date.now() / 1000));
    st.departedSynced = rt.departed;
  }

  /**
   * One step for one table. Returns what it did (for logs and tests).
   * `snap`: a batched read from the scheduler (CF-061); read here if absent.
   */
  async tick(config: PublicKey, snap?: Snapshot): Promise<Step> {
    const id = config.toBase58();
    const st: TableState = this.tables.get(id) ?? { lastCommitSecs: 0n, departedSynced: 0, backoffUntil: 0, failures: 0, hands: 0, progress: "", progressAt: Date.now(), joinFails: new Map() };
    this.tables.set(id, st);
    if (Date.now() < st.backoffUntil) return { kind: "wait", why: "backing off after an error" };
    const rt = snap ? snap.rt : await this.readRuntime(config);
    if (!rt) return { kind: "wait", why: "runtime not readable in PER (not live, or token lacks access)" };
    const slot = snap ? snap.slot : BigInt(await this.o.per.getSlot());
    const progress = `${rt.hand_no}:${rt.phase}:${rt.action_seq}:${rt.salts_in}:${rt.grants}`;
    if (progress !== st.progress) {
      st.progress = progress;
      st.progressAt = Date.now();
    }
    const stuck = inProgress(rt) && Date.now() - st.progressAt >= (this.o.stuckSecs ?? 120) * 1000;
    const waitingSeats = rt.phase === PHASE.IDLE ? await this.waitingSeats(config, rt, st).catch(() => []) : [];
    const step = decide(rt, {
      nowSecs: BigInt(Math.floor(Date.now() / 1000)), slot, lastCommitSecs: st.lastCommitSecs,
      heartbeatSecs: this.o.heartbeatSecs, handGapSecs: this.o.handGapSecs, departedSynced: st.departedSynced, stuck, waitingSeats,
    });
    if (step.kind === "wait") return step;
    const payer = this.o.key.publicKey;
    const short = id.slice(0, 8);
    try {
      switch (step.kind) {
        case "start_hand": await this.send(this.o.per, [startHand({ payer, config })], step.kind); break;
        case "join_waiting":
          for (const seat of step.seats) {
            const key = `${seat}:${st.cfg?.epochs[seat] ?? 0}`;
            try {
              await this.send(this.o.per, [joinSeat({ payer, config, seat, live: true })], `join_seat ${seat}`);
              this.log(`${short} seated a waiting player at seat ${seat}`);
            } catch (e) {
              st.joinFails.set(key, (st.joinFails.get(key) ?? 0) + 1);
              throw e;
            }
          }
          st.cfg = undefined; // re-read before the next decision
          break;
        case "cancel_salts": await this.send(this.o.per, [cancelSalts({ payer, config })], step.kind); break;
        case "request_shuffle": await this.send(this.o.per, [requestShuffle({ payer, config })], step.kind); break;
        case "cancel_hand": await this.send(this.o.per, [cancelHand({ payer, config })], step.kind); break;
        case "abort_lost_hand":
          // Check again only after another full stuck period, whatever the outcome.
          st.progressAt = Date.now();
          await this.send(this.o.per, [abortLostHand({ payer, config, dealingOrder: step.order })], step.kind);
          this.log(`${short} hand #${rt.hand_no} aborted: its secret state was lost (counted in cancelled_hands)`);
          break;
        case "deal_hand": await this.send(this.o.per, [dealHand({ payer, config, dealingOrder: step.order })], step.kind); break;
        case "grant_view": await this.send(this.o.per, [sideShowView({ payer, config, seatA: step.a, seatB: step.b, grant: true })], step.kind); break;
        case "timeout_turn": await this.send(this.o.per, [timeoutTurn({ payer, config, expectedSeq: step.seq, dealingOrder: step.order })], step.kind); break;
        case "reveal_hand": await this.send(this.o.per, [revealHand({ payer, config, dealingOrder: step.order })], step.kind); break;
        case "revoke_views":
          for (const [a, b] of step.pairs) await this.send(this.o.per, [sideShowView({ payer, config, seatA: a, seatB: b, grant: false })], "revoke_view");
          break;
        case "commit_and_sync": await this.commitAndSync(config, st, rt); break;
        case "finish_hand": {
          // 1. Index the revealed hand before anything overwrites it.
          if (this.o.store && this.o.verifier) {
            const log = await this.o.per.getAccountInfo(tableAddresses(config).handLog);
            if (log) this.log(`${short} hand #${rt.hand_no} indexed: ${indexHand(id, Uint8Array.from(log.data), this.o.store, this.o.verifier)}`);
          }
          // 2. Side Show views end with the hand.
          for (const [a, b] of viewerPairs(rt)) {
            if ((rt.grants >> a) & 1 || (rt.grants >> b) & 1) await this.send(this.o.per, [sideShowView({ payer, config, seatA: a, seatB: b, grant: false })], "revoke_view");
          }
          // 3. Next hand (applies leaves), then one commit + sync carries stacks and leaves.
          await this.send(this.o.per, [nextHand({ payer, config })], "next_hand");
          const after = (await this.readRuntime(config)) ?? rt;
          await this.commitAndSync(config, st, after);
          st.hands++;
          break;
        }
      }
      st.failures = 0;
      this.log(`${short} ${step.kind}${"why" in step ? "" : ""}`);
    } catch (e) {
      st.failures++;
      st.backoffUntil = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(st.failures, 5));
      this.log(`${short} ${step.kind} failed (${st.failures}): ${String((e as Error).message ?? e).slice(0, 160)}`);
    }
    return step;
  }
}
