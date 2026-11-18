#!/usr/bin/env node
// P2 hand flow on Devnet PER: salts -> VRF -> (CF-011) shuffle/deal -> (CF-012) verify.
// CF-010 part: request MagicBlock VRF with the spec caller_seed, receive the
// protected callback, and check that every misuse is rejected.
//
// Usage: pnpm handflow -- --region <label> [--queue ephemeral|base]
// Needs the devnet POC build deployed (pnpm build:program:devnet-poc).

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import {
  PROGRAM_ID, repoRoot, send, rejected, waitFor, sleep, log, ms, w, r, u8, u64, authFailures,
  RT, PHASE, HAND, HL, GAME, ACTION, saltCommitment, vrfCallerSeed, verifyCard, teeConn, tokenFor, handRecordFromLog,
} from "./common.mjs";
import { spawnSync } from "node:child_process";
import { setupTable } from "./table.mjs";

const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const QUEUES = {
  ephemeral: new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"),
  base: new PublicKey("Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh"),
};

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }
const queueName = arg("queue", "ephemeral");

const report = { probe: "P2-handflow", version: 1, region, queue: queueName, started_at: new Date().toISOString(), checks: [], timings: {} };
const check = (group, name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  report.checks.push({ group, name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${group} / ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
};

let t;
try {
  t = await setupTable();
  const { ix, tee, authority, players, config, runtime, dealer, saltAccs } = t;
  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
  const requestKeys = (payer, queue = QUEUES[queueName]) => [
    w(payer.publicKey, true), w(runtime), r(dealer), w(queue),
    r(programIdentity), r(VRF_PROGRAM_ID), r(SYSVAR_SLOT_HASHES_PUBKEY), r(SystemProgram.programId),
  ];
  const readRuntime = async () => (await tee.getAccountInfo(runtime)).data;
  const dealIx = (payer) => ix("deal_hand", [r(payer.publicKey, true), w(runtime), w(dealer), ...t.hands.map((h) => w(h))]);

  // ---- salts (CF-009) ----
  log("salts");
  await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
  check("vrf", "request before SALTS_DONE rejected", true, await rejected(tee, [ix("request_shuffle", requestKeys(authority))], [authority]));
  const salts = players.map(() => randomBytes(32));
  for (let s = 0; s < players.length; s++) {
    await send(tee, [ix("submit_salt", [r(players[s].session.publicKey, true), w(runtime), w(saltAccs[s])], Buffer.concat([u8(s), salts[s]]))], [players[s].session], { skipPreflight: true });
  }
  let rt = await readRuntime();
  check("vrf", "phase SALTS_DONE", PHASE.SALTS_DONE, rt[RT.phase]);
  const handCtx = rt.subarray(RT.hand_ctx, RT.hand_ctx + 32);

  // ---- CF-010: VRF request ----
  log(`CF-010 request VRF on the ${queueName} queue`);
  const stranger = Keypair.generate();
  check("deal", "deal before SEEDED rejected", true, await rejected(tee, [dealIx(authority)], [authority]));
  check("integrity", "closing a salt account mid-hand rejected", true, await rejected(tee, [ix("close_salt", t.perKeys(saltAccs[0]), u8(0))], [authority]));
  check("vrf", "unknown queue rejected", true, await rejected(tee, [ix("request_shuffle", requestKeys(authority, Keypair.generate().publicKey))], [authority]));
  // Fake callback: the scoped VRF identity can't be forged, so any signer fails.
  const fakeCallback = (signer) => ix("vrf_deal", [r(signer.publicKey, true), w(runtime), w(dealer), ...saltAccs.map((a) => r(a))], Buffer.concat([randomBytes(32), u64(0n)]));
  check("vrf", "fake callback before request rejected", true, await rejected(tee, [fakeCallback(stranger)], [stranger]));

  // Anyone may pay for the request; use a stranger to show it is permissionless.
  const tReq = performance.now();
  const req = await send(tee, [ix("request_shuffle", requestKeys(stranger))], [stranger], { skipPreflight: true });
  report.timings.request_confirm_ms = req.ms;
  rt = await readRuntime();
  const commitments = players.map((_, s) => saltCommitment(handCtx, s, salts[s]));
  check("vrf", "on-chain vrf_caller_seed matches spec (JS)", vrfCallerSeed(handCtx, commitments).toString("hex"),
    rt.subarray(RT.vrf_caller_seed, RT.vrf_caller_seed + 32).toString("hex"));
  check("vrf", "second request while pending rejected", true, await rejected(tee, [ix("request_shuffle", requestKeys(authority))], [authority]));
  check("vrf", "fake callback while pending rejected", true, await rejected(tee, [fakeCallback(stranger)], [stranger]));
  check("vrf", "authority cannot fake the callback", true, await rejected(tee, [fakeCallback(authority)], [authority]));

  const seeded = await waitFor(async () => ((await readRuntime())[RT.phase] === PHASE.SEEDED ? true : null), 60_000, 100);
  report.timings.request_to_seeded_ms = ms(tReq);
  check("vrf", "VRF callback arrives and phase becomes SEEDED", true, !!seeded.value, `${report.timings.request_to_seeded_ms} ms from request`);
  if (seeded.value) {
    check("vrf", "fake callback after fulfilment rejected", true, await rejected(tee, [fakeCallback(stranger)], [stranger]));
    check("vrf", "new request after fulfilment rejected", true, await rejected(tee, [ix("request_shuffle", requestKeys(authority))], [authority]));
    // The seed lives in the private DealerState; nobody can read it here.
    check("privacy", "dealer state unreadable by authority", null, await tee.getAccountInfo(dealer));
    check("integrity", "cancel before the VRF timeout rejected", true, await rejected(tee, [ix("cancel_hand", [r(authority.publicKey, true), w(runtime)])], [authority]));

    // ---- CF-011: shuffle and deal from the seed ----
    log("CF-011 deal_hand");
    const sessionConns = [];
    for (const p of players) sessionConns.push(teeConn(await tokenFor(p.session)));
    const tDeal = performance.now();
    await send(tee, [dealIx(stranger)], [stranger], { skipPreflight: true }); // permissionless
    report.timings.deal_confirm_ms = ms(tDeal);
    rt = await readRuntime();
    check("deal", "phase DEALT", PHASE.DEALT, rt[RT.phase]);
    const root = rt.subarray(RT.merkle_root, RT.merkle_root + 32);
    check("deal", "merkle root published", true, !root.equals(Buffer.alloc(32)));
    check("deal", "second deal rejected", true, await rejected(tee, [dealIx(authority)], [authority]));
    const seen = new Set();
    let verified = 0;
    const n = players.length;
    const tSee = performance.now();
    for (let s = 0; s < n; s++) {
      const got = await waitFor(async () => {
        const a = await sessionConns[s].getAccountInfo(t.hands[s]);
        return a && a.data.length === HAND.len && a.data[HAND.positions + 1] !== 0 ? a : null;
      }, 15_000, 150);
      if (!got.value) { check("deal", `session${s} reads its hand`, true, false); continue; }
      const d = got.value.data;
      for (let j = 0; j < 3; j++) {
        const card = d[HAND.cards + j], pos = d[HAND.positions + j];
        const salt = d.subarray(HAND.leaf_salts + 32 * j, HAND.leaf_salts + 32 * (j + 1));
        const sibs = Array.from({ length: 6 }, (_, l) => d.subarray(HAND.proofs + (6 * j + l) * 32, HAND.proofs + (6 * j + l + 1) * 32));
        check("deal", `seat ${s} card ${j} at expected position`, s + j * n, pos);
        if (verifyCard(root, handCtx, pos, card, salt, sibs)) verified++;
        seen.add(card);
      }
    }
    report.timings.all_players_read_hands_ms = ms(tSee);
    check("deal", "all 18 cards verify against the public root (JS)", n * 3, verified);
    check("deal", "18 distinct cards", n * 3, seen.size);
    check("privacy", "session1 cannot read seat 0's hand", null, await sessionConns[1].getAccountInfo(t.hands[0]));

    // ---- CF-022: a real Side Show (seat 2 asks seat 1, seat 1 accepts) ----
    log("CF-022 Side Show in a real hand");
    const canRead = async (c, k) => { try { return !!(await c.getAccountInfo(k)); } catch { return false; } };
    await t.act(0, ACTION.CHAAL, "min");
    await t.act(1, ACTION.SEE);
    await t.act(1, ACTION.CHAAL, "min");
    await t.act(2, ACTION.SEE);
    check("side show", "view grant before any Side Show rejected", true, await rejected(tee, [t.sideShowViewIx(1, 2, true, stranger)], [stranger]));
    await t.act(2, ACTION.SIDE_SHOW);
    check("side show", "view grant while the Side Show is pending rejected", true, await rejected(tee, [t.sideShowViewIx(1, 2, true, stranger)], [stranger]));
    const afterSs = await t.act(1, ACTION.SIDE_SHOW_RESPOND, 1n);
    const packedSeat = [1, 2].find((s) => afterSs[GAME.seats + GAME.seat_len * s + 1] === 0);
    check("side show", "accepted Side Show packs exactly one of the pair", true, packedSeat !== undefined);
    check("side show", "view grant for another pair rejected", true, await rejected(tee, [t.sideShowViewIx(1, 3, true, stranger)], [stranger]));
    check("side show", "revoke while the hand is played rejected", true, await rejected(tee, [t.sideShowViewIx(1, 2, false, stranger)], [stranger]));
    await send(tee, [t.sideShowViewIx(1, 2, true, stranger)], [stranger], { skipPreflight: true }); // permissionless
    const g1 = await waitFor(async () => (await canRead(sessionConns[1], t.hands[2])) || null, 10_000);
    const g2 = await waitFor(async () => (await canRead(sessionConns[2], t.hands[1])) || null, 10_000);
    check("side show", "session1 reads hand2 after the accepted Side Show", true, !!g1.value, `took ${g1.ms} ms`);
    check("side show", "session2 reads hand1 after the accepted Side Show", true, !!g2.value, `took ${g2.ms} ms`);
    check("side show", "session3 still cannot read hand1 or hand2", [false, false], [await canRead(sessionConns[3], t.hands[1]), await canRead(sessionConns[3], t.hands[2])]);
    check("side show", "session1 still cannot read hand0", false, await canRead(sessionConns[1], t.hands[0]));

    // ---- CF-012: reveal and independent verification ----
    log("CF-012 reveal_hand + cf-verify");
    const shown = [];
    for (let s = 0; s < n; s++) {
      const a = await sessionConns[s].getAccountInfo(t.hands[s]);
      shown.push({ seat: s, cards: [...a.data.subarray(HAND.cards, HAND.cards + 3)] });
    }
    const revealIx = (payer) => ix("reveal_hand", [r(payer.publicKey, true), w(runtime), r(dealer), w(t.handLog), ...saltAccs.map((a) => r(a))]);
    check("reveal", "reveal during play (DEALT) rejected", true, await rejected(tee, [revealIx(stranger)], [stranger]));
    check("integrity", "closing a seat hand during play rejected", true, await rejected(tee, [ix("close_ephemeral", t.perKeys(t.hands[0]), Buffer.from([1, 0]))], [authority]));
    // CF-020/021: only the game ends a hand. A stranger can't act; the
    // players pack until one is left.
    {
      const d = await t.readRuntime();
      const strangerAct = ix("act", [r(stranger.publicKey, true), w(runtime), w(t.handLog), ...t.hands.map((h) => r(h))],
        Buffer.concat([u8(2), u64(0n), u64(d.readBigUInt64LE(RT.action_seq))]));
      check("game", "stranger cannot act", true, await rejected(tee, [strangerAct], [stranger]));
    }
    check("game", "hand ends only through the game (packs)", PHASE.HAND_COMPLETE, await t.packOut());
    await send(tee, [t.sideShowViewIx(1, 2, false, stranger)], [stranger], { skipPreflight: true });
    const rv = await waitFor(async () => !(await canRead(sessionConns[1], t.hands[2])) || null, 10_000);
    check("side show", "view revoked after the hand (session1 loses hand2)", true, !!rv.value, `took ${rv.ms} ms`);
    check("side show", "owners keep their own hands after revoke", [true, true], [await canRead(sessionConns[1], t.hands[1]), await canRead(sessionConns[2], t.hands[2])]);
    check("integrity", "closing a salt account before the reveal rejected", true, await rejected(tee, [ix("close_salt", t.perKeys(saltAccs[0]), u8(0))], [authority]));
    await send(tee, [revealIx(stranger)], [stranger], { skipPreflight: true }); // permissionless once complete
    check("reveal", "second reveal rejected", true, await rejected(tee, [revealIx(authority)], [authority]));
    const noToken = teeConn(null);
    const logAcc = await waitFor(async () => { const a = await noToken.getAccountInfo(t.handLog); return a && a.data[HL.revealed] === 1 ? a : null; }, 15_000, 200);
    check("reveal", "HandLog readable with no token (public)", true, !!logAcc.value);
    if (logAcc.value) {
      const record = handRecordFromLog(logAcc.value.data, shown);
      check("reveal", "revealed salts equal the submitted salts", salts.map((x) => x.toString("hex")), record.salts);
      const verifyFile = (rec, tag) => {
        const f = resolve(repoRoot, `docs/probes/${report.started_at.replace(/[:.]/g, "-")}-hand-record-${tag}.json`);
        writeFileSync(f, JSON.stringify(rec, null, 2) + "\n");
        const res = spawnSync("cargo", ["run", "-q", "-p", "fairness-verifier", "--bin", "cf-verify", "--", f], { cwd: repoRoot, encoding: "utf8" });
        return { status: res.status, out: res.stdout.trim(), file: f };
      };
      const ok = verifyFile(record, "per");
      report.verifier_report = ok.out.split("\n");
      check("verify", "cf-verify: revealed hand is VALID (exit 0)", 0, ok.status, ok.file.split("/").pop());
      const bad = JSON.parse(JSON.stringify(record));
      bad.salts[2] = bad.salts[2].replace(/^./, (c) => (c === "0" ? "1" : "0"));
      const tampered = verifyFile(bad, "tampered");
      check("verify", "cf-verify: tampered salt is INVALID (exit 1)", 1, tampered.status);
      check("verify", "tampered report flags the salt commitments", true, /Salt commitments:\s+INVALID/.test(tampered.out));
      report.record_from_per = record;
    }
  }
} catch (e) {
  report.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
try {
  if (t) {
    report.timings.teardown_ok = !!(await t.teardown()).value;
    if (report.record_from_per) {
      // Permanence: the committed HandLog on the Solana base layer.
      const baseLog = await waitFor(async () => { const a = await t.base.getAccountInfo(t.handLog); return a && a.owner.equals(PROGRAM_ID) && a.data[HL.revealed] === 1 ? a : null; }, 60_000, 500);
      check("verify", "HandLog committed to Solana base layer", true, !!baseLog.value);
      if (baseLog.value) {
        const rec = handRecordFromLog(baseLog.value.data, report.record_from_per.hands);
        check("verify", "base-layer HandLog equals the PER reveal", JSON.stringify(report.record_from_per), JSON.stringify(rec));
        const f = resolve(repoRoot, `docs/probes/${report.started_at.replace(/[:.]/g, "-")}-hand-record-base.json`);
        writeFileSync(f, JSON.stringify(rec, null, 2) + "\n");
        const res = spawnSync("cargo", ["run", "-q", "-p", "fairness-verifier", "--bin", "cf-verify", "--", f], { cwd: repoRoot, encoding: "utf8" });
        check("verify", "cf-verify on the base-layer record is VALID", 0, res.status);
      }
    }
  }
} catch (e) { report.teardown_error = String(e.message ?? e).slice(0, 200); }

report.auth_transient_failures = authFailures;
delete report.record_from_per;
report.passed = report.checks.filter((c) => c.pass).length;
report.failed = report.checks.filter((c) => !c.pass).length;
report.ok = !report.error && report.failed === 0;
report.finished_at = new Date().toISOString();
const out = resolve(arg("out", `${repoRoot}/docs/probes/${report.started_at.replace(/[:.]/g, "-")}-p2-handflow-${queueName}-${region}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
console.log(`\nP2 hand flow (${queueName} queue) — ${region} — ${report.ok ? "PASSED" : "FAILED"} (${report.passed} passed, ${report.failed} failed)`);
if (report.error) console.log(`error: ${report.error.split("\n")[0]}`);
for (const c of report.checks) console.log(`  ${c.pass ? "ok  " : "FAIL"} ${c.group} / ${c.name}${c.note ? `  (${c.note})` : ""}`);
console.log(`timings: ${JSON.stringify(report.timings)}\nFull results: ${out}`);
process.exit(report.ok ? 0 : 1);
