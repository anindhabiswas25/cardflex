// CF-053 live drill on Devnet: a hand whose secret state is missing.
// We can't make the TEE lose state, but an operator can close a seat's salt
// account between hands (allowed) and then a hand starts without it: the
// same "needed ephemeral account doesn't exist" case. Checks:
//  - abort_lost_hand is refused while idle and while every account exists;
//  - it succeeds once one is missing: no strike, stacks untouched, counted;
//  - the keeper finds a stuck hand by itself (accounts are private, so it
//    just tries) and aborts it before the salt timeout would strike anyone;
//  - after re-opening the account the table plays a full hand again, the
//    hand verifies and the vault reconciles exactly.
// Usage: pnpm --filter @card-flex/keeper lost-drill   (needs the CF-053 program on Devnet)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, abortLostHand, act, buildIx, buyIn, decodeRuntime, decodeTableConfig, idl, joinSeat, loadVerifier,
  newSalt, newSessionKey, perConnection, perLogin, permissionPda, startHand, submitSalt, tableAddresses, verifierWasmUrl,
  type TableRuntime,
} from "@card-flex/client-sdk";
import { confirmByPolling } from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, closeTablePer, createTable, delegateTable, openTablePer } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errCode = (name: string) => idl.errors!.find((e) => e.name === name)!.code;

/** Sends and confirms; returns the error JSON instead of throwing when `expectFail`. */
async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false): Promise<string | null> {
  const tx = new Transaction().add(...ixs);
  const bh = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = bh.blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
  const err = await confirmByPolling(conn, sig);
  return err ? JSON.stringify(err) : null;
}
async function mustSend(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  for (let a = 0; ; a++) {
    try {
      const err = await send(conn, ixs, signers, skipPreflight);
      if (err) throw new Error(err);
      return;
    } catch (e) {
      // A retry after a lost confirmation finds the first attempt's account.
      if (a > 0 && String(e).includes("already in use")) return;
      if (a >= 2) throw e;
      await sleep(1000);
    }
  }
}

