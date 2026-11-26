// CF-084 (ADR 0007) live drill on Devnet: a table plays a whole free-commit
// session, the keeper ends it, pays everyone, recycles the table with the
// operator key, and play resumes in a fresh session. Measures what the plan
// depends on:
//  - no commit is ever paid (the runtime's PER balance never drops);
//  - a session uses exactly FREE_COMMITS commits (23 hand commits incl.
//    heartbeats/leaves, end_session's commit, the close);
//  - how long the recycle (close + reopen) takes, and what it costs the operator;
//  - every player is paid exactly its synced stack; every hand verifies; the
//    vault reconciles; the free count starts again after the reopen.
// Usage: pnpm --filter @card-flex/keeper session-drill   (needs the CF-084 program on Devnet)
// Costs the deployer ~0.2 SOL (most of it comes back to the throwaway keys' table vault/rent).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, topUp, FREE_COMMITS, PHASE, SESSION_HAND_COMMITS, act, buyIn, decodeRuntime, decodeTableConfig, joinSeat, leaveSeat, loadVerifier, magicFeeVault,
  newSalt, newSessionKey, perConnection, perLogin, rpcTimeout, rules, sendAndConfirm, sessionCommits, submitSalt, tableAddresses, verifierWasmUrl,
} from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, createTable, setKeeper } from "../../admin/src/admin.ts";
import { closeTable, openTable } from "../../admin/src/recycle.ts";
import { Keeper } from "../src/keeper.ts";

const BOOT = 25_000n;
const BUY_IN = 200n * BOOT; // the maximum: bots that bust stop the table (one player left can't start a hand)
const SESSION2_HANDS = Number(process.env.SESSION2_HANDS ?? 2);
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, { commitment: "confirmed", ...rpcTimeout() });
const perUrl = ENDPOINTS.devnet.per;
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function login(k: Keypair): Promise<Connection> {
  for (let a = 1; ; a++) { try { return perConnection((await perLogin(k, perUrl)).token, perUrl); } catch (e) { if (a >= 5) throw e; await sleep(2000 * a); } }
}
const send = (conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) => sendAndConfirm(conn, ixs, signers, { skipPreflight });
const fund = (to: Keypair, lamports: number) => send(base, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to.publicKey, lamports })], [deployer]);

// ---- operator (table authority, model A), table, keeper ----
const operator = Keypair.generate();
await fund(operator, 150_000_000);
const { config, ixs } = createTable(operator.publicKey, { tableId: BigInt(Date.now()), seats: 6, boot: BOOT, rakeBps: 1000, rakeCap: BOOT / 2n, refundTimeoutSecs: 1800 });
const t = tableAddresses(config);
await send(base, ixs, [operator]);
console.log("table", config.toBase58(), "operator", operator.publicKey.toBase58());
const keeperKey = Keypair.generate();
await fund(keeperKey, 30_000_000);

type Bot = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection; toppedAt?: bigint };
const bots: Bot[] = [0, 1, 2].map((seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat }));
for (const b of bots) {
  await fund(b.wallet, 20_000_000);
  await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: BUY_IN, sessionKey: b.session.publicKey }), joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
}
const log = (m: string) => console.log("  ", m);
const recycleLog: string[] = [];
await openTable({ base, perUrl, authority: operator, config, log });
const opPer = await login(operator);
await send(opPer, [setKeeper(operator.publicKey, config, keeperKey.publicKey, true)], [operator], true);
for (const b of bots) b.conn = await login(b.session);
const keeperPer = await login(keeperKey);
const store = new Store();
const keeper = new Keeper({
  base, per: keeperPer, key: keeperKey, heartbeatSecs: 900n, handGapSecs: 4n, feeVault: magicFeeVault(), operator, perUrl,
  store, verifier: await loadVerifier(readFileSync(verifierWasmUrl)),
  log: (m) => { console.log("  keeper:", m); if (/recycled|closing|opened|delegated/.test(m)) recycleLog.push(m); },
});

