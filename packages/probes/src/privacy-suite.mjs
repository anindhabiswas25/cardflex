#!/usr/bin/env node
// CF-007: privacy probe suite for gate G1 on Devnet PER.
// Six-player table (ADR 0002 layout, P1 TEST deck), then every read path and
// permission change we can reach from a client. Each check records the
// expected and actual result; any mismatch fails the run.
//
// Usage: pnpm privacy-suite -- --region <label>
// Needs the devnet POC build: pnpm build:program:devnet-poc

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID, TEE_VALIDATOR, BASE_RPC, repoRoot, loadDiscriminators, loadPayer, makeIx, send, rejected,
  tokenFor, authFailures, teeConn, teeUrl, rawRpc, waitFor, sleep, log, ms, w, r, u8, u64, vecPubkeys,
  testDeck, dealPositions,
} from "./common.mjs";

const SEATS = 6;
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }

const ix = makeIx(loadDiscriminators());
const payer = loadPayer();
const base = new Connection(BASE_RPC, "confirmed");
const authority = Keypair.generate();
const players = Array.from({ length: SEATS }, () => ({ wallet: Keypair.generate(), session: Keypair.generate() }));
const tableId = BigInt(Date.now());
const [config] = PublicKey.findProgramAddressSync([Buffer.from("table"), authority.publicKey.toBuffer(), u64(tableId)], PROGRAM_ID);
const [runtime] = PublicKey.findProgramAddressSync([Buffer.from("table-runtime"), config.toBuffer()], PROGRAM_ID);
const [dealer] = PublicKey.findProgramAddressSync([Buffer.from("dealer"), runtime.toBuffer()], PROGRAM_ID);
const hands = Array.from({ length: SEATS }, (_, s) => PublicKey.findProgramAddressSync([Buffer.from("seat-hand"), runtime.toBuffer(), u8(s)], PROGRAM_ID)[0]);
const secretKeys = new Set([dealer, ...hands].map(String));
const perKeys = (target, signer = authority) => [
  r(signer.publicKey, true), w(runtime), w(target), w(permissionPdaFromAccount(target)),
  r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
];
const setReaders = (seat, readers, signer = authority) =>
  ix("set_hand_readers", perKeys(hands[seat], signer), Buffer.concat([u8(seat), vecPubkeys(readers)]));

