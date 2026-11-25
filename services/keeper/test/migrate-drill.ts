// CF-067 live drill on Devnet: an existing table made by an older program
// (1,212-byte runtime) is migrated with `migrate_runtime` and then plays
// real hands under the current program.
// Usage: TABLE=<config of an old, undelegated table of the deployer> pnpm --filter @card-flex/keeper migrate-drill
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, act, buyIn, commitHand, decodeLedger, decodeRuntime, decodeTableConfig, isProgramError, joinSeat, loadVerifier, magicFeeVault,
  newSalt, newSessionKey, perConnection, perLogin, rules, sendAndConfirm, sizeOf, submitSalt, tableAddresses, verifierWasmUrl,
} from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { checkVault, closeTablePer, delegateTable, migrateRuntime, openTablePer, setKeeper } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const HANDS = Number(process.env.HANDS ?? 2);
const config = new PublicKey(process.env.TABLE ?? "");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const t = tableAddresses(config);
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** PER logins time out now and then on Devnet (connect timeouts): retry. */
async function login(k: Keypair): Promise<Connection> {
  for (let a = 1; ; a++) { try { return perConnection((await perLogin(k)).token); } catch (e) { if (a >= 5) throw e; await sleep(2000 * a); } }
}
const send = (conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) => sendAndConfirm(conn, ixs, signers, { skipPreflight });
const WANT = 8 + sizeOf({ defined: { name: "TableRuntime" } });

// ---- migrate ----
const r0 = (await base.getAccountInfo(t.runtime))!;
const cfg0 = decodeTableConfig((await base.getAccountInfo(config))!.data);
console.log(`table ${config.toBase58()}: runtime ${r0.data.length} bytes, seats ${cfg0.max_seats}, seated ${cfg0.seated.toString(2)}`);
if (r0.data.length === WANT) throw new Error("runtime is already current; pick an old table");
await send(base, [migrateRuntime(admin.publicKey, config, cfg0.seated)], [admin]);
const r1 = (await base.getAccountInfo(t.runtime))!;
check(`runtime grown ${r0.data.length} -> ${WANT} bytes`, r1.data.length === WANT);
check("every old byte kept", Buffer.compare(r0.data, r1.data.subarray(0, r0.data.length)) === 0);
// CF-076: `credited` (from byte 1,284) starts as each seated sit-down's deposits; the rest of the new bytes are zero.
check("new fields start at zero (no paid commit, no keeper)", r1.data.subarray(r0.data.length, Math.max(r0.data.length, 1284)).every((b) => b === 0));
const rt1 = decodeRuntime(r1.data);
const ls = await base.getMultipleAccountsInfo([0, 1, 2, 3, 4, 5].map((s) => t.ledger(s)));
check("credited = each seated sit-down's buy-in", [0, 1, 2, 3, 4, 5].every((s) => { const a = ls[s]; if (!a) return rt1.credited[s] === 0n; const l = decodeLedger(a.data); return l.epoch === rt1.seat_epoch[s] ? rt1.credited[s] === l.buy_in : rt1.credited[s] === 0n; }));
check("still rent-exempt", r1.lamports >= (await base.getMinimumBalanceForRentExemption(WANT)));
const again = await send(base, [migrateRuntime(admin.publicKey, config, cfg0.seated)], [admin]).then(() => null, (e) => e);
check("second migrate refused (BadRuntime)", again !== null && isProgramError(again, "BadRuntime"));

