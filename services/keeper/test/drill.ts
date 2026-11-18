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
  ACTION, ENDPOINTS, PHASE, act, buyIn, cashOut, decodeLedger, decodeRuntime, decodeTableConfig, joinSeat, loadVerifier, newSalt,
  newSessionKey, perConnection, perLogin, rules, submitSalt, tableAddresses, verifierWasmUrl,
} from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, createTable, delegateTable, openTablePer, closeTablePer } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const HANDS = Number(process.env.HANDS ?? 3);
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  for (let a = 0; ; a++) {
    try {
      const tx = new Transaction().add(...ixs);
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash; tx.feePayer = signers[0].publicKey; tx.sign(...signers);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
      const r = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (r.value.err) throw new Error(JSON.stringify(r.value.err));
      return sig;
    } catch (e) {
      if (a >= 2) throw e;
      await sleep(1000);
    }
  }
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
const adminPer = perConnection((await perLogin(admin)).token);
for (let i = 0; i < 60 && !(await adminPer.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const ix of openTablePer(admin.publicKey, config, 6)) await send(adminPer, [ix], [admin], true);
for (const b of bots) b.conn = perConnection((await perLogin(b.session)).token);
console.log("table live with 3 bots (bot 2 absent)");

const keeperKey = Keypair.generate();
await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: keeperKey.publicKey, lamports: 30_000_000 })], [admin]);
const store = new Store();
const keeper = new Keeper({
  base, per: perConnection((await perLogin(admin)).token), key: keeperKey, heartbeatSecs: 600n, handGapSecs: 4n,
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
  await Promise.all([keeper.tick(config), ...bots.map(botStep)]);
  const st = keeper.tables.get(config.toBase58());
  const rt = decodeRuntime((await adminPer.getAccountInfo(t.runtime))!.data);
  if (!bot2LeftAt && (rt.departed >> 2) & 1) { bot2LeftAt = Date.now(); console.log(`bot 2 left after ${Math.round((bot2LeftAt - t0) / 1000)} s (missed salts: ${rt.missed_salts[2]})`); }
  if ((st?.hands ?? 0) >= HANDS) break;
  await sleep(400);
}
const st = keeper.tables.get(config.toBase58())!;
check(`keeper finished ${HANDS} hands unattended`, st.hands >= HANDS, `${st.hands} hands in ${Math.round((Date.now() - t0) / 1000)} s`);
check("absent bot 2 made to leave after 3 missed salt rounds", bot2LeftAt > 0);

// ---- indexed hands ----
const hands = store.db.prepare("SELECT hand_no, verified, end_reason FROM hands WHERE config = ?").all(config.toBase58()) as { hand_no: string; verified: number; end_reason: string }[];
check("every finished hand indexed by the keeper", hands.length >= HANDS, hands.map((h) => `#${h.hand_no} ${h.end_reason}`).join(", "));
check("every indexed hand VALID", hands.length > 0 && hands.every((h) => h.verified === 1));

// ---- bot 2 cashes out (keeper synced its leave) ----
const led2 = decodeLedger((await base.getAccountInfo(t.ledger(2)))!.data);
check("bot 2's ledger marked left by the keeper's sync", led2.left, `stack ${led2.synced_stack}`);
if (led2.left) {
  const before = await base.getBalance(led2.wallet);
  await send(base, [cashOut({ payer: admin.publicKey, config, seat: 2, wallet: led2.wallet })], [admin]);
  check("bot 2 cashed out exactly its full buy-in (it never played)", (await base.getBalance(led2.wallet)) - before >= 1_000_000, `${(await base.getBalance(led2.wallet)) - before} lamports incl. ledger rent`);
}

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
