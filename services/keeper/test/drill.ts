// CF-051 live drill on Devnet: the keeper runs a table unattended.
// Three bot players buy in on the base layer and join inside PER. Bots 0 and
// 1 play (submit salts, take legal actions); bot 2 is "absent" (never submits
// a salt). The keeper alone advances everything else. Expected:
//  - salt rounds with bot 2 cancel; after 3 strikes bot 2 is made to leave,
//    the keeper syncs it and it can cash out exactly its stack;
//  - then hands play to the end; the keeper indexes every hand (verified);
//  - the vault reconciles exactly at the end.
// Usage: pnpm --filter @card-flex/keeper drill   (needs the CF-050 program on Devnet)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, act, buyIn, commitHand, isProgramError, magicFeeVault, cashOut, decodeLedger, decodeRuntime, decodeTableConfig, joinSeat, loadVerifier, newSalt,
  newSessionKey, perConnection, perLogin, rules, submitSalt, tableAddresses, verifierWasmUrl,
} from "@card-flex/client-sdk";
import { confirmByPolling, sendAndConfirm } from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, createTable, delegateTable, openTablePer, closeTablePer, setKeeper } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const HANDS = Number(process.env.HANDS ?? 3);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** PER logins time out now and then on Devnet (connect timeouts): retry. */
async function login(k: Keypair): Promise<Connection> {
  for (let a = 1; ; a++) { try { return perConnection((await perLogin(k)).token); } catch (e) { if (a >= 5) throw e; await sleep(2000 * a); } }
}

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  // CF-067: retries never resend a transaction that already landed.
  return sendAndConfirm(conn, ixs, signers, { skipPreflight });
}

// ---- table, players, keeper ----
const { config, ixs } = createTable(admin.publicKey, { tableId: BigInt(Date.now()), seats: 6, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 3600 });
const t = tableAddresses(config);
await send(base, ixs, [admin]);
console.log("table", config.toBase58());
type Bot = { wallet: Keypair; session: Keypair; seat: number; absent: boolean; conn?: Connection };
const bots: Bot[] = [0, 1, 2].map((seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat, absent: seat === 2 }));
for (const b of bots) {
  await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.wallet.publicKey, lamports: 8_000_000 })], [admin]);
  await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 1_000_000n, sessionKey: b.session.publicKey })], [b.wallet]);
  await send(base, [joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
}
await send(base, [delegateTable(admin.publicKey, config)], [admin]);
const adminPer = await login(admin);
for (let i = 0; i < 60 && !(await adminPer.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const ix of openTablePer(admin.publicKey, config, 6)) await send(adminPer, [ix], [admin], true);
for (const b of bots) b.conn = await login(b.session);
console.log("table live with 3 bots (bot 2 absent)");

const keeperKey = Keypair.generate();
await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: keeperKey.publicKey, lamports: 30_000_000 })], [admin]);
// CF-065: the keeper reads with its own key, named by the authority; no authority token.
const keeperPer = await login(keeperKey);
check("keeper key can't read the runtime before it is named", !(await keeperPer.getAccountInfo(t.runtime).catch(() => null)));
await send(adminPer, [setKeeper(admin.publicKey, config, keeperKey.publicKey, true)], [admin], true);
let keeperReads = false;
for (let i = 0; i < 20 && !keeperReads; i++) { keeperReads = !!(await keeperPer.getAccountInfo(t.runtime).catch(() => null)); if (!keeperReads) await sleep(500); }
check("keeper key reads the runtime after set_keeper", keeperReads);
const secret = [t.dealer, ...[0, 1, 2, 3, 4, 5].flatMap((s) => [t.seatHand(s), t.salt(s)])];
const leaks = (await keeperPer.getMultipleAccountsInfo(secret).catch(() => secret.map(() => null))).filter((a) => a !== null).length;
check("keeper key reads no dealer, seat hand or salt", leaks === 0, `${leaks} of ${secret.length} readable`);
// CF-059: empty seats' hands name only the default key (nobody holds it):
// unreadable by a stranger and by a seated player.
{
  const stranger = await login(Keypair.generate());
  const empty = [3, 4, 5].map((s) => t.seatHand(s));
  let readable = 0;
  for (const conn of [stranger, bots[0].conn!]) for (const a of empty) if (await conn.getAccountInfo(a).catch(() => null)) readable++;
  check("empty seats' hands (reader = default key) unreadable to a stranger and a player", readable === 0, `${readable} of 6 reads returned data`);
  const own = await bots[0].conn!.getAccountInfo(t.seatHand(0)).catch(() => null);
  check("…while a player still reads its own hand (the check can see data)", !!own);
}
const store = new Store();
const keeper = new Keeper({
  base, per: keeperPer, key: keeperKey, heartbeatSecs: 600n, handGapSecs: 4n, feeVault: magicFeeVault(),
  store, verifier: await loadVerifier(readFileSync(verifierWasmUrl)), log: (m) => console.log("  keeper:", m),
});