// ---- play on it ----
const seats = [0, 1, 2, 3, 4, 5].filter((s) => s < cfg0.max_seats && !((cfg0.seated >> s) & 1)).slice(0, 2);
type Bot = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection };
const bots: Bot[] = seats.map((seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat }));
// A table that was opened before stays `locked`: it seats players only in PER
// (after it is live), the way the keeper seats late arrivals.
const locked = decodeRuntime(r1.data).locked;
console.log(`runtime locked (opened before): ${locked}`);
for (const b of bots) {
  await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.wallet.publicKey, lamports: 8_000_000 })], [admin]);
  await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 40n * 25_000n, sessionKey: b.session.publicKey })], [b.wallet]);
  if (!locked) await send(base, [joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
}
if (!locked) check("players join the migrated table (base layer)", ((decodeRuntime((await base.getAccountInfo(t.runtime))!.data).occupied >> bots[1].seat) & 1) === 1);
const keeperKey = Keypair.generate();
await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: keeperKey.publicKey, lamports: 30_000_000 })], [admin]);
if (!locked) await send(base, [setKeeper(admin.publicKey, config, keeperKey.publicKey, false)], [admin]);
else {
  // Before delegating: the base-layer runtime is ours, but its permission lives in PER.
  const e = await sendAndConfirm(base, [setKeeper(admin.publicKey, config, keeperKey.publicKey, false)], [admin], { retries: 0 }).then(() => null, (x) => x);
  check("a locked table refuses set_keeper on the base layer with a clear error", e !== null && isProgramError(e, "PerAccountsMissing"));
}
await send(base, [delegateTable(admin.publicKey, config)], [admin]);
const adminPer = await login(admin);
for (let i = 0; i < 60 && !(await adminPer.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const [i, ix] of openTablePer(admin.publicKey, config, cfg0.max_seats).entries()) {
  // Reopened table: accounts that survived the last close fail to be re-created; that's fine.
  await send(adminPer, [ix], [admin], true).catch((e) => console.log(`  open step ${i + 1}: ${String(e.message ?? e).slice(0, 90)}`));
}
if (locked) {
  await send(adminPer, [setKeeper(admin.publicKey, config, keeperKey.publicKey, true)], [admin], true);
  for (const b of bots) await send(adminPer, [joinSeat({ payer: admin.publicKey, config, seat: b.seat, live: true })], [admin], true);
  check("players join the migrated table (in PER)", bots.every((b) => true) && ((decodeRuntime((await adminPer.getAccountInfo(t.runtime))!.data).occupied >> bots[1].seat) & 1) === 1);
}
for (const b of bots) b.conn = await login(b.session);
const keeperPer = await login(keeperKey);
check("keeper's own key reads the migrated table in PER", !!(await keeperPer.getAccountInfo(t.runtime).catch(() => null)));
const store = new Store();
const keeper = new Keeper({ base, per: keeperPer, key: keeperKey, heartbeatSecs: 600n, handGapSecs: 4n, feeVault: magicFeeVault(), store, verifier: await loadVerifier(readFileSync(verifierWasmUrl)), log: (m) => { if (/failed/.test(m)) console.log("  keeper:", m.slice(25, 180)); } });

let roll = 0.53;
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
  if (rt.phase !== PHASE.DEALT) return;
  const h = rules.Hand.fromGameState(rt.game);
  if (h.toAct() !== b.seat) return;
  const l = rules.legalActions(h, b.seat);
  let action: number = ACTION.PACK, amount = 0n;
  const r = rnd();
  if (l.respond) { action = ACTION.SIDE_SHOW_RESPOND; amount = r < 0.5 ? 1n : 0n; }
  else if (l.show && Number(rt.action_seq) >= 4) action = ACTION.SHOW;
  else if (l.chaal !== null) { action = ACTION.CHAAL; amount = l.chaal; }
  await send(b.conn!, [act({ session: b.session.publicKey, config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [b.session], true).catch(() => {});
}
const t0 = Date.now();
while (Date.now() - t0 < 10 * 60_000 && (keeper.tables.get(config.toBase58())?.hands ?? 0) < HANDS) {
  await Promise.all([keeper.tick(config), ...bots.map(botStep)]);
  await sleep(400);
}
const hands = keeper.tables.get(config.toBase58())?.hands ?? 0;
check(`${HANDS} hands played on the migrated table`, hands >= HANDS, `${hands} in ${Math.round((Date.now() - t0) / 1000)} s`);
const indexed = store.db.prepare("SELECT verified FROM hands WHERE config = ?").all(config.toBase58()) as { verified: number }[];
check("every hand indexed and VALID", indexed.length >= HANDS && indexed.every((x) => x.verified === 1), `${indexed.length}`);
const stranger = Keypair.generate();
const spam = await sendAndConfirm(await login(stranger), [commitHand({ payer: stranger.publicKey, config, feeVault: magicFeeVault() })], [stranger], { skipPreflight: true }).then(() => null, (e) => e);
check("spam commit refused on the migrated table (CF-064 fields work)", spam !== null && isProgramError(spam, "CommitNotNeeded"));

// ---- close and reconcile ----
for (const ix of closeTablePer(admin.publicKey, config, cfg0.max_seats, magicFeeVault())) await send(adminPer, [ix], [admin], true).catch(() => {});
for (let i = 0; i < 60; i++) { const r = await base.getAccountInfo(t.runtime); if (r?.owner.equals(new PublicKey("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL"))) break; await sleep(2000); }
const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
const tx = new Transaction().add(checkVault(config, cfg.seated, true));
tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
check("vault reconciles exactly after closing (check_vault strict)", !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);

const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-067 migrate drill — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); table ${config.toBase58()}`);
process.exit(failed ? 1 : 0);
