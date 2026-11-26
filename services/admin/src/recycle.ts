// CF-084 (ADR 0007): close a table and open it again, so its next session
// gets MagicBlock's free commits afresh. Used by `cf-admin table recycle` and
// by the keeper when a session is over and everyone has left.
//
// Signed by the TABLE AUTHORITY. For tables the keeper recycles on its own
// this is a dedicated operator key (never the program's upgrade authority):
// it can open, close and repair tables, but no instruction lets it move
// players' money (ADR 0007).
import { Connection, Keypair, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, decodeRuntime, decodeTableConfig, magicFeeVault, perConnection, perLogin, sendAndConfirm, sessionCommits, tableAddresses } from "@card-flex/client-sdk";
import { closeTablePer, delegateTable, openTablePer } from "./admin.ts";

export type RecycleOpts = {
  base: Connection;
  perUrl: string;
  /** The table's authority. */
  authority: Keypair;
  config: PublicKey;
  /** Lamports the runtime should hold above its rent before delegating (PER accounts + margin). */
  reserve?: bigint;
  log?: (m: string) => void;
  /** How long to wait for the undelegation to reach the base layer. */
  undelegateTimeoutMs?: number;
};

/** Runtime headroom kept above rent when reopening: the PER secret accounts (~0.0071 SOL) and a margin. */
export const RECYCLE_RESERVE = 12_000_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendEach(conn: Connection, ixs: TransactionInstruction[], kp: Keypair, label: (i: number) => string, log: (m: string) => void, tolerate: RegExp) {
  let ok = 0;
  for (const [i, ix] of ixs.entries()) {
    try {
      await sendAndConfirm(conn, [ix], [kp], { skipPreflight: true, retries: 2, backoffMs: 1_500 });
      ok++;
    } catch (e) {
      const m = String((e as Error).message ?? e);
      // Accounts that survive a close (permissions in PER) or don't exist any more fail harmlessly.
      if (!tolerate.test(m)) log(`  ${label(i)}: ${m.slice(0, 140)}`);
    }
  }
  return ok;
}

/** Close: PER secret accounts, then undelegate (one commit). Resolves once the base layer owns the runtime again. */
export async function closeTable(o: RecycleOpts) {
  const log = o.log ?? (() => {});
  const t = tableAddresses(o.config);
  const cfg = decodeTableConfig((await o.base.getAccountInfo(o.config))!.data);
  const per = perConnection((await perLogin(o.authority, o.perUrl)).token, o.perUrl);
  const rt = await per.getAccountInfo(t.runtime);
  if (rt) log(`closing ${o.config.toBase58().slice(0, 8)} after ${sessionCommits(decodeRuntime(rt.data))} commits this session`);
  await sendEach(per, closeTablePer(o.authority.publicKey, o.config, cfg.max_seats, magicFeeVault()), o.authority, (i) => `close step ${i + 1}`, log, /not found|AccountNotInitialized|InvalidAccountData|already/i);
  const until = Date.now() + (o.undelegateTimeoutMs ?? 120_000);
  while (Date.now() < until) {
    const a = await o.base.getAccountInfo(t.runtime).catch(() => null);
    if (a?.owner.equals(PROGRAM_ID)) return;
    await sleep(2_000);
  }
  throw new Error("undelegation didn't reach the base layer in time");
}

/** Open: top up the runtime to rent + reserve, delegate, create permissions and every secret account. */
export async function openTable(o: RecycleOpts) {
  const log = o.log ?? (() => {});
  const t = tableAddresses(o.config);
  const [c, r] = await o.base.getMultipleAccountsInfo([o.config, t.runtime]);
  if (!c || !r) throw new Error(`no table at ${o.config.toBase58()}`);
  const cfg = decodeTableConfig(c.data);
  const ixs: TransactionInstruction[] = [];
  if (r.owner.equals(PROGRAM_ID)) {
    const want = BigInt(await o.base.getMinimumBalanceForRentExemption(r.data.length)) + (o.reserve ?? RECYCLE_RESERVE);
    const have = BigInt(r.lamports);
    if (have < want) ixs.push(SystemProgram.transfer({ fromPubkey: o.authority.publicKey, toPubkey: t.runtime, lamports: want - have }));
    ixs.push(delegateTable(o.authority.publicKey, o.config));
    await sendAndConfirm(o.base, ixs, [o.authority], { retries: 2, backoffMs: 1_500 });
    log(`delegated ${o.config.toBase58().slice(0, 8)}${have < want ? ` (runtime topped up ${want - have} lamports)` : ""}`);
  }
  const per = perConnection((await perLogin(o.authority, o.perUrl)).token, o.perUrl);
  for (let i = 0; i < 60; i++) {
    const a = await per.getAccountInfo(t.runtime).catch(() => null);
    if (a?.owner.equals(PROGRAM_ID)) break;
    await sleep(1_000);
  }
  // Permissions of a table opened before survive in PER (their create fails
  // with InvalidAccountData); the dealer, seat hands and salts were closed
  // and are created again. Same as `table open` + `table repair`.
  const made = await sendEach(per, openTablePer(o.authority.publicKey, o.config, cfg.max_seats), o.authority, (i) => `open step ${i + 1}`, log, /InvalidAccountData|already in use/i);
  log(`opened ${o.config.toBase58().slice(0, 8)}: ${made} PER account(s) created`);
}

/** Close, then open: a new session with a fresh free-commit budget. */
export async function recycleTable(o: RecycleOpts) {
  const t0 = Date.now();
  await closeTable(o);
  await openTable(o);
  (o.log ?? (() => {}))(`recycled ${o.config.toBase58().slice(0, 8)} in ${Math.round((Date.now() - t0) / 1000)} s`);
}