// ---- bot behaviour (what a real client does) ----
let roll = 0.41;
const rnd = () => (roll = (roll * 9301 + 49297) % 233280 / 233280);
async function botStep(b: Bot) {
  if (b.absent) return;
  const a = await b.conn!.getAccountInfo(t.runtime).catch(() => null);
  if (!a) return;
  const rt = decodeRuntime(a.data);
  const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(b.seat);
  if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> b.seat) & 1)) {
    await send(b.conn!, [submitSalt({ session: b.session.publicKey, config, seat: b.seat, salt: newSalt() })], [b.session], true).catch(() => {});
    return;
  }
  if (rt.phase !== PHASE.DEALT) return;
  const h = rules.Hand.fromGameState(rt.game);
  if (h.toAct() !== b.seat) return;
  const l = rules.legalActions(h, b.seat);
  let action: number = ACTION.PACK, amount = 0n;
  const r = rnd();
  if (l.respond) { action = ACTION.SIDE_SHOW_RESPOND; amount = r < 0.5 ? 1n : 0n; }
  else if (l.show && r < 0.5) action = ACTION.SHOW;
  else if (l.see && r < 0.3) action = ACTION.SEE;
  else if (l.chaal !== null && r < 0.95) { action = ACTION.CHAAL; amount = l.chaal; }
  await send(b.conn!, [act({ session: b.session.publicKey, config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [b.session], true).catch(() => {});
}

// ---- run ----
const t0 = Date.now();
let bot2LeftAt = 0;
while (Date.now() - t0 < 15 * 60_000) {
  // The production scheduler (run.ts) catches tick errors; so must the drill (PER connect timeouts happen).
  await Promise.all([keeper.tick(config).catch((e) => console.log("  tick error:", String(e?.message ?? e).slice(0, 100))), ...bots.map(botStep)]);
  const st = keeper.tables.get(config.toBase58());
  const ra = await adminPer.getAccountInfo(t.runtime).catch(() => null); // a network blip must not end the drill
  if (!ra) { await sleep(400); continue; }
  const rt = decodeRuntime(ra.data);
  if (!bot2LeftAt && (rt.departed >> 2) & 1) { bot2LeftAt = Date.now(); console.log(`bot 2 left after ${Math.round((bot2LeftAt - t0) / 1000)} s (missed salts: ${rt.missed_salts[2]})`); }
  if ((st?.hands ?? 0) >= HANDS) break;
  await sleep(400);
}
const st = keeper.tables.get(config.toBase58())!;
check(`keeper finished ${HANDS} hands unattended`, st.hands >= HANDS, `${st.hands} hands in ${Math.round((Date.now() - t0) / 1000)} s`);
check("absent bot 2 made to leave after 3 missed salt rounds", bot2LeftAt > 0);

// ---- CF-064: nobody can make the table pay for commits it doesn't need ----
{
  const stranger = Keypair.generate();
  const sp = await login(stranger);
  const spam = await send(sp, [commitHand({ payer: stranger.publicKey, config, feeVault: magicFeeVault() })], [stranger], true).then(() => null, (e) => e);
  check("stranger's extra commit right after the keeper's is refused (CommitNotNeeded)", spam !== null && isProgramError(spam, "CommitNotNeeded"), spam ? String(spam.message ?? spam).slice(0, 120) : "it landed");
}

// ---- indexed hands ----
const hands = store.db.prepare("SELECT hand_no, verified, end_reason FROM hands WHERE config = ?").all(config.toBase58()) as { hand_no: string; verified: number; end_reason: string }[];
check("every finished hand indexed by the keeper", hands.length >= HANDS, hands.map((h) => `#${h.hand_no} ${h.end_reason}`).join(", "));
check("every indexed hand VALID", hands.length > 0 && hands.every((h) => h.verified === 1));

// ---- bot 2 cashes out (keeper synced its leave) ----
// Bot 2 left (3 missed salt rounds): the keeper syncs it and, since the
// audit of 2026-11-21, pays it out itself (cash_out is permissionless).
const bot2 = bots[2].wallet.publicKey;
let led2Info = await base.getAccountInfo(t.ledger(2));
for (let i = 0; i < 30 && led2Info; i++) { await sleep(2000); led2Info = await base.getAccountInfo(t.ledger(2)); }
check("bot 2 was synced as departed and paid out by the keeper (ledger closed)", led2Info === null);
// It never played: everything comes back except two transaction fees.
const bal2 = await base.getBalance(bot2);
check("bot 2 got its full buy-in and ledger rent back", bal2 >= 8_000_000 - 20_000, `${bal2} lamports (funded 8,000,000)`);

// ---- reconcile ----
const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
const tx = new Transaction().add(checkVault(config, cfg.seated, true));
tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
check("vault reconciles exactly (check_vault strict)", !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);

// ---- tidy up ----
for (const ix of closeTablePer(admin.publicKey, config, 6)) await send(adminPer, [ix], [admin], true).catch(() => {});
const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-051 keeper drill — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); table ${config.toBase58()}`);
process.exit(failed ? 1 : 0);
void PublicKey;
