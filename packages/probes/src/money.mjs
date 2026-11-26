#!/usr/bin/env node
// CF-035: P6 money drill on Devnet (ADR 0005). Proves, on a live table:
//  - a player buys in on the base layer while the table is delegated and
//    joins inside PER (join_seat reads the base ledger as a PER clone);
//  - a player leaves mid-hand, the leave applies at next_hand, commit + sync
//    mark the ledger left, cash_out pays exactly the final stack once;
//  - a new player takes the freed seat (new epoch); the old session key
//    loses access to that seat's hand;
//  - rake is swept to the treasury once;
//  - after every money step the vault reconciles to the lamport (check_vault
//    strict, plus the formula in JS), and money is conserved overall.
//
// Usage: pnpm money -- --region <label>
// Needs the current devnet POC build deployed (pnpm deploy:devnet).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, delegationRecordPdaFromDelegatedAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID, repoRoot, send, sleep, rejected, waitFor, log, ms, w, r, u8, authFailures,
  RT, PHASE, TC, SL, SL5, GLOBAL, GC, GAME, ACTION, teeConn, tokenFor, buyInIx, ledgerPda,
  NO_FEE_VAULT,
} from "./common.mjs";
import { setupTable } from "./table.mjs";

const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }

const BOOT = 25_000, BUY_IN = 40 * BOOT;
const report = { probe: "CF-035-money", version: 1, region, started_at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), checks: [], timings: {}, steps: [] };
const check = (group, name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  report.checks.push({ group, name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${group} / ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
};
const big = (x) => x.toString();

let t;
try {
  t = await setupTable({ seats: 6, players: 4, boot: BOOT, buyIn: BUY_IN, rakeBps: 250, rakeCap: 10_000 });
  const { ix, tee, base, authority, players, config, runtime, handLog, vault, dealer, hands, saltAccs } = t;
  const keeper = Keypair.generate();
  const record = delegationRecordPdaFromDelegatedAccount(runtime);
  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
  const treasury = new PublicKey((await base.getAccountInfo(GLOBAL)).data.subarray(GC.treasury, GC.treasury + 32));
  await send(base, [SystemProgram.transfer({ fromPubkey: t.payer.publicKey, toPubkey: keeper.publicKey, lamports: 20_000_000 })], [t.payer]);
  const conns = new Map(); // session pubkey -> PER connection
  const connFor = async (kp) => { const k = kp.publicKey.toBase58(); if (!conns.has(k)) conns.set(k, teeConn(await tokenFor(kp))); return conns.get(k); };
  const canRead = async (c, k) => { try { return !!(await c.getAccountInfo(k)); } catch { return false; } };
  let buyIns = BigInt(4 * BUY_IN), paidOut = 0n, swept = 0n;

  // ---- reconciliation after every money step ----
  const cfgData = async () => (await base.getAccountInfo(config)).data;
  async function reconcile(step) {
    const c = await cfgData();
    const seated = c[TC.seated];
    const ledgers = [];
    let owed = 0n;
    for (let s = 0; s < 6; s++) if ((seated >> s) & 1) { const l = ledgerPda(config, s); ledgers.push(l); owed += (await base.getAccountInfo(l)).data.readBigUInt64LE(SL.synced_stack); }
    const v = await base.getAccountInfo(vault);
    const rent = BigInt(await base.getMinimumBalanceForRentExemption(v.data.length));
    const unswept = c.readBigUInt64LE(TC.synced_rake) - c.readBigUInt64LE(TC.rake_swept);
    const expected = rent + owed + unswept;
    const tx = new Transaction().add(ix("check_vault", [r(config), r(vault), ...ledgers.map((l) => r(l))], Buffer.from([1])));
    tx.feePayer = keeper.publicKey;
    tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
    const sim = await base.simulateTransaction(tx);
    report.steps.push({ step, vault: big(v.lamports), rent: big(rent), synced_stacks: big(owed), unswept_rake: big(unswept), diff: big(BigInt(v.lamports) - expected) });
    check("reconcile", `${step}: vault = rent + synced stacks + unswept rake (exact)`, "0", big(BigInt(v.lamports) - expected));
    check("reconcile", `${step}: check_vault(strict) passes`, null, sim.value.err);
    // Conservation since the table opened: every lamport bought in is in the
    // vault (above rent), paid out, or in the treasury.
    check("reconcile", `${step}: buy-ins = vault − rent + cash-outs + swept rake`, big(buyIns), big(BigInt(v.lamports) - rent + paidOut + swept));
  }

  // ---- one hand: salts, VRF, deal, some bets, the game ends it, reveal ----
  async function playHand(h, { leaveSeat = null } = {}) {
    if (h > 0) await sleep(3_500); // program: HAND_GAP_SECS (3 s) since the last hand ended
    await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
    let d = await t.readRuntime();
    const order = [...d.subarray(RT.dealing_order, RT.dealing_order + d[RT.dealing_count])];
    for (const s of order) {
      await send(tee, [ix("submit_salt", [r(players[s].session.publicKey, true), w(runtime), w(saltAccs[s])], Buffer.concat([u8(s), randomBytes(32)]))], [players[s].session], { skipPreflight: true });
    }
    await send(tee, [ix("request_shuffle", [w(keeper.publicKey, true), w(runtime), r(dealer), w(EPHEMERAL_QUEUE), r(programIdentity), r(VRF_PROGRAM_ID), r(SYSVAR_SLOT_HASHES_PUBKEY), r(SystemProgram.programId)])], [keeper], { skipPreflight: true });
    const seeded = await waitFor(async () => ((await t.readRuntime())[RT.phase] === PHASE.SEEDED ? true : null), 60_000, 100);
    if (!check(`hand ${h}`, "VRF callback arrives", true, !!seeded.value)) throw new Error("no VRF");
    await send(tee, [ix("deal_hand", [r(keeper.publicKey, true), w(runtime), w(dealer), ...order.map((s) => w(hands[s]))])], [keeper], { skipPreflight: true });
    d = await t.readRuntime();
    check(`hand ${h}`, "dealt", PHASE.DEALT, d[RT.phase]);
    // Two betting turns, so money and rake actually move.
    for (let i = 0; i < order.length; i++) {
      d = await t.readRuntime();
      const s = d[GAME.order + d[GAME.turn]];
      try { await t.act(s, ACTION.CHAAL, "min", tee, { preflight: true }); } catch { /* sitting below the bet: fine */ }
      if (leaveSeat !== null && i === 0) {
        await send(tee, [ix("leave_seat", [r(players[leaveSeat].session.publicKey, true), w(runtime)], u8(leaveSeat))], [players[leaveSeat].session], { skipPreflight: true });
        const e = await t.readRuntime();
        check(`hand ${h}`, `seat ${leaveSeat} leave mid-hand: flagged, still in the hand`, [1, 1], [(e[RT.leaving] >> leaveSeat) & 1, (e[RT.occupied] >> leaveSeat) & 1]);
      }
    }
    check(`hand ${h}`, "only the game ended the hand", PHASE.HAND_COMPLETE, await t.packOut());
    await send(tee, [ix("reveal_hand", [r(keeper.publicKey, true), w(runtime), r(dealer), w(handLog), ...order.map((s) => r(saltAccs[s]))])], [keeper], { skipPreflight: true });
    await waitFor(async () => ((await t.readRuntime())[RT.phase] === PHASE.REVEALED ? true : null), 15_000, 100);
    await send(tee, [t.nextHandIx(keeper)], [keeper], { skipPreflight: true });
    return order;
  }

  // ---- commit + sync (base) ----
  async function commitAndSync(label) {
    const seqBefore = (await base.getAccountInfo(runtime)).data.readBigUInt64LE(RT.commit_seq);
    await send(tee, [ix("commit_hand", [w(authority.publicKey, true), w(runtime), w(handLog), r(NO_FEE_VAULT), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
    const landed = await waitFor(async () => ((await base.getAccountInfo(runtime)).data.readBigUInt64LE(RT.commit_seq) > seqBefore ? true : null), 90_000, 500);
    check(label, "commit lands on the base layer", true, !!landed.value, `${landed.ms} ms`);
    const seated = (await cfgData())[TC.seated];
    const ledgers = [0, 1, 2, 3, 4, 5].filter((s) => (seated >> s) & 1).map((s) => w(ledgerPda(config, s)));
    await send(base, [ix("sync_hand", [w(config), r(runtime), r(record), ...ledgers])], [keeper]);
  }

  // ===== step 1: four players, one hand =====
  log("step 1: four players play a hand; commit, sync, reconcile");
  await reconcile("setup");
  await playHand(0);
  await commitAndSync("hand 0");
  await reconcile("hand 0 synced");

  // ===== step 2: a fifth player buys in on base while live, joins in PER =====
  log("step 2: seat 4 buys in on the base layer and joins inside PER");
  const p4 = players[4];
  await send(base, [SystemProgram.transfer({ fromPubkey: t.payer.publicKey, toPubkey: p4.wallet.publicKey, lamports: BUY_IN + 5_000_000 })], [t.payer]);
  await send(base, [buyInIx(ix, p4.wallet.publicKey, config, vault, 4, BUY_IN, p4.session.publicKey)], [p4.wallet]);
  buyIns += BigInt(BUY_IN);
  await reconcile("seat 4 bought in (not yet joined)");
  const tJoin = performance.now();
  let attempts = 0;
  const joined = await waitFor(async () => {
    attempts++;
    try { await send(tee, [t.joinSeatPerIx(keeper, 4)], [keeper], { retries: 0 }); } catch { /* clone may lag */ }
    const d = await t.readRuntime();
    return (d[RT.occupied] >> 4) & 1 ? d : null;
  }, 60_000, 1_000);
  report.timings.join_in_per_ms = ms(tJoin);
  report.timings.join_attempts = attempts;
  check("join", "join_seat in PER reads the base ledger and seats seat 4", true, !!joined.value, `${attempts} attempt(s), ${report.timings.join_in_per_ms} ms`);
  if (joined.value) {
    check("join", "seat 4 stack = its buy-in, epoch 1", [big(BUY_IN), 1], [big(joined.value.readBigUInt64LE(RT.stacks + 32)), joined.value.readUInt32LE(RT.seat_epoch + 16)]);
    check("join", "a second join of the same ledger is refused", true, await rejected(tee, [t.joinSeatPerIx(keeper, 4)], [keeper]));
  }

  // ===== step 3: five players; seat 1 leaves mid-hand =====
  log("step 3: hand with five players; seat 1 leaves mid-hand");
  await playHand(1, { leaveSeat: 1 });
  const s4conn = await connFor(p4.session);
  check("join", "the joined player read its dealt hand", true, await canRead(s4conn, hands[4]));
  check("join", "seat 4's session can't read seat 0's hand", false, await canRead(s4conn, hands[0]));
  let d = await t.readRuntime();
  check("leave", "after next_hand seat 1 is departed, not occupied", [1, 0], [(d[RT.departed] >> 1) & 1, (d[RT.occupied] >> 1) & 1]);
  const finalStack1 = d.readBigUInt64LE(RT.stacks + 8);
  const w1 = players[1].wallet.publicKey;
  const cashOutIx = (wallet) => ix("cash_out", [r(keeper.publicKey, true), w(config), w(vault), w(ledgerPda(config, 1)), w(wallet)], u8(1));
  check("leave", "cash-out before the sync is refused", true, await rejected(base, [cashOutIx(w1)], [keeper]));
  await commitAndSync("hand 1");
  const l1 = (await base.getAccountInfo(ledgerPda(config, 1))).data;
  check("leave", "sync marks the ledger left with the final stack", [1, big(finalStack1)], [l1[SL5.left], big(l1.readBigUInt64LE(SL.synced_stack))]);
  await reconcile("hand 1 synced (seat 1 left)");
  check("leave", "cash-out to another wallet is refused", true, await rejected(base, [cashOutIx(keeper.publicKey)], [keeper]));
  const [wb, vb] = [await base.getBalance(w1), await base.getBalance(vault)];
  await send(base, [cashOutIx(w1)], [keeper]);
  const [wa, va] = [await base.getBalance(w1), await base.getBalance(vault)];
  paidOut += finalStack1;
  check("leave", "vault paid exactly the final stack", big(finalStack1), big(BigInt(vb - va)));
  check("leave", "wallet got at least the final stack (plus ledger rent)", true, BigInt(wa - wb) >= finalStack1);
  check("leave", "second cash-out refused", true, await rejected(base, [cashOutIx(w1)], [keeper]));
  await reconcile("seat 1 cashed out");

  // ===== step 4: a new player takes seat 1 =====
  log("step 4: a new player takes seat 1 (epoch 2)");
  const newcomer = players[5];
  const oldSession1 = players[1].session;
  await send(base, [SystemProgram.transfer({ fromPubkey: t.payer.publicKey, toPubkey: newcomer.wallet.publicKey, lamports: BUY_IN + 5_000_000 })], [t.payer]);
  await send(base, [buyInIx(ix, newcomer.wallet.publicKey, config, vault, 1, BUY_IN, newcomer.session.publicKey)], [newcomer.wallet]);
  buyIns += BigInt(BUY_IN);
  check("reuse", "new ledger for seat 1 has epoch 2", 2, (await base.getAccountInfo(ledgerPda(config, 1))).data.readUInt32LE(SL5.epoch));
  const rejoined = await waitFor(async () => {
    try { await send(tee, [t.joinSeatPerIx(keeper, 1)], [keeper], { retries: 0 }); } catch { /* clone may lag */ }
    const e = await t.readRuntime();
    return (e[RT.occupied] >> 1) & 1 ? e : null;
  }, 60_000, 1_000);
  check("reuse", "new player joins seat 1 in PER", true, !!rejoined.value);
  players[1] = newcomer; // table.mjs helpers act for players[s]
  await playHand(2);
  const newConn = await connFor(newcomer.session), oldConn = await connFor(oldSession1);
  check("reuse", "new seat-1 session reads seat 1's hand", true, await canRead(newConn, hands[1]));
  check("reuse", "old seat-1 session lost access to seat 1's hand", false, await canRead(oldConn, hands[1]));
  await commitAndSync("hand 2");
  await reconcile("hand 2 synced");

  // ===== step 5: rake to the treasury =====
  log("step 5: sweep rake");
  const c = await cfgData();
  const unswept = c.readBigUInt64LE(TC.synced_rake) - c.readBigUInt64LE(TC.rake_swept);
  check("rake", "some rake was collected", true, unswept > 0n, big(unswept));
  const sweepIx = ix("sweep_rake", [r(keeper.publicKey, true), w(config), w(vault), r(GLOBAL), w(treasury)]);
  const tb = await base.getBalance(treasury);
  await send(base, [sweepIx], [keeper]);
  swept += unswept;
  check("rake", "treasury received exactly the unswept rake", big(unswept), big(BigInt((await base.getBalance(treasury)) - tb)));
  check("rake", "second sweep refused", true, await rejected(base, [sweepIx], [keeper]));
  await reconcile("rake swept");
} catch (e) {
  report.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
try { if (t) report.teardown_ok = !!(await t.teardown()).value; } catch (e) { report.teardown_error = String(e.message ?? e).slice(0, 200); }

report.auth_transient_failures = authFailures;
report.finished_at = new Date().toISOString();
const passed = report.checks.filter((c) => c.pass).length, failed = report.checks.length - passed;
const out = resolve(repoRoot, `docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf035-money-${region}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`CF-035 money drill — ${region} — ${failed === 0 && !report.error ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)${report.error ? ` error: ${report.error.split("\n")[0]}` : ""}`);
console.log(`report: ${out}`);
process.exit(failed === 0 && !report.error ? 0 : 1);
