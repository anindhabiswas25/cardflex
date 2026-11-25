// CF-066 multi-user test on Devnet from ONE machine (stands in for CF-062
// until several machines are available). Every player is a separate user:
// own wallet, own session key, own PER login, own reads. Full six-seat tables.
// Per table:
//  - 5 players buy in and play from the start; each "thinks" 0.3–3 s before acting;
//  - a 6th player buys in while a hand is being played; the keeper must seat
//    them before the next hand and they must be dealt in;
//  - one player leaves after LEAVE_AFTER hands, is synced by the keeper and
//    cashes out (the vault pays exactly their synced stack);
//  - after every deal each dealt player reads ITS OWN hand (must work) and its
//    neighbour's (must not, before any Side Show).
// One keeper process (production scheduler, own read key, fee vault, indexer)
// drives all tables. At the end: every hand indexed and VALID, every vault
// exact (check_vault strict), keeper health ok, spam commit refused.
// Env: TABLES (3), HANDS per table (5), LEAVE_AFTER (2), MINUTES cap (20),
//      REGION (dev-machine-1), TICK_MS (700). Writes docs/probes/<ts>-cf066-multiuser-<T>x6-<region>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent } from "node:https";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, act, buyIn, cashOut, commitHand, sendAndConfirm, decodeLedger, decodeRuntime,
  decodeTableConfig, isProgramError, joinSeat, leaveSeat, loadVerifier, magicFeeVault, newSalt, newSessionKey, perConnection, perLogin,
  rules, submitSalt, tableAddresses, verifierWasmUrl, type TableRuntime,
} from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, closeTablePer, createTable, delegateTable, openTablePer, setKeeper } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";
import { runKeeper, type RunStatus } from "../src/run.ts";
import { health } from "../src/health.ts";

const T = Number(process.env.TABLES ?? 3);
const HANDS = Number(process.env.HANDS ?? 5);
const LEAVE_AFTER = Number(process.env.LEAVE_AFTER ?? 2);
const MINUTES = Number(process.env.MINUTES ?? 20);
const REGION = process.env.REGION ?? "dev-machine-1";
const TICK_MS = Number(process.env.TICK_MS ?? 700);
const SEATS = 6;
const BUY_IN = 1_000_000n;

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
const userAgent = new Agent({ keepAlive: true, maxSockets: Number(process.env.USER_SOCKETS ?? 32) });
const keeperAgent = new Agent({ keepAlive: true, maxSockets: 16 });

// ---- checks + metrics ----
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const lat = { act: [] as number[], salt: [] as number[], deal: [] as number[], ownHand: [] as number[] };
const fails = new Map<string, number>();
const fail = (k: string) => fails.set(k, (fails.get(k) ?? 0) + 1);
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });
process.on("unhandledRejection", (e) => { fail("unhandled"); console.error("unhandled:", String((e as Error)?.message ?? e).slice(0, 160)); });

async function retry<T>(f: () => Promise<T>, tries = 5): Promise<T> {
  for (let a = 1; ; a++) {
    try { return await f(); } catch (e) { if (a >= tries) throw e; fail("net-retry"); await sleep(1000 * a); }
  }
}
async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  await sendAndConfirm(conn, ixs, signers, { skipPreflight, retries: 0 }); // players don't blindly retry moves
}
/** Base-layer setup step: retried through blips; `done` says if an earlier attempt already landed. */
async function setupSend(ixs: TransactionInstruction[], signers: Keypair[]) {
  // CF-067: retried through blips; a copy that landed is never sent again.
  await sendAndConfirm(base, ixs, signers, { retries: 4, backoffMs: 1_500 });
}

// ---- users and tables ----
type User = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection; busy?: boolean; thinkUntil?: number; left?: boolean; leftDuring?: bigint; cashedOut?: boolean };
type Table = {
  config: PublicKey; users: User[]; late: User; leaver: User; lateBoughtAt?: bigint; lateDealtHand?: bigint; leftAt?: bigint;
  lastPhase: number; saltSeenAt: number; dealtSeenAt: number; handChecked: bigint;
};
const tables: Table[] = [];
const fund = async (to: PublicKey, lamports: number) => setupSend([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports })], [admin]);
const login = async (k: Keypair) => perConnection((await retry(() => perLogin(k))).token, undefined, "confirmed", userAgent);