const report = { probe: "CF-007", version: 1, region, started_at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), checks: [] };
const check = (group, name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  report.checks.push({ group, name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${group} / ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return pass;
};
const canRead = async (conn, key) => { try { return !!(await conn.getAccountInfo(key)); } catch { return false; } };

try {
  // ---------------- setup ----------------
  log("setup: table, six players, delegate");
  await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: authority.publicKey, lamports: 30_000_000 })], [payer]);
  await send(base, [ix("create_table", [w(config), w(runtime), w(authority.publicKey, true), r(SystemProgram.programId)], Buffer.concat([u64(tableId), u8(SEATS)]))], [authority]);
  for (let s = 0; s < SEATS; s++) {
    await send(base, [ix("poc_join", [r(players[s].wallet.publicKey, true), w(runtime)], Buffer.concat([u8(s), players[s].session.publicKey.toBuffer()]))], [payer, players[s].wallet]);
  }
  await send(base, [ix("delegate_table", [
    r(authority.publicKey, true), r(config),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(runtime, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(runtime)), w(delegationMetadataPdaFromDelegatedAccount(runtime)),
    w(runtime), r(TEE_VALIDATOR), r(PROGRAM_ID), r(DELEGATION_PROGRAM_ID), r(SystemProgram.programId),
  ])], [authority]);

  log("setup: tokens");
  const stranger = Keypair.generate();
  const tok = { authority: await tokenFor(authority), stranger: await tokenFor(stranger), no_token: null };
  for (let s = 0; s < SEATS; s++) tok[`session${s}`] = await tokenFor(players[s].session);
  tok.wallet0 = await tokenFor(players[0].wallet);
  const conn = Object.fromEntries(Object.entries(tok).map(([k, t]) => [k, teeConn(t)]));
  const tee = conn.authority;
  const vis = await waitFor(async () => { const a = await tee.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 60_000);
  if (!vis.value) throw new Error("runtime never appeared in PER");

  log("setup: permissions, dealer, hands");
  await send(tee, [ix("open_runtime_permission", perKeys(runtime))], [authority], { skipPreflight: true });
  await send(tee, [ix("open_dealer", perKeys(dealer))], [authority], { skipPreflight: true });
  for (let s = 0; s < SEATS; s++) await send(tee, [ix("open_seat_hand", perKeys(hands[s]), u8(s))], [authority], { skipPreflight: true });

  // G1-5: strangers subscribed to every secret account during the deal.
  let strangerNotes = 0;
  const strangerSubs = [dealer, ...hands].map((k) => conn.stranger.onAccountChange(k, () => { strangerNotes++; }, { commitment: "processed" }));
  let noTokNotes = 0;
  const noTokSubs = [dealer, ...hands].map((k) => conn.no_token.onAccountChange(k, () => { noTokNotes++; }, { commitment: "processed" }));
  await sleep(1500);
  log("setup: deal (P1 test deck)");
  const deal = await send(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority], { skipPreflight: true });
  await sleep(3000);
  for (const id of strangerSubs) await conn.stranger.removeAccountChangeListener(id);
  for (const id of noTokSubs) await conn.no_token.removeAccountChangeListener(id);
  check("subscriptions", "stranger notifications on secret accounts during deal", 0, strangerNotes);
  check("subscriptions", "no-token notifications on secret accounts during deal", 0, noTokNotes);

  // ---------------- G1-1: own cards ----------------
  log("G1-1 own cards");
  const deck = testDeck(0);
  for (let s = 0; s < SEATS; s++) {
    const got = await waitFor(async () => { const a = await conn[`session${s}`].getAccountInfo(hands[s]); return a && (a.data[49] | a.data[50] | a.data[51]) ? a : null; }, 15_000, 150);
    const cards = got.value ? [...got.value.data.subarray(49, 52)] : null;
    check("own cards", `session${s} reads its 3 dealt cards`, dealPositions(s, SEATS).map((p) => deck[p]), cards);
  }

  // ---------------- G1-2: matrix + encodings ----------------
  log("G1-2 read matrix and encodings");
  const expectRead = (who, what) =>
    what === "runtime" ? who === "authority" || who.startsWith("session")
      : what.startsWith("hand") ? who === `session${what.slice(4)}` : false;
  const targets = { runtime, dealer, ...Object.fromEntries(hands.map((h, s) => [`hand${s}`, h])) };
  for (const who of Object.keys(conn)) {
    for (const [what, key] of Object.entries(targets)) {
      check("matrix", `${who} getAccountInfo ${what}`, expectRead(who, what), await canRead(conn[who], key));
    }
  }
  for (const who of ["stranger", "no_token", "session1", "wallet0"]) {
    const url = teeUrl(tok[who]);
    for (const enc of [{ encoding: "base64" }, { encoding: "base64", dataSlice: { offset: 49, length: 3 } }, { encoding: "jsonParsed" }, { encoding: "base58" }]) {
      const res = await rawRpc(url, "getAccountInfo", [hands[0].toBase58(), enc]);
      check("encodings", `${who} getAccountInfo hand0 ${JSON.stringify(enc)}`, null, res.result?.value ?? null);
    }
  }
  const multi = await conn.session0.getMultipleAccountsInfo([hands[0], hands[1], dealer, runtime]);
  check("multi", "session0 getMultipleAccounts [hand0, hand1, dealer, runtime]", [true, false, false, true], multi.map((a) => !!a));

  // ---------------- G1-3: program-wide enumeration ----------------
  log("G1-3 getProgramAccounts / getSignaturesForAddress");
  for (const who of ["stranger", "no_token", "session0", "authority"]) {
    const res = await rawRpc(teeUrl(tok[who]), "getProgramAccounts", [PROGRAM_ID.toBase58(), { encoding: "base64" }]);
    const listed = (res.result ?? []).map((x) => x.pubkey);
    const secretsSeen = listed.filter((k) => secretKeys.has(k)).map((k) => (k === dealer.toBase58() ? "dealer" : `hand${hands.findIndex((h) => h.toBase58() === k)}`));
    const allowed = who === "session0" ? ["hand0"] : [];
    check("enumeration", `${who} getProgramAccounts exposes only allowed secret accounts`, allowed.sort(), secretsSeen.filter((x) => !allowed.includes(x)).length ? secretsSeen.sort() : allowed.filter((x) => secretsSeen.includes(x)).sort(),
      res.error ? `rpc error: ${res.error.message}` : `listed ${listed.length} accounts, secret: ${JSON.stringify(secretsSeen)}`);
  }
  for (const who of ["stranger", "no_token"]) {
    const res = await rawRpc(teeUrl(tok[who]), "getSignaturesForAddress", [hands[0].toBase58()]);
    const sigs = (res.result ?? []).map((x) => x.signature);
    let leaked = false;
    for (const sig of sigs.slice(0, 5)) {
      const t = await rawRpc(teeUrl(tok[who]), "getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
      const m = t.result?.transaction?.message;
      if (m && ((m.accountKeys?.length ?? 0) > 0 || (m.instructions?.length ?? 0) > 0 || (t.result.meta?.logMessages?.length ?? 0) > 0)) leaked = true;
    }
    check("enumeration", `${who} transactions touching hand0 are redacted`, false, leaked, `${sigs.length} signatures listed${res.error ? `, rpc error: ${res.error.message}` : ""}`);
  }

  // ---------------- G1-4: Side Show grant and revoke ----------------
  log("G1-4 Side Show: grant hand0 to session1, then revoke");
  await send(tee, [setReaders(0, [players[0].session.publicKey, players[1].session.publicKey])], [authority], { skipPreflight: true });
  const granted = await waitFor(async () => canRead(conn.session1, hands[0]), 10_000);
  check("side show", "session1 can read hand0 after grant", true, !!granted.value, `took ${granted.ms} ms`);
  check("side show", "session2 still cannot read hand0", false, await canRead(conn.session2, hands[0]));
  check("side show", "session0 still reads hand0", true, await canRead(conn.session0, hands[0]));
  await send(tee, [setReaders(0, [players[0].session.publicKey])], [authority], { skipPreflight: true });
  const revoked = await waitFor(async () => !(await canRead(conn.session1, hands[0])), 10_000);
  check("side show", "session1 loses hand0 after revoke (same token)", true, !!revoked.value, `took ${revoked.ms} ms`);

  // ---------------- G1-6: session rotation, old token reuse ----------------
  log("G1-6 rotate seat 2 session key; old token must stop working");
  const newSession = Keypair.generate();
  await send(tee, [setReaders(2, [newSession.publicKey])], [authority], { skipPreflight: true });
  const oldDenied = await waitFor(async () => !(await canRead(conn.session2, hands[2])), 10_000);
  check("rotation", "old session2 token denied after removal", true, !!oldDenied.value, `took ${oldDenied.ms} ms`);
  const newConn = teeConn(await tokenFor(newSession));
  check("rotation", "new session key reads hand2", true, !!(await waitFor(async () => canRead(newConn, hands[2]), 10_000)).value);

  // ---------------- G1-7: unauthorized calls ----------------
  log("G1-7 unauthorized permission changes and writes");
  check("authorization", "stranger cannot set hand0 readers", true, await rejected(tee, [setReaders(0, [stranger.publicKey], stranger)], [stranger]));
  check("authorization", "session1 cannot set hand0 readers", true, await rejected(tee, [setReaders(0, [players[1].session.publicKey], players[1].session)], [players[1].session]));
  check("authorization", "session1 still cannot read hand0", false, await canRead(conn.session1, hands[0]));
  check("authorization", "stranger cannot close hand0", true, await rejected(tee, [ix("close_ephemeral", perKeys(hands[0], stranger), Buffer.from([1, 0]))], [stranger]));
  check("authorization", "stranger cannot deal", true, await rejected(tee, [ix("poc_deal", [r(stranger.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [stranger]));
  check("authorization", "authority cannot redeal a dealt hand", true, await rejected(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority]));
  check("authorization", "empty reader list rejected", true, await rejected(tee, [setReaders(1, [])], [authority]));
  check("authorization", "hand0 cards unchanged after attempts", dealPositions(0, SEATS).map((p) => deck[p]), [...((await conn.session0.getAccountInfo(hands[0]))?.data.subarray(49, 52) ?? [])]);

  // ---------------- G1-8: logs ----------------
  log("G1-8 logs of the deal transaction");
  const dealTx = await rawRpc(teeUrl(tok.authority), "getTransaction", [deal.sig, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
  const logs = dealTx.result?.meta?.logMessages ?? [];
  const standard = /^Program (\w+ invoke \[\d+\]|\w+ consumed \d+ of \d+ compute units|\w+ success|log: Instruction: \w+)$/;
  check("logs", "deal logs contain only standard lines", [], logs.filter((l) => !standard.test(l)), `${logs.length} lines`);

  // ---------------- cleanup ----------------
  log("cleanup: close ephemerals, undelegate, base-layer check");
  for (let s = 0; s < SEATS; s++) await send(tee, [ix("close_ephemeral", perKeys(hands[s]), Buffer.from([1, s]))], [authority], { skipPreflight: true });
  await send(tee, [ix("close_ephemeral", perKeys(dealer), Buffer.from([0]))], [authority], { skipPreflight: true });
  await send(tee, [ix("undelegate_table", [w(authority.publicKey, true), w(runtime), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
  const home = await waitFor(async () => { const a = await base.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 120_000, 500);
  check("base layer", "runtime back on base", true, !!home.value);
  for (const k of [dealer, ...hands]) check("base layer", `${k.toBase58().slice(0, 6)}… absent on Solana`, null, await base.getAccountInfo(k));
} catch (e) {
  report.error = String(e.stack ?? e).slice(0, 600);
}

report.auth_transient_failures = authFailures;
report.passed = report.checks.filter((c) => c.pass).length;
report.failed = report.checks.filter((c) => !c.pass).length;
report.ok = !report.error && report.failed === 0;
report.finished_at = new Date().toISOString();
const out = resolve(arg("out", `${repoRoot}/docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf007-${region}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

console.log(`\nCF-007 privacy suite — ${region} — ${report.ok ? "PASSED" : "FAILED"} (${report.passed} passed, ${report.failed} failed)`);
if (report.error) console.log(`error: ${report.error.split("\n")[0]}`);
const groups = [...new Set(report.checks.map((c) => c.group))];
for (const g of groups) {
  const cs = report.checks.filter((c) => c.group === g);
  console.log(`  ${g.padEnd(14)} ${cs.filter((c) => c.pass).length}/${cs.length}${cs.some((c) => !c.pass) ? "  <- " + cs.filter((c) => !c.pass).map((c) => c.name).join("; ") : ""}`);
}
for (const c of report.checks.filter((c) => c.note)) console.log(`  note: ${c.name}: ${c.note}`);
console.log(`\nFull results: ${out}`);
process.exit(report.ok ? 0 : 1);
