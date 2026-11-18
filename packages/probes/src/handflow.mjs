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
  PROGRAM_ID, repoRoot, send, rejected, waitFor, sleep, log, ms, w, r, u8, authFailures,
  RT, PHASE, saltCommitment, vrfCallerSeed,
} from "./common.mjs";
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
  check("vrf", "unknown queue rejected", true, await rejected(tee, [ix("request_shuffle", requestKeys(authority, Keypair.generate().publicKey))], [authority]));
  // Fake callback: the scoped VRF identity can't be forged, so any signer fails.
  const fakeCallback = (signer) => ix("vrf_deal", [r(signer.publicKey, true), w(runtime), w(dealer), ...saltAccs.map((a) => r(a))], randomBytes(32));
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
  }
} catch (e) {
  report.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
try { if (t) report.timings.teardown_ok = !!(await t.teardown()).value; } catch (e) { report.teardown_error = String(e.message ?? e).slice(0, 200); }

report.auth_transient_failures = authFailures;
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