const keeperKey = Keypair.generate();
console.log(`CF-066 multi-user: ${T} tables x ${SEATS} users (${T * SEATS} users), ${HANDS} hands each, region ${REGION}`);
const t0 = now();
const adminPer = perConnection((await retry(() => perLogin(admin))).token);
for (let i = 0; i < T; i++) {
  const { config, ixs } = createTable(admin.publicKey, { tableId: BigInt(Date.now()) * 100n + BigInt(i), seats: SEATS, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 1800 });
  await setupSend(ixs, [admin]);
  const t = tableAddresses(config);
  const users: User[] = Array.from({ length: SEATS }, (_, seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat }));
  for (const u of users) await fund(u.wallet.publicKey, 8_000_000);
  // Seats 0-4 start; seat 5 arrives mid-hand.
  for (const u of users.slice(0, 5)) {
    await setupSend([buyIn({ wallet: u.wallet.publicKey, config, seat: u.seat, amount: BUY_IN, sessionKey: u.session.publicKey })], [u.wallet]);
    await setupSend([joinSeat({ payer: u.wallet.publicKey, config, seat: u.seat, live: false })], [u.wallet]);
  }
  // CF-065: name the keeper's read key before delegating (stored; the permission is built at open).
  await setupSend([setKeeper(admin.publicKey, config, keeperKey.publicKey, false)], [admin]);
  // Like `cf-admin table open`: fund the runtime's reserve before delegating
  // (it pays commits once MagicBlock's free ones are used; CF-070/CF-073).
  await fund(t.runtime, 50_000_000);
  await setupSend([delegateTable(admin.publicKey, config)], [admin]);
  for (let k = 0; k < 60 && !(await adminPer.getAccountInfo(t.runtime).catch(() => null)); k++) await sleep(1000);
  for (const ix of openTablePer(admin.publicKey, config, SEATS)) await sendAndConfirm(adminPer, [ix], [admin], { retries: 2, skipPreflight: true });
  for (const u of users.slice(0, 5)) u.conn = await login(u.session);
  tables.push({ config, users: users.slice(0, 5), late: users[5], leaver: users[1], lastPhase: -1, saltSeenAt: 0, dealtSeenAt: 0, handChecked: -1n });
  console.log(`  table ${i + 1}/${T} live: ${config.toBase58()}`);
}
await fund(keeperKey.publicKey, 30_000_000 * T);
const setupSecs = (now() - t0) / 1000;

// ---- keeper: production scheduler, own read key ----
const keeperPer = perConnection((await retry(() => perLogin(keeperKey))).token, undefined, "confirmed", keeperAgent);
const store = new Store();
const keeper = new Keeper({
  base, per: keeperPer, key: keeperKey, heartbeatSecs: 300n, handGapSecs: 4n, feeVault: magicFeeVault(),
  store, verifier: await loadVerifier(readFileSync(verifierWasmUrl)),
  log: (m) => { if (/failed/.test(m)) { fail("keeper-step"); console.log("  keeper:", m.slice(25, 200)); } else if (/seated|aborted/.test(m)) console.log("  keeper:", m.slice(25)); },
});
const status: RunStatus = { startedAt: now(), lastReadAt: 0, lastScanAt: 0, tables: 0 };
let stop = false;
const keeperRun = runKeeper(keeper, { per: keeperPer, tables: async () => tables.map((tb) => tb.config), tickMs: 500, scanMs: 10_000, stop: () => stop, status, log: () => {} });