// ---- bots: a real client's automatic steps (salts) and simple legal play ----
let roll = 0.37;
const rnd = () => (roll = (roll * 9301 + 49297) % 233280 / 233280);
async function botStep(b: Bot) {
  const a = await b.conn!.getAccountInfo(t.runtime).catch(() => null);
  if (!a) return;
  const rt = decodeRuntime(a.data);
  const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(b.seat);
  if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> b.seat) & 1)) {
    await send(b.conn!, [submitSalt({ session: b.session.publicKey, config, seat: b.seat, salt: newSalt() })], [b.session], true).catch(() => {});
    return;
  }
  // A short stack tops up between hands (CF-076), like a real player would.
  if (rt.phase === PHASE.IDLE && (rt.occupied >> b.seat) & 1 && rt.stacks[b.seat] < 20n * BOOT && b.toppedAt !== rt.hand_no && rt.credited[b.seat] < 400n * BOOT) {
    b.toppedAt = rt.hand_no;
    await send(base, [topUp({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 100n * BOOT })], [b.wallet]).then(() => console.log(`bot ${b.seat} topped up`)).catch(() => {});
    return;
  }
  if (rt.phase !== PHASE.DEALT) return;
  const h = rules.Hand.fromGameState(rt.game);
  if (h.toAct() !== b.seat) return;
  const l = rules.legalActions(h, b.seat);
  let action: number = ACTION.PACK, amount = 0n;
  const r = rnd();
  if (l.respond) { action = ACTION.SIDE_SHOW_RESPOND; amount = r < 0.5 ? 1n : 0n; }
  else if (l.show && r < 0.6) action = ACTION.SHOW;
  else if (l.see && r < 0.3) action = ACTION.SEE;
  else if (l.chaal !== null && r < 0.75) { action = ACTION.CHAAL; amount = l.chaal; }
  await send(b.conn!, [act({ session: b.session.publicKey, config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [b.session], true).catch(() => {});
}
const readLive = async () => { const a = await opPer.getAccountInfo(t.runtime).catch(() => null); return a ? { rt: decodeRuntime(a.data), lamports: a.lamports } : null; };

// ---- session 1: play until the keeper ends it and recycles the table ----
const first = (await readLive())!;
const lamportsAtStart = first.lamports;
const baseAtStart = first.rt.session_base_seq;
let minLamports = lamportsAtStart, endedAt = 0, recycleSecs = 0, handsSession1 = 0n, sessionUsedAtEnd = 0;
const opBefore = await base.getBalance(operator.publicKey);
const t0 = Date.now();
while (Date.now() - t0 < 40 * 60_000) {
  const st = keeper.tables.get(config.toBase58());
  const busy = st?.recycling;
  await Promise.all([keeper.tick(config).catch((e) => console.log("  tick error:", String(e?.message ?? e).slice(0, 100))), ...(busy ? [] : bots.map(botStep))]);
  if ((st?.sessions ?? 0) >= 1) { recycleSecs = Number(/recycled \S+ in (\d+) s/.exec(recycleLog.join(" "))?.[1] ?? -1); break; }
  const live = await readLive();
  if (live) {
    if (live.rt.session_base_seq === baseAtStart) minLamports = Math.min(minLamports, live.lamports);
    if (!endedAt && live.rt.occupied === 0 && live.rt.departed === 0b111) {
      endedAt = Date.now(); handsSession1 = live.rt.hand_no; sessionUsedAtEnd = sessionCommits(live.rt);
      console.log(`session ended after ${live.rt.hand_no} hands, ${sessionUsedAtEnd} commits used, ${Math.round((endedAt - t0) / 1000)} s`);
    }
  }
  await sleep(400);
}
check("the keeper ended the session once its hand commits were used", endedAt > 0 && sessionUsedAtEnd >= SESSION_HAND_COMMITS, `${handsSession1} hands, ${sessionUsedAtEnd} commits at the end`);
check("no commit was paid: the runtime's PER balance never dropped", minLamports >= lamportsAtStart, `${lamportsAtStart} → min ${minLamports} lamports`);
check("the keeper recycled the table (close + reopen)", (keeper.tables.get(config.toBase58())?.sessions ?? 0) >= 1, `${recycleSecs} s; ${recycleLog.join(" | ")}`);
const rtAfter = decodeRuntime((await base.getAccountInfo(t.runtime))!.data);
check("the session used exactly FREE_COMMITS commits (hands, leaves, end, close)", Number(rtAfter.session_base_seq - baseAtStart) === FREE_COMMITS, `${rtAfter.session_base_seq - baseAtStart} commits`);
const opAfter = await base.getBalance(operator.publicKey);
console.log(`operator paid ${opBefore - opAfter} lamports for the recycle (deposit forfeited + fees + runtime top-up)`);

// ---- everyone was paid exactly ----
for (const b of bots) {
  let gone = !(await base.getAccountInfo(t.ledger(b.seat)));
  for (let i = 0; i < 20 && !gone; i++) { await sleep(2000); gone = !(await base.getAccountInfo(t.ledger(b.seat))); }
  check(`bot ${b.seat} paid out (ledger closed)`, gone);
}
const hands1 = store.db.prepare("SELECT hand_no, verified FROM hands WHERE config = ?").all(config.toBase58()) as { hand_no: string; verified: number }[];
check("every session-1 hand indexed and VALID", hands1.length >= Number(handsSession1) - 1 && hands1.every((h) => h.verified === 1), `${hands1.length} hands`);

// ---- session 2: the same players sit down again and play ----
for (const b of bots) {
  b.session = newSessionKey();
  await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: BUY_IN, sessionKey: b.session.publicKey })], [b.wallet]);
  b.conn = await login(b.session);
}
const s2 = (await readLive())!;
const s2Lamports = s2.lamports, s2Hand0 = s2.rt.hand_no;
check("the reopened table starts a fresh session", sessionCommits(s2.rt) === 0, `${sessionCommits(s2.rt)} commits used`);
let min2 = s2Lamports;
const t1 = Date.now();
while (Date.now() - t1 < 10 * 60_000) {
  await Promise.all([keeper.tick(config).catch(() => {}), ...bots.map(botStep)]);
  const live = await readLive();
  if (live) { min2 = Math.min(min2, live.lamports); if (live.rt.hand_no >= s2Hand0 + BigInt(SESSION2_HANDS) && live.rt.phase === PHASE.IDLE) break; }
  await sleep(400);
}
const s2End = (await readLive())!;
check(`players sat down again and played ${SESSION2_HANDS} hands in session 2`, s2End.rt.hand_no >= s2Hand0 + BigInt(SESSION2_HANDS), `hand #${s2End.rt.hand_no}`);
check("session 2 commits are free too (runtime balance didn't drop)", min2 >= s2Lamports, `${s2Lamports} → min ${min2}`);

// ---- tidy up: everyone leaves, is paid, the table closes; then reconcile ----
for (const b of bots) await send(b.conn!, [leaveSeat({ signer: b.session.publicKey, config, seat: b.seat })], [b.session], true).catch(() => {});
const t2 = Date.now();
while (Date.now() - t2 < 3 * 60_000) {
  await keeper.tick(config).catch(() => {});
  const ls = await base.getMultipleAccountsInfo(bots.map((b) => t.ledger(b.seat)));
  if (ls.every((a) => !a)) break;
  await sleep(1000);
}
const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
check("all session-2 players paid out after leaving", cfg.seated === 0, `seated mask ${cfg.seated}`);
const tx = new Transaction().add(checkVault(config, cfg.seated, true));
tx.feePayer = deployer.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
check("vault reconciles exactly (check_vault strict)", !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);
await closeTable({ base, perUrl, authority: operator, config, log }).catch((e) => console.log("close:", String(e?.message ?? e).slice(0, 120)));

const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-084 session drill — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); table ${config.toBase58()}; recycle ${recycleSecs} s`);
process.exit(failed ? 1 : 0);
