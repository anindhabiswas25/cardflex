// Keeper executor (CF-051): reads each table, asks decide() for the next
// step and sends it. Every instruction it sends is permissionless; the keeper
// key only pays fees. It reads PER with an operator-issued read token (a
// token grants reads, never signatures).
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  cancelHand, cancelSalts, commitHand, dealHand, decodeRuntime, decodeTableConfig, delegationRecordPda, nextHand, requestShuffle,
  revealHand, sideShowView, startHand, syncHand, tableAddresses, timeoutTurn, type TableRuntime,
} from "@card-flex/client-sdk";
import { indexHand } from "@card-flex/api/indexer";
import type { Store } from "@card-flex/api/store";
import type { Verifier } from "@card-flex/client-sdk";
import { decide, viewerPairs, type Step } from "./decide.ts";

export type KeeperOpts = {
  base: Connection;
  per: Connection; // with a read token
  key: Keypair;
  heartbeatSecs: bigint;
  handGapSecs: bigint;
  store?: Store; // index every hand before next_hand (closes the indexer's gap)
  verifier?: Verifier;
  log?: (msg: string) => void;
};

type TableState = { lastCommitSecs: bigint; departedSynced: number; backoffUntil: number; failures: number; hands: number };

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
    const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (res.value.err) throw new Error(`${label}: ${JSON.stringify(res.value.err)}`);
    return sig;
  }

  private async readRuntime(config: PublicKey): Promise<TableRuntime | null> {
    const a = await this.o.per.getAccountInfo(tableAddresses(config).runtime);
    return a ? decodeRuntime(a.data) : null;
  }

  private async commitAndSync(config: PublicKey, st: TableState, rt: TableRuntime) {
    const t = tableAddresses(config);
    const seq0 = decodeRuntime((await this.o.base.getAccountInfo(t.runtime))!.data).commit_seq;
    await this.send(this.o.per, [commitHand({ payer: this.o.key.publicKey, config })], "commit_hand");
    const t0 = Date.now();
    for (;;) {
      const b = await this.o.base.getAccountInfo(t.runtime);
      if (b && decodeRuntime(b.data).commit_seq > seq0) break;
      if (Date.now() - t0 > 90_000) throw new Error("commit did not land within 90 s");
      await new Promise((r) => setTimeout(r, 500));
    }
    const cfg = decodeTableConfig((await this.o.base.getAccountInfo(config))!.data);
    await this.send(this.o.base, [syncHand({ config, delegationRecord: delegationRecordPda(t.runtime), seated: cfg.seated })], "sync_hand", false);
    st.lastCommitSecs = BigInt(Math.floor(Date.now() / 1000));
    st.departedSynced = rt.departed;
  }

  /** One step for one table. Returns what it did (for logs and tests). */
  async tick(config: PublicKey): Promise<Step> {
    const id = config.toBase58();
    const st = this.tables.get(id) ?? { lastCommitSecs: 0n, departedSynced: 0, backoffUntil: 0, failures: 0, hands: 0 };
    this.tables.set(id, st);
    if (Date.now() < st.backoffUntil) return { kind: "wait", why: "backing off after an error" };
    const rt = await this.readRuntime(config);
    if (!rt) return { kind: "wait", why: "runtime not readable in PER (not live, or token lacks access)" };
    const slot = BigInt(await this.o.per.getSlot());
    const step = decide(rt, {
      nowSecs: BigInt(Math.floor(Date.now() / 1000)), slot, lastCommitSecs: st.lastCommitSecs,
      heartbeatSecs: this.o.heartbeatSecs, handGapSecs: this.o.handGapSecs, departedSynced: st.departedSynced,
    });
    if (step.kind === "wait") return step;
    const payer = this.o.key.publicKey;
    const short = id.slice(0, 8);
    try {
      switch (step.kind) {
        case "start_hand": await this.send(this.o.per, [startHand({ payer, config })], step.kind); break;
        case "cancel_salts": await this.send(this.o.per, [cancelSalts({ payer, config })], step.kind); break;
        case "request_shuffle": await this.send(this.o.per, [requestShuffle({ payer, config })], step.kind); break;
        case "cancel_hand": await this.send(this.o.per, [cancelHand({ payer, config })], step.kind); break;
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