// ---- what a real client does ----
let roll = 0.29;
const rnd = () => (roll = (roll * 9301 + 49297) % 233280 / 233280);
function userStep(tb: Table, u: User, rt: TableRuntime) {
  if (u.busy || !u.conn) return;
  if (u.left && rt.hand_no !== u.leftDuring) return; // a leaver finishes the hand it asked during
  if (!((rt.occupied >> u.seat) & 1)) return;
  const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(u.seat);
  let ix: TransactionInstruction | null = null, kind = "";
  if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> u.seat) & 1)) {
    ix = submitSalt({ session: u.session.publicKey, config: tb.config, seat: u.seat, salt: newSalt() }); kind = "salt";
  } else if (rt.phase === PHASE.DEALT) {
    const h = rules.Hand.fromGameState(rt.game);
    if (h.toAct() !== u.seat) { u.thinkUntil = undefined; return; }
    if (u.thinkUntil === undefined) { u.thinkUntil = now() + 300 + rnd() * 2700; return; } // a person thinks
    if (now() < u.thinkUntil) return;
    u.thinkUntil = undefined;
    const l = rules.legalActions(h, u.seat);
    let action: number = ACTION.PACK, amount = 0n;
    const r = rnd();
    const seq = Number(rt.action_seq);
    if (u === tb.leaver && !l.respond) action = ACTION.PACK; // a careful player: keeps most of its buy-in, so its cash-out is a real amount
    else if (l.respond) { action = ACTION.SIDE_SHOW_RESPOND; amount = r < 0.5 ? 1n : 0n; }
    else if (l.see && r < 0.3) action = ACTION.SEE;
    else if (l.show && seq >= 10 && r < 0.5) action = ACTION.SHOW;
    else if (l.chaal !== null && (seq < 14 || r < 0.85) && r > 0.04) { action = ACTION.CHAAL; amount = l.chaal; }
    else if (l.show) action = ACTION.SHOW;
    ix = act({ session: u.session.publicKey, config: tb.config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) });
    kind = "act";
  }
  if (!ix) return;
  u.busy = true;
  const s0 = now();
  send(u.conn, [ix], [u.session], true)
    .then(() => (kind === "act" ? lat.act : lat.salt).push(now() - s0))
    .catch(() => fail(`user-${kind}`))
    .finally(() => { u.busy = false; });
}

/** After a deal: every dealt user polls its own hand (CF-006: don't trust the socket) and tries its neighbour's. */
const privacy = { ownOk: 0, ownMissing: 0, neighbourLeaks: 0, neighbourTries: 0 };
async function handChecks(tb: Table, rt: TableRuntime) {
  const t = tableAddresses(tb.config);
  const dealt = rt.dealing_order.slice(0, rt.dealing_count);
  await Promise.all(tb.users.filter((u) => dealt.includes(u.seat) && u.conn && !u.left).map(async (u) => {
    const s0 = now();
    let own = null;
    for (let k = 0; k < 10 && !own; k++) { own = await u.conn!.getAccountInfo(t.seatHand(u.seat)).catch(() => null); if (!own) await sleep(300); }
    if (own) { privacy.ownOk++; lat.ownHand.push(now() - s0); } else privacy.ownMissing++;
    const other = dealt[(dealt.indexOf(u.seat) + 1) % dealt.length];
    privacy.neighbourTries++;
    if (await u.conn!.getAccountInfo(t.seatHand(other)).catch(() => null)) privacy.neighbourLeaks++;
  }));
}

async function lateJoin(tb: Table, rt: TableRuntime) {
  const u = tb.late;
  tb.lateBoughtAt = rt.hand_no;
  await sendAndConfirm(base, [buyIn({ wallet: u.wallet.publicKey, config: tb.config, seat: u.seat, amount: BUY_IN, sessionKey: u.session.publicKey })], [u.wallet], { retries: 2 })
    ;
  u.conn = await login(u.session);
  tb.users.push(u);
  console.log(`  ${tb.config.toBase58().slice(0, 8)}: seat ${u.seat} bought in during hand #${rt.hand_no}`);
}

async function leave(tb: Table, rt: TableRuntime) {
  const u = tb.leaver;
  tb.leftAt = rt.hand_no;
  await sendAndConfirm(u.conn!, [leaveSeat({ signer: u.session.publicKey, config: tb.config, seat: u.seat })], [u.session], { retries: 2, skipPreflight: true });
  u.left = true;
  u.leftDuring = rt.hand_no;
  console.log(`  ${tb.config.toBase58().slice(0, 8)}: seat ${u.seat} asked to leave during hand #${rt.hand_no}`);
}

