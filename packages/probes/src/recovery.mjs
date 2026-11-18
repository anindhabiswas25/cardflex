#!/usr/bin/env node
// CF-013 Devnet outage drill (ADR 0004, gate G3).
//
// A 3-seat table with real buy-ins is delegated to the TEE PER. We commit +
// sync once (heartbeat), start a hand and deal it, then simulate a PER
// outage by never committing again. After the refund timeout anyone calls
// emergency_refund on the base layer: every wallet must get back exactly its
// last synced stack. Then PER "comes back" and commits: that commit must not
// be able to move money, and the hand must not be redealt.
//
// Usage: pnpm recovery -- --region <label>

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, delegationRecordPdaFromDelegatedAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PROGRAM_ID, repoRoot, send, rejected, waitFor, sleep, log, ms, w, r, u8, authFailures, RT, TC, SL, PHASE } from "./common.mjs";
import { setupTable } from "./table.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }

const SEATS = 3;
const BUY_IN = 10_000_000; // 0.01 SOL
const TIMEOUT = 60; // seconds (ADR 0004 minimum, for drills)
const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

const report = { probe: "CF-013-recovery", version: 1, region, started_at: new Date().toISOString(), checks: [], timings: {} };
const check = (group, name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  report.checks.push({ group, name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${group} / ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
};

let t;
try {
  t = await setupTable({ seats: SEATS, buyIn: BUY_IN, refundTimeout: TIMEOUT });
  const { ix, tee, base, authority, players, config, runtime, handLog, vault, ledgers, dealer, saltAccs, hands } = t;
  const cfg = async () => (await base.getAccountInfo(config)).data;
  const record = delegationRecordPdaFromDelegatedAccount(runtime);
  const commitIx = (payer) => ix("commit_hand", [w(payer.publicKey, true), w(runtime), w(handLog), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)]);
  const syncIx = (withLedgers) => ix("sync_hand", [w(config), r(runtime), r(record), ...(withLedgers ? ledgers.map((l) => w(l)) : [])]);
  const refundIx = (payer) => ix("emergency_refund", [r(payer.publicKey, true), w(config)]);
  const claimIx = (payer, s) => ix("claim_refund", [r(payer.publicKey, true), r(config), w(vault), w(ledgers[s]), w(players[s].wallet.publicKey)]);
  const baseCommitSeq = async () => { const a = await base.getAccountInfo(runtime); return a ? a.data.readBigUInt64LE(RT.commit_seq) : -1n; };

  // ---- money in ----
  let c = await cfg();
  check("money", "table ACTIVE with three seats bought in", [1, 0b111], [c[TC.status], c[TC.seated]]);
  check("money", "validator recorded at delegation", "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", new PublicKey(c.subarray(TC.validator, TC.validator + 32)).toBase58());
  for (let s = 0; s < SEATS; s++) {
    const l = (await base.getAccountInfo(ledgers[s])).data;
    check("money", `seat ${s} ledger synced_stack = buy-in`, String(BUY_IN), l.readBigUInt64LE(SL.synced_stack).toString());
  }

  // ---- heartbeat: commit in PER, sync on base ----
  log("heartbeat: commit_hand + sync_hand");
  const keeper = Keypair.generate();
  await send(base, [SystemProgram.transfer({ fromPubkey: t.payer.publicKey, toPubkey: keeper.publicKey, lamports: 20_000_000 })], [t.payer]);
  let t0 = performance.now();
  await send(tee, [commitIx(keeper)], [keeper], { skipPreflight: true });
  const landed = await waitFor(async () => ((await baseCommitSeq()) >= 1n ? true : null), 90_000, 500);
  report.timings.commit_to_base_ms = ms(t0);
  check("sync", "commit lands on the base layer", true, !!landed.value, `${report.timings.commit_to_base_ms} ms`);
  await send(base, [syncIx(true)], [keeper]);
  c = await cfg();
  check("sync", "sync_hand accepted (last_synced_seq = 1)", "1", c.readBigUInt64LE(TC.last_synced_seq).toString());
  check("sync", "replaying the same commit is rejected", true, await rejected(base, [syncIx(true)], [keeper]));
  const lastSync = Number(c.readBigInt64LE(TC.last_sync_time));

  // ---- a hand in progress ----
  log("start a hand and deal it");
  await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
  for (let s = 0; s < SEATS; s++) {
    await send(tee, [ix("submit_salt", [r(players[s].session.publicKey, true), w(runtime), w(saltAccs[s])], Buffer.concat([u8(s), randomBytes(32)]))], [players[s].session], { skipPreflight: true });
  }
  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
  const reqIx = (payer) => ix("request_shuffle", [w(payer.publicKey, true), w(runtime), r(dealer), w(EPHEMERAL_QUEUE), r(programIdentity), r(VRF_PROGRAM_ID), r(SYSVAR_SLOT_HASHES_PUBKEY), r(SystemProgram.programId)]);
  await send(tee, [reqIx(keeper)], [keeper], { skipPreflight: true });
  await waitFor(async () => ((await tee.getAccountInfo(runtime)).data[RT.phase] === PHASE.SEEDED ? true : null), 60_000, 150);
  const dealIx = (payer) => ix("deal_hand", [r(payer.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))]);
  await send(tee, [dealIx(keeper)], [keeper], { skipPreflight: true });
  check("hand", "hand dealt (mid-hand at outage)", PHASE.DEALT, (await tee.getAccountInfo(runtime)).data[RT.phase]);

  // ---- outage: nobody commits from here on ----
  log(`outage: no commits; waiting for the ${TIMEOUT}s refund timeout`);
  const bystander = Keypair.generate();
  await send(base, [SystemProgram.transfer({ fromPubkey: t.payer.publicKey, toPubkey: bystander.publicKey, lamports: 10_000_000 })], [t.payer]);
  check("refund", "refund before the timeout is rejected", true, await rejected(base, [refundIx(bystander)], [bystander]));
  const walletBefore = await Promise.all(players.map(async (p) => (await base.getBalance(p.wallet.publicKey))));
  const vaultBefore = await base.getBalance(vault);
  const waitMs = Math.max(0, (lastSync + TIMEOUT + 5) * 1000 - Date.now());
  await sleep(waitMs);
  t0 = performance.now();
  const refunded = await waitFor(async () => { await send(base, [refundIx(bystander)], [bystander], { retries: 0 }); return true; }, 90_000, 3000);
  report.timings.refund_after_last_sync_s = Math.round((Date.now() / 1000 - lastSync) * 10) / 10;
  check("refund", "a bystander can trigger emergency_refund after the timeout", true, !!refunded.value, `${report.timings.refund_after_last_sync_s}s after last sync`);
  // Each seat's payout is claimed independently (anyone may submit the claim).
  for (let s = 0; s < SEATS; s++) await send(base, [claimIx(bystander, s)], [bystander]);
  check("refund", "a second claim for seat 0 is rejected", true, await rejected(base, [claimIx(bystander, 0)], [bystander]));
  const walletAfter = await Promise.all(players.map(async (p) => (await base.getBalance(p.wallet.publicKey))));
  check("refund", "every wallet got back exactly its synced stack", players.map(() => BUY_IN), walletAfter.map((a, i) => a - walletBefore[i]));
  check("refund", "vault paid out exactly the total", SEATS * BUY_IN, vaultBefore - (await base.getBalance(vault)));
  c = await cfg();
  check("refund", "table status REFUNDED", 2, c[TC.status]);
  check("refund", "second refund rejected", true, await rejected(base, [refundIx(bystander)], [bystander]));

  // ---- PER comes back ----
  log("PER comes back: commit after the refund");
  await send(tee, [commitIx(keeper)], [keeper], { skipPreflight: true });
  const late = await waitFor(async () => ((await baseCommitSeq()) >= 2n ? true : null), 90_000, 500);
  check("late commit", "late commit lands on the base layer", true, !!late.value);
  check("late commit", "sync of the late commit rejected (no money moves)", true, await rejected(base, [syncIx(true)], [keeper]));
  check("late commit", "no redeal: second deal rejected", true, await rejected(tee, [dealIx(keeper)], [keeper]));
  check("late commit", "no redeal: new VRF request rejected", true, await rejected(tee, [reqIx(keeper)], [keeper]));

  // Tidy up PER: finish, reveal, then teardown closes and undelegates.
  await send(tee, [ix("end_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
  await send(tee, [ix("reveal_hand", [r(keeper.publicKey, true), w(runtime), r(dealer), w(handLog), ...saltAccs.map((a) => r(a))])], [keeper], { skipPreflight: true });
} catch (e) {
  report.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
try { if (t) report.timings.teardown_ok = !!(await t.teardown()).value; } catch (e) { report.teardown_error = String(e.message ?? e).slice(0, 200); }

report.auth_transient_failures = authFailures;
report.passed = report.checks.filter((c) => c.pass).length;
report.failed = report.checks.filter((c) => !c.pass).length;
report.ok = !report.error && report.failed === 0;
report.finished_at = new Date().toISOString();
const out = resolve(arg("out", `${repoRoot}/docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf013-recovery-${region}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`\nCF-013 outage drill — ${region} — ${report.ok ? "PASSED" : "FAILED"} (${report.passed} passed, ${report.failed} failed)`);
if (report.error) console.log(`error: ${report.error.split("\n")[0]}`);
for (const c of report.checks) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.group} / ${c.name}${c.note ? `  (${c.note})` : ""}`);
console.log(`timings: ${JSON.stringify(report.timings)}\nFull results: ${out}`);
process.exit(report.ok ? 0 : 1);