// ---- table with two players ----
const { config, ixs } = createTable(admin.publicKey, { tableId: BigInt(Date.now()), seats: 6, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 3600 });
const t = tableAddresses(config);
await mustSend(base, ixs, [admin]);
console.log("table", config.toBase58());
type Bot = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection };
const bots: Bot[] = [0, 1].map((seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat }));
for (const b of bots) {
  await mustSend(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.wallet.publicKey, lamports: 8_000_000 })], [admin]);
  await mustSend(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 1_000_000n, sessionKey: b.session.publicKey })], [b.wallet]);
  await mustSend(base, [joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
}
await mustSend(base, [delegateTable(admin.publicKey, config)], [admin]);
const per = perConnection((await perLogin(admin)).token);
for (let i = 0; i < 60 && !(await per.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const ix of openTablePer(admin.publicKey, config, 6)) await mustSend(per, [ix], [admin], true);
for (const b of bots) b.conn = perConnection((await perLogin(b.session)).token);
console.log("table live with 2 players");

const runtime = async (): Promise<TableRuntime> => decodeRuntime((await per.getAccountInfo(t.runtime))!.data);
async function waitPhase(phase: number, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const rt = await runtime();
    if (rt.phase === phase) return rt;
    if (Date.now() - t0 > ms) throw new Error(`phase ${rt.phase}, wanted ${phase}`);
    await sleep(300);
  }
}
const salt = (s: number, name: "open_salt" | "close_salt") =>
  buildIx(name, { authority: admin.publicKey, runtime: t.runtime, target: t.salt(s), permission: permissionPda(t.salt(s)) }, { seat: s });
const abort = (rt: TableRuntime) => abortLostHand({ payer: admin.publicKey, config, dealingOrder: rt.dealing_order.slice(0, rt.dealing_count) });
const notLost = `"Custom":${errCode("NotLost")}`;
const wrongPhase = `"Custom":${errCode("WrongPhase")}`;
async function startWhenAllowed() {
  for (let i = 0; i < 20; i++) {
    if (!(await send(per, [startHand({ payer: admin.publicKey, config })], [admin], true))) return waitPhase(PHASE.SALTS_PENDING);
    await sleep(1000); // HAND_GAP_SECS after the last hand
  }
  throw new Error("start_hand kept failing");
}

// ---- 1. refused while idle and while nothing is missing ----
{
  const rt = await runtime();
  const e = await send(per, [abort({ ...rt, dealing_order: [0, 1, 0, 0, 0, 0], dealing_count: 2 })], [admin], true);
  check("abort refused while no hand is in progress", !!e && e.includes(wrongPhase), e ?? "succeeded");
  const live = await startWhenAllowed();
  const e2 = await send(per, [abort(live)], [admin], true);
  const after = await runtime();
  check("abort refused while every secret account exists (NotLost)", !!e2 && e2.includes(notLost) && after.phase === PHASE.SALTS_PENDING && after.hand_no === live.hand_no, e2 ?? "succeeded");
  // End this hand the normal way: salt timeout (30 s).
  console.log("waiting for the salt deadline to cancel hand", live.hand_no);
  while (BigInt(Math.floor(Date.now() / 1000)) < live.salts_deadline + 2n) await sleep(1000);
  await mustSend(per, [buildIx("cancel_salts", { payer: admin.publicKey, runtime: t.runtime })], [admin], true);
  await waitPhase(PHASE.IDLE);
}

// ---- 2. a missing account: anyone can abort, nobody is punished ----
{
  await mustSend(per, [salt(1, "close_salt")], [admin], true);
  const live = await startWhenAllowed();
  await mustSend(bots[0].conn!, [submitSalt({ session: bots[0].session.publicKey, config, seat: 0, salt: newSalt() })], [bots[0].session], true);
  const before = await runtime();
  const e = await send(per, [abort(before)], [admin], true);
  const after = await waitPhase(PHASE.IDLE, 10_000).catch(() => null);
  check("abort succeeds inside PER when seat 1's salt account is missing", !e && !!after, e ?? undefined);
  if (after) {
    check("hand counted and moved on", Number(after.cancelled_hands) === Number(before.cancelled_hands) + 1 && after.hand_no === live.hand_no + 1n, `cancelled ${after.cancelled_hands}, hand ${after.hand_no}`);
    check("no stack moved", after.stacks.every((s, i) => s === before.stacks[i]));
    check("no strike for anyone", after.missed_salts.every((m, i) => m === before.missed_salts[i]), `missed ${after.missed_salts.slice(0, 2)}`);
  }
}

// ---- 3. the keeper finds a stuck hand by itself ----
const store = new Store();
const logs: string[] = [];
const keeper = new Keeper({
  base, per, key: admin, heartbeatSecs: 600n, handGapSecs: 4n, stuckSecs: 10,
  store, verifier: await loadVerifier(readFileSync(verifierWasmUrl)), log: (m) => { logs.push(m); console.log("  keeper:", m); },
});
{
  const live = await startWhenAllowed();
  const t0 = Date.now();
  let rt = live;
  while (Date.now() - t0 < 25_000) { // before the 30 s salt deadline
    await keeper.tick(config);
    rt = await runtime();
    if (rt.phase === PHASE.IDLE) break;
    await sleep(500);
  }
  check("keeper aborted the stuck hand before the salt timeout", rt.phase === PHASE.IDLE && logs.some((l) => l.includes("abort_lost_hand")), `${Math.round((Date.now() - t0) / 1000)} s`);
  check("still no strikes", rt.missed_salts.every((m, i) => m === live.missed_salts[i]));
}

// ---- 4. recovery: re-open the account, play a full hand ----
{
  await mustSend(per, [salt(1, "open_salt")], [admin], true);
  const start = await runtime();
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < 4 * 60_000) {
    await keeper.tick(config);
    const rt = await runtime();
    for (const b of bots) {
      const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(b.seat);
      if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> b.seat) & 1)) {
        await send(b.conn!, [submitSalt({ session: b.session.publicKey, config, seat: b.seat, salt: newSalt() })], [b.session], true).catch(() => {});
      } else if (rt.phase === PHASE.DEALT && rt.game.order[rt.game.turn] === b.seat) {
        await send(b.conn!, [act({ session: b.session.publicKey, config, action: ACTION.PACK, amount: 0n, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [b.session], true).catch(() => {});
      }
    }
    if ((keeper.tables.get(config.toBase58())?.hands ?? 0) >= 1) { done = true; break; }
    await sleep(400);
  }
  check("after re-opening, a full hand plays through", done, `from hand ${start.hand_no}`);
  const hands = store.db.prepare("SELECT hand_no, verified FROM hands WHERE config = ?").all(config.toBase58()) as { hand_no: string; verified: number }[];
  check("that hand is indexed and VALID", hands.length >= 1 && hands.every((h) => h.verified === 1), hands.map((h) => `#${h.hand_no}`).join(", "));
}

// ---- reconcile ----
const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
const tx = new Transaction().add(checkVault(config, cfg.seated, true));
tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
check("vault reconciles exactly (check_vault strict)", !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);

for (const ix of closeTablePer(admin.publicKey, config, 6)) await send(per, [ix], [admin], true).catch(() => {});
const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-053 lost-state drill — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); table ${config.toBase58()}`);
process.exit(failed ? 1 : 0);