// ---- run ----
const runT0 = now();
const handsOf = (tb: Table) => keeper.tables.get(tb.config.toBase58())?.hands ?? 0;
const pending: Promise<unknown>[] = [];
while (now() - runT0 < MINUTES * 60_000) {
  await Promise.all(tables.map(async (tb) => {
    const reader = tb.users.find((u) => u.conn && !u.left && u.seat !== tb.late.seat)!;
    const info = await reader.conn!.getAccountInfo(tableAddresses(tb.config).runtime).catch(() => null);
    if (!info) return;
    const rt = decodeRuntime(info.data);
    if (rt.phase === PHASE.SALTS_PENDING) tb.saltSeenAt = now();
    if (rt.phase !== tb.lastPhase) {
      if (rt.phase === PHASE.DEALT && tb.saltSeenAt) { lat.deal.push(now() - tb.saltSeenAt); tb.saltSeenAt = 0; }
      tb.lastPhase = rt.phase;
    }
    if (rt.phase === PHASE.DEALT && rt.action_seq === 0n && tb.handChecked !== rt.hand_no) {
      tb.handChecked = rt.hand_no;
      pending.push(handChecks(tb, rt));
      if (tb.lateBoughtAt !== undefined && tb.lateDealtHand === undefined && rt.dealing_order.slice(0, rt.dealing_count).includes(tb.late.seat)) tb.lateDealtHand = rt.hand_no;
    }
    // Mid-hand events.
    if (rt.phase === PHASE.DEALT && tb.lateBoughtAt === undefined && handsOf(tb) >= 1) pending.push(lateJoin(tb, rt).catch(() => fail("late-join")));
    if (rt.phase === PHASE.DEALT && tb.leftAt === undefined && handsOf(tb) >= LEAVE_AFTER) pending.push(leave(tb, rt).catch(() => fail("leave")));
    for (const u of tb.users) userStep(tb, u, rt);
  }));
  // Cash out leavers once the keeper's sync marked their ledger left.
  for (const tb of tables) {
    const u = tb.leaver;
    if (!u.left || u.cashedOut) continue;
    const la = await base.getAccountInfo(tableAddresses(tb.config).ledger(u.seat)).catch(() => null);
    if (!la || !decodeLedger(la.data).left) continue;
    u.cashedOut = true;
    pending.push((async () => {
      const owed = decodeLedger(la.data).synced_stack;
      const ta = tableAddresses(tb.config);
      // The keeper pays departed players itself (CF-070), so it may win the
      // race: that's fine. Either way the payout must be exact: find the
      // transaction that closed the ledger and read the vault's and wallet's
      // balance changes from the chain.
      await sendAndConfirm(base, [cashOut({ payer: u.wallet.publicKey, config: tb.config, seat: u.seat, wallet: u.wallet.publicKey })], [u.wallet], { retries: 2 })
        .catch((e) => { if (!isProgramError(e, "AccountNotInitialized") && !/3012/.test(String((e as Error).message ?? e))) throw e; });
      let paid: { by: string; vaultOut: bigint; walletIn: bigint } | null = null;
      for (let k = 0; k < 10 && !paid; k++) {
        for (const sg of await base.getSignaturesForAddress(ta.ledger(u.seat), { limit: 6 }, "confirmed")) {
          const tx = sg.err ? null : await base.getTransaction(sg.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (!tx?.meta) continue;
          const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
          const v = keys.findIndex((k2) => k2.equals(ta.vault)), w = keys.findIndex((k2) => k2.equals(u.wallet.publicKey));
          if (v < 0 || w < 0) continue;
          const vaultOut = BigInt(tx.meta.preBalances[v] - tx.meta.postBalances[v]);
          if (vaultOut === BigInt(owed)) { paid = { by: keys[0].equals(u.wallet.publicKey) ? "itself" : "the keeper", vaultOut, walletIn: BigInt(tx.meta.postBalances[w] - tx.meta.preBalances[w]) }; break; }
        }
        if (!paid) await sleep(2000);
      }
      const ledgerGone = !(await base.getAccountInfo(ta.ledger(u.seat)));
      check(`${tb.config.toBase58().slice(0, 8)}: leaver paid exactly its synced stack`, owed > 0n && ledgerGone && !!paid && paid.walletIn >= BigInt(owed) - 10_000n, paid ? `${owed} lamports by ${paid.by}` : `${owed} lamports: payout not found`);
    })().catch((e) => { fail("cash-out"); console.log("  cash-out failed:", String(e.message ?? e).slice(0, 120)); }));
  }
  if (tables.every((tb) => handsOf(tb) >= HANDS && tb.leaver.cashedOut)) break;
  await sleep(TICK_MS);
}
await Promise.allSettled(pending);
const runSecs = (now() - runT0) / 1000;

// ---- spam commit is refused (CF-064) ----
{
  const stranger = Keypair.generate();
  const sp = perConnection((await retry(() => perLogin(stranger))).token);
  const e = await send(sp, [commitHand({ payer: stranger.publicKey, config: tables[0].config, feeVault: magicFeeVault() })], [stranger], true).then(() => null, (x) => x);
  check("stranger's commit right after the keeper's is refused (CF-064)", e !== null && isProgramError(e, "CommitNotNeeded"), e ? undefined : "it landed");
}
const h = health(keeper.tables, status);
stop = true;
await keeperRun;

// ---- results ----
for (const tb of tables) {
  const id = tb.config.toBase58().slice(0, 8);
  check(`${id}: ${HANDS}+ hands played`, handsOf(tb) >= HANDS, `${handsOf(tb)}`);
  check(`${id}: player who bought in mid-hand was dealt into a later hand`, tb.lateDealtHand !== undefined && tb.lateBoughtAt !== undefined && tb.lateDealtHand > tb.lateBoughtAt, `bought in #${tb.lateBoughtAt}, dealt #${tb.lateDealtHand}`);
  check(`${id}: leaver synced and cashed out`, !!tb.leaver.cashedOut);
  const cfg = decodeTableConfig((await retry(() => base.getAccountInfo(tb.config)))!.data);
  const tx = new Transaction().add(checkVault(tb.config, cfg.seated, true));
  tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
  const sim = await retry(() => base.simulateTransaction(tx));
  check(`${id}: vault reconciles exactly (check_vault strict)`, !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);
}
const indexed = tables.flatMap((tb) => store.db.prepare("SELECT verified, end_reason FROM hands WHERE config = ?").all(tb.config.toBase58()) as { verified: number; end_reason: string }[]);
const endReasons = indexed.reduce<Record<string, number>>((m, x) => ((m[x.end_reason] = (m[x.end_reason] ?? 0) + 1), m), {});
check("every finished hand indexed and VALID", indexed.length >= T * HANDS && indexed.every((x) => x.verified === 1), `${indexed.length} hands`);
check("every dealt player read its own hand", privacy.ownMissing === 0 && privacy.ownOk > 0, `${privacy.ownOk} reads, ${privacy.ownMissing} missing`);
check("no player read a neighbour's hand", privacy.neighbourLeaks === 0, `${privacy.neighbourTries} tries`);
check("keeper health ok at the end", h.ok, h.reasons.join("; ") || undefined);

// ---- tidy up ----
const closer = perConnection((await retry(() => perLogin(admin))).token);
for (const tb of tables) for (const ix of closeTablePer(admin.publicKey, tb.config, SEATS, magicFeeVault())) await send(closer, [ix], [admin], true).catch(() => {});

const report = {
  ticket: "CF-066", region: REGION, at: new Date().toISOString(), tables: T, usersPerTable: SEATS, users: T * SEATS, handsTarget: HANDS,
  setupSecs, runSecs, handsCompleted: tables.reduce((s, tb) => s + handsOf(tb), 0),
  actionConfirmMs: summary(lat.act), saltConfirmMs: summary(lat.salt), saltsToDealtMs: summary(lat.deal), ownHandVisibleMs: summary(lat.ownHand),
  privacy, endReasons, failures: Object.fromEntries(fails), keeperHealth: { ok: h.ok, reasons: h.reasons },
  checks: checks.map(([name, ok, note]) => ({ name, ok, note })),
};
const probes = new URL("../../../docs/probes/", import.meta.url).pathname;
mkdirSync(probes, { recursive: true });
const file = `${probes}${report.at.replace(/[:.]/g, "-")}-cf066-multiuser-${T}x6-${REGION}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, checks: undefined }, null, 2));
const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-066 multi-user — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); wrote ${file}`);
process.exit(failed ? 1 : 0);
