#!/usr/bin/env node
// CF-025: a full six-player game on Devnet PER, several hands in a row.
// Every hand: start -> salts -> VRF -> deal -> players bet (random legal-ish
// policy; illegal choices are refused by the program and retried) -> the game
// ends the hand -> reveal -> cf-verify (deck AND game result) -> Side Show
// views revoked -> commit -> sync to the base layer -> next_hand.
// Checks lamport conservation and that the synced ledgers equal the stacks.
//
// Usage: pnpm game -- --region <label> [--hands 3]
// Needs the devnet POC build deployed (pnpm deploy:devnet).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, delegationRecordPdaFromDelegatedAccount } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID, repoRoot, send, sleep, waitFor, log, ms, w, r, u8, authFailures,
  RT, PHASE, HAND, HL, GAME, ACTION, SL, teeConn, tokenFor, handRecordFromLog,
} from "./common.mjs";
import { setupTable } from "./table.mjs";

const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }
const HANDS = Number(arg("hands", "3"));
const SEATS = 6, BOOT = 25_000, BUY_IN = 40 * BOOT, RAKE_BPS = 250, RAKE_CAP = 10_000;

const report = { probe: "CF-025-game", version: 1, region, started_at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), hands: [], checks: [], timings: {} };
const check = (group, name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  report.checks.push({ group, name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${group} / ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
};

// Deterministic per run, so a failure can be replayed from the report.
let rng = BigInt(`0x${randomBytes(8).toString("hex")}`) | 1n;
report.rng_seed = rng.toString();
const rnd = (n) => { rng ^= (rng << 13n) & 0xffffffffffffffffn; rng ^= rng >> 7n; rng ^= (rng << 17n) & 0xffffffffffffffffn; return Number(rng % BigInt(n)); };

let t;
try {
  t = await setupTable({ seats: SEATS, boot: BOOT, buyIn: BUY_IN, rakeBps: RAKE_BPS, rakeCap: RAKE_CAP });
  const { ix, tee, base, authority, players, config, runtime, handLog, dealer, hands, saltAccs, ledgers } = t;
  const keeper = Keypair.generate();
  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
  const record = delegationRecordPdaFromDelegatedAccount(runtime);
  const sessionConns = [];
  for (const p of players) sessionConns.push(teeConn(await tokenFor(p.session)));
  const total = BigInt(SEATS * BUY_IN);

  for (let h = 0; h < HANDS; h++) {
    const hr = { hand: h, actions: [], refused: 0 };
    report.hands.push(hr);
    const tHand = performance.now();
    log(`hand ${h}: start, salts, VRF, deal`);
    if (h > 0) await sleep(3_500); // program: HAND_GAP_SECS (3 s) since the last hand ended
    await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
    let d = await t.readRuntime();
    const order = [...d.subarray(RT.dealing_order, RT.dealing_order + d[RT.dealing_count])];
    hr.dealing_order = order;
    hr.button = d[RT.button];
    hr.hand_no = d.readBigUInt64LE(RT.hand_no).toString();
    for (const s of order) {
      await send(tee, [ix("submit_salt", [r(players[s].session.publicKey, true), w(runtime), w(saltAccs[s])], Buffer.concat([u8(s), randomBytes(32)]))], [players[s].session], { skipPreflight: true });
    }
    await send(tee, [ix("request_shuffle", [w(keeper.publicKey, true), w(runtime), r(dealer), w(EPHEMERAL_QUEUE), r(programIdentity), r(VRF_PROGRAM_ID), r(SYSVAR_SLOT_HASHES_PUBKEY), r(SystemProgram.programId)])], [keeper], { skipPreflight: true });
    const seeded = await waitFor(async () => ((await t.readRuntime())[RT.phase] === PHASE.SEEDED ? true : null), 60_000, 100);
    if (!check(`hand ${h}`, "VRF callback arrives", true, !!seeded.value)) break;
    await send(tee, [ix("deal_hand", [r(keeper.publicKey, true), w(runtime), w(dealer), ...order.map((s) => w(hands[s]))])], [keeper], { skipPreflight: true });
    d = await t.readRuntime();
    check(`hand ${h}`, "dealt", PHASE.DEALT, d[RT.phase]);
    check(`hand ${h}`, "boots collected into the pot", BigInt(order.length * BOOT).toString(), d.readBigUInt64LE(GAME.pot).toString());
    // Each player polls only its own hand (WebSocket is unreliable; CF-006).
    const shown = [];
    for (const s of order) {
      const got = await waitFor(async () => { const a = await sessionConns[s].getAccountInfo(hands[s]); return a && a.data[HAND.positions + 1] !== 0 && a.data.readBigUInt64LE(41) === d.readBigUInt64LE(RT.hand_no) ? a : null; }, 15_000, 150);
      if (got.value) shown.push({ seat: s, cards: [...got.value.data.subarray(HAND.cards, HAND.cards + 3)] });
    }
    check(`hand ${h}`, "every dealt player reads its own hand", order.length, shown.length);
    report.timings[`hand${h}_deal_ms`] = ms(tHand);

    // ---- betting ----
    log(`hand ${h}: betting`);
    for (let step = 0; step < 80; step++) {
      d = await t.readRuntime();
      if (d[RT.phase] !== PHASE.DEALT) break;
      const pending = d[GAME.phase] === 1;
      const s = pending ? d[GAME.ss_target] : d[GAME.order + d[GAME.turn]];
      const seen = d[GAME.seats + GAME.seat_len * s + 2] === 1;
      const choices = pending
        ? [[ACTION.SIDE_SHOW_RESPOND, rnd(2) ? 1n : 0n]]
        : [
            ...(seen ? [] : [[ACTION.SEE, 0n]]),
            [ACTION.CHAAL, "min"], [ACTION.CHAAL, "min"], [ACTION.CHAAL, "double"],
            [ACTION.SHOW, 0n], [ACTION.SIDE_SHOW, 0n], [ACTION.PACK, 0n],
          ];
      const [code, amount] = choices[rnd(choices.length)];
      try {
        // Preflight on: an illegal choice is refused by simulation, fast.
        const after = await t.act(s, code, amount, tee, { preflight: true });
        hr.actions.push([s, code]);
        // CF-022: right after an accepted Side Show, grant the mutual view
        // (permissionless) and check both players can read each other.
        if (pending && amount === 1n) {
          const req = d[GAME.ss_requester];
          const sv = [...after.subarray(RT.side_show_viewers, RT.side_show_viewers + SEATS)];
          if ((sv[s] >> req) & 1 && after[RT.phase] === PHASE.DEALT) {
            await send(tee, [t.sideShowViewIx(req, s, true, keeper)], [keeper], { skipPreflight: true });
            const canRead = async (c, k) => { try { return !!(await c.getAccountInfo(k)); } catch { return false; } };
            const both = await waitFor(async () => ((await canRead(sessionConns[req], hands[s])) && (await canRead(sessionConns[s], hands[req])) ? true : null), 10_000, 200);
            check(`hand ${h}`, `Side Show ${req}<->${s}: both read each other's hand`, true, !!both.value);
            hr.side_show_grants = (hr.side_show_grants ?? 0) + 1;
          }
        }
      } catch { hr.refused++; }
    }
    if ((await t.readRuntime())[RT.phase] === PHASE.DEALT) { log(`hand ${h}: action cap reached, packing out`); await t.packOut(); }
    d = await t.readRuntime();
    check(`hand ${h}`, "only the game ended the hand", PHASE.HAND_COMPLETE, d[RT.phase]);
    hr.end_reason = d[GAME.end_reason];
    hr.winners = order.filter((s) => (d[GAME.winners] >> s) & 1);
    hr.rake = d.readBigUInt64LE(GAME.rake).toString();
    const stacks = Array.from({ length: SEATS }, (_, s) => d.readBigUInt64LE(RT.stacks + 8 * s));
    const rakeOwed = d.readBigUInt64LE(RT.rake_owed);
    check(`hand ${h}`, "stacks + rake = all buy-ins (conservation)", total.toString(), (stacks.reduce((a, b) => a + b, 0n) + rakeOwed).toString());

    // ---- reveal + independent verification ----
    await send(tee, [ix("reveal_hand", [r(keeper.publicKey, true), w(runtime), r(dealer), w(handLog), ...order.map((s) => r(saltAccs[s]))])], [keeper], { skipPreflight: true });
    const logAcc = await waitFor(async () => { const a = await teeConn(null).getAccountInfo(handLog); return a && a.data[HL.revealed] === 1 && a.data.readBigUInt64LE(HL.hand_no) === d.readBigUInt64LE(RT.hand_no) ? a : null; }, 15_000, 200);
    if (check(`hand ${h}`, "HandLog revealed and public", true, !!logAcc.value)) {
      const rec = handRecordFromLog(logAcc.value.data, shown);
      const f = resolve(repoRoot, `docs/probes/${report.started_at.replace(/[:.]/g, "-")}-game-hand${h}.json`);
      writeFileSync(f, JSON.stringify(rec, null, 2) + "\n");
      const res = spawnSync("cargo", ["run", "-q", "-p", "fairness-verifier", "--bin", "cf-verify", "--", f], { cwd: repoRoot, encoding: "utf8" });
      hr.verifier = res.stdout.trim().split("\n");
      check(`hand ${h}`, "cf-verify: hand VALID (exit 0)", 0, res.status, f.split("/").pop());
      check(`hand ${h}`, "cf-verify replayed the game result", true, /Game result:\s+VALID/.test(res.stdout));
    }

    // ---- revoke Side Show views, commit, sync, next hand ----
    const thisHand = d.readBigUInt64LE(RT.side_show_hand_no) === d.readBigUInt64LE(RT.hand_no);
    const viewers = thisHand ? [...d.subarray(RT.side_show_viewers, RT.side_show_viewers + SEATS)] : Array(SEATS).fill(0);
    const pairs = [];
    for (let a = 0; a < SEATS; a++) for (let b = a + 1; b < SEATS; b++) if ((viewers[a] >> b) & 1) pairs.push([a, b]);
    hr.side_show_pairs = pairs;
    for (const [a, b] of pairs) await send(tee, [t.sideShowViewIx(a, b, false, keeper)], [keeper], { skipPreflight: true });
    check(`hand ${h}`, "no live reader grants before the next hand", 0, (await t.readRuntime())[RT.grants]);
    const seqBefore = (await base.getAccountInfo(runtime)).data.readBigUInt64LE(RT.commit_seq);
    await send(tee, [ix("commit_hand", [w(keeper.publicKey, true), w(runtime), w(handLog), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [keeper], { skipPreflight: true });
    const landed = await waitFor(async () => ((await base.getAccountInfo(runtime)).data.readBigUInt64LE(RT.commit_seq) > seqBefore ? true : null), 90_000, 500);
    check(`hand ${h}`, "commit lands on the base layer", true, !!landed.value, `${landed.ms} ms`);
    await send(base, [ix("sync_hand", [w(config), r(runtime), r(record), ...ledgers.map((l) => w(l))])], [t.payer]);
    const synced = [];
    for (let s = 0; s < SEATS; s++) synced.push((await base.getAccountInfo(ledgers[s])).data.readBigUInt64LE(SL.synced_stack));
    check(`hand ${h}`, "synced ledgers equal the settled stacks", stacks.map(String), synced.map(String));
    await send(tee, [t.nextHandIx(keeper)], [keeper], { skipPreflight: true });
    const nd = await t.readRuntime();
    check(`hand ${h}`, "next_hand: IDLE, hand_no + 1, button moved to first dealt seat",
      [PHASE.IDLE, (BigInt(hr.hand_no) + 1n).toString(), order[0]],
      [nd[RT.phase], nd.readBigUInt64LE(RT.hand_no).toString(), nd[RT.button]]);
    report.timings[`hand${h}_total_ms`] = ms(tHand);
    log(`hand ${h}: ${hr.actions.length} actions (${hr.refused} refused), end ${["last player", "show", "pot limit"][hr.end_reason]}, winners ${JSON.stringify(hr.winners)}, ${report.timings[`hand${h}_total_ms`]} ms`);
  }
} catch (e) {
  report.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
try { if (t) report.teardown_ok = !!(await t.teardown()).value; } catch (e) { report.teardown_error = String(e.message ?? e).slice(0, 200); }

report.auth_transient_failures = authFailures;
report.finished_at = new Date().toISOString();
const passed = report.checks.filter((c) => c.pass).length, failed = report.checks.length - passed;
const out = resolve(repoRoot, `docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf025-game-${region}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`CF-025 full game (${HANDS} hands) — ${region} — ${failed === 0 && !report.error ? "PASSED" : "FAILED"} (${passed} passed, ${failed} failed)${report.error ? ` error: ${report.error.split("\n")[0]}` : ""}`);
console.log(`report: ${out}`);
process.exit(failed === 0 && !report.error ? 0 : 1);
