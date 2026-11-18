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
  testDeck, dealPositions, rosterHash, handCtx, saltCommitment, RT, GLOBAL, ensureGlobal, buyInIx, joinSeatIx,
} from "./common.mjs";
import { randomBytes } from "node:crypto";

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
const [handLog] = PublicKey.findProgramAddressSync([Buffer.from("hand-log"), runtime.toBuffer()], PROGRAM_ID);
const [vault] = PublicKey.findProgramAddressSync([Buffer.from("table-vault"), config.toBuffer()], PROGRAM_ID);
const [dealer] = PublicKey.findProgramAddressSync([Buffer.from("dealer"), runtime.toBuffer()], PROGRAM_ID);
const hands = Array.from({ length: SEATS }, (_, s) => PublicKey.findProgramAddressSync([Buffer.from("seat-hand"), runtime.toBuffer(), u8(s)], PROGRAM_ID)[0]);
const saltAccs = Array.from({ length: SEATS }, (_, s) => PublicKey.findProgramAddressSync([Buffer.from("salt"), runtime.toBuffer(), u8(s)], PROGRAM_ID)[0]);
const secretKeys = new Set([dealer, ...hands, ...saltAccs].map(String));
const perKeys = (target, signer = authority) => [
  r(signer.publicKey, true), w(runtime), w(target), w(permissionPdaFromAccount(target)),
  r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
];
// set_hand_readers is revoke-only since CF-022 (owner = an extra signer, to
// show that even the hand owner's consent can't create a grant).
const setReaders = (seat, readers, signer = authority, owner = null) =>
  ix("set_hand_readers", [...perKeys(hands[seat], signer), ...(owner ? [r(owner.publicKey, true)] : [])],
    Buffer.concat([u8(seat), vecPubkeys(readers)]));
const sideShowView = (a, b, grant, payer) => ix("side_show_view", [
  r(payer.publicKey, true), w(runtime), w(hands[a]), w(permissionPdaFromAccount(hands[a])),
  w(hands[b]), w(permissionPdaFromAccount(hands[b])), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
], Buffer.concat([u8(a), u8(b), u8(grant ? 1 : 0)]));

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
  await ensureGlobal(base, ix, payer);
  await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: authority.publicKey, lamports: 30_000_000 })], [payer]);
  await send(base, [ix("create_table", [w(config), w(runtime), w(handLog), w(vault), w(authority.publicKey, true), r(GLOBAL), r(SystemProgram.programId)], Buffer.concat([u64(tableId), u8(SEATS)]))], [authority]);
  // Seat with real buy-ins (CF-020): boot 25,000, buy-in 40 boots.
  const cfgData = Buffer.alloc(22);
  cfgData.writeBigUInt64LE(25_000n, 0); cfgData.writeBigUInt64LE(0n, 10); cfgData.writeUInt32LE(3600, 18);
  await send(base, [ix("configure_table", [r(authority.publicKey, true), w(config), w(runtime), r(GLOBAL)], cfgData)], [authority]);
  for (let s = 0; s < SEATS; s++) {
    const ledger = PublicKey.findProgramAddressSync([Buffer.from("seat-ledger"), config.toBuffer(), u8(s)], PROGRAM_ID)[0];
    await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: players[s].wallet.publicKey, lamports: 6_000_000 })], [payer]);
    await send(base, [buyInIx(ix, players[s].wallet.publicKey, config, vault, s, 1_000_000, players[s].session.publicKey)], [players[s].wallet]);
    await send(base, [joinSeatIx(ix, players[s].wallet.publicKey, runtime, config, s)], [players[s].wallet]);
  }
  await send(base, [ix("delegate_table", [
    r(authority.publicKey, true), w(config),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(runtime, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(runtime)), w(delegationMetadataPdaFromDelegatedAccount(runtime)),
    w(runtime),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(handLog, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(handLog)), w(delegationMetadataPdaFromDelegatedAccount(handLog)),
    w(handLog), r(TEE_VALIDATOR), r(PROGRAM_ID), r(DELEGATION_PROGRAM_ID), r(SystemProgram.programId),
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
  await send(tee, [ix("open_hand_log_permission", perKeys(handLog))], [authority], { skipPreflight: true });
  await send(tee, [ix("open_dealer", perKeys(dealer))], [authority], { skipPreflight: true });
  for (let s = 0; s < SEATS; s++) await send(tee, [ix("open_seat_hand", perKeys(hands[s]), u8(s))], [authority], { skipPreflight: true });

  // ---------------- CF-009: salt round ----------------
  log("CF-009 salt round");
  for (let s = 0; s < SEATS; s++) await send(tee, [ix("open_salt", perKeys(saltAccs[s]), u8(s))], [authority], { skipPreflight: true });
  const salts = Array.from({ length: SEATS }, () => randomBytes(32));
  const submit = (seat, signer, acc = saltAccs[seat], salt = salts[seat]) =>
    ix("submit_salt", [r(signer.publicKey, true), w(runtime), w(acc)], Buffer.concat([u8(seat), salt]));
  check("salts", "submit before start_hand rejected", true, await rejected(tee, [submit(0, players[0].session)], [players[0].session]));
  await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
  {
    const rt = (await tee.getAccountInfo(runtime)).data;
    const roster = rosterHash([0, 1, 2, 3, 4, 5], players.map((p) => p.wallet.publicKey));
    const ctx = handCtx(PROGRAM_ID, config, 0n, roster, 1);
    check("salts", "on-chain roster_hash matches spec (JS)", roster.toString("hex"), rt.subarray(RT.roster_hash, RT.roster_hash + 32).toString("hex"));
    check("salts", "on-chain hand_ctx matches spec (JS)", ctx.toString("hex"), rt.subarray(RT.hand_ctx, RT.hand_ctx + 32).toString("hex"));
    check("salts", "phase SALTS_PENDING", 1, rt[RT.phase]);
    report.hand_ctx = ctx.toString("hex");
  }
  check("salts", "session1 cannot submit for seat 0", true, await rejected(tee, [submit(0, players[1].session)], [players[1].session]));
  check("salts", "wallet0 cannot submit for seat 0", true, await rejected(tee, [submit(0, players[0].wallet)], [players[0].wallet]));
  check("salts", "seat 0 cannot write into seat 1's salt account", true, await rejected(tee, [submit(0, players[0].session, saltAccs[1])], [players[0].session]));
  const saltSigs = [];
  for (let s = 0; s < SEATS; s++) saltSigs.push((await send(tee, [submit(s, players[s].session)], [players[s].session], { skipPreflight: true })).sig);
  check("salts", "second submit for seat 0 rejected", true, await rejected(tee, [submit(0, players[0].session, saltAccs[0], randomBytes(32))], [players[0].session]));
  {
    const rt = (await tee.getAccountInfo(runtime)).data;
    const ctx = Buffer.from(report.hand_ctx, "hex");
    const got = Array.from({ length: SEATS }, (_, s) => rt.subarray(RT.salt_commitments + 32 * s, RT.salt_commitments + 32 * (s + 1)).toString("hex"));
    check("salts", "on-chain commitments match spec (JS)", salts.map((x, s) => saltCommitment(ctx, s, x).toString("hex")), got);
    check("salts", "phase SALTS_DONE after six salts", 2, rt[RT.phase]);
    check("salts", "runtime holds no raw salt bytes", false, salts.some((x) => rt.includes(x)));
  }
  // The salt is in the instruction data. Other seats are members of the
  // runtime permission (which the tx also writes): they must still not see it.
  await sleep(1000);
  // Ask in both encodings; redacted transactions may come back in a
  // different shape, so decode whatever is returned.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58decode = (str) => {
    let n = 0n;
    for (const ch of str) { const v = B58.indexOf(ch); if (v < 0) return Buffer.alloc(0); n = n * 58n + BigInt(v); }
    let hex = n.toString(16); if (hex.length % 2) hex = "0" + hex;
    const lead = str.match(/^1*/)[0].length;
    return Buffer.concat([Buffer.alloc(lead), n === 0n ? Buffer.alloc(0) : Buffer.from(hex, "hex")]);
  };
  const txSeesSalt = async (who, sig, salt) => {
    const seen = [];
    for (const encoding of ["base64", "json"]) {
      const t = await rawRpc(teeUrl(tok[who]), "getTransaction", [sig, { encoding, maxSupportedTransactionVersion: 0 }]);
      const tx = t.result?.transaction;
      let raw = Buffer.alloc(0);
      if (Array.isArray(tx)) raw = Buffer.from(tx[0] ?? "", "base64");
      else if (tx?.message) raw = Buffer.concat((tx.message.instructions ?? []).map((i) => b58decode(i.data ?? "")));
      seen.push({ encoding, returned: !!t.result, shape: Array.isArray(tx) ? "encoded" : tx ? "json" : "none", bytes: raw.length, has_salt: raw.includes(salt) });
    }
    return seen;
  };
  report.salt_tx_visibility = {};
  for (const who of ["session1", "authority", "stranger", "no_token"]) {
    const seen = await txSeesSalt(who, saltSigs[0], salts[0]);
    report.salt_tx_visibility[who] = seen;
    check("salts", `${who} cannot see seat 0's salt in its transaction`, false, seen.some((x) => x.has_salt),
      seen.map((x) => `${x.encoding}:${x.shape}/${x.bytes}B`).join(" "));
  }
  report.salt_tx_visibility.session0_owner = await txSeesSalt("session0", saltSigs[0], salts[0]);

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
  // Salts: nobody reads them back, not even the player who submitted one.
  const expectRead = (who, what) =>
    what === "runtime" ? who === "authority" || who.startsWith("session")
      : what.startsWith("hand") ? who === `session${what.slice(4)}` : false;
  const targets = { runtime, dealer, ...Object.fromEntries(hands.map((h, s) => [`hand${s}`, h])), ...Object.fromEntries(saltAccs.map((a, s) => [`salt${s}`, a])) };
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
    const label = (k) => k === dealer.toBase58() ? "dealer"
      : hands.some((h) => h.toBase58() === k) ? `hand${hands.findIndex((h) => h.toBase58() === k)}`
      : `salt${saltAccs.findIndex((a) => a.toBase58() === k)}`;
    const secretsSeen = listed.filter((k) => secretKeys.has(k)).map(label);
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

  // ---------------- G1-4: no grant outside the game ----------------
  // CF-022: a hand is readable by another player only after an accepted Side
  // Show in a real hand (tested in pnpm handflow). Every other path fails.
  log("G1-4 grants only through the game");
  const two = [players[0].session.publicKey, players[1].session.publicKey];
  check("side show", "authority grant via set_hand_readers rejected", true, await rejected(tee, [setReaders(0, two)], [authority]));
  check("side show", "grant with the owner's consent rejected (revoke-only)", true, await rejected(tee, [setReaders(0, two, authority, players[0].session)], [authority, players[0].session]));
  check("side show", "side_show_view grant without an accepted Side Show rejected", true, await rejected(tee, [sideShowView(0, 1, true, stranger)], [stranger]));
  check("side show", "side_show_view grant by the authority rejected", true, await rejected(tee, [sideShowView(0, 1, true, authority)], [authority]));
  check("side show", "session1 cannot read hand0", false, await canRead(conn.session1, hands[0]));
  await send(tee, [setReaders(0, [players[0].session.publicKey])], [authority], { skipPreflight: true });
  check("side show", "session0 still reads hand0 after a revoke-only reset", true, await canRead(conn.session0, hands[0]));

  // ---------------- G1-6: session rotation, old token reuse ----------------
  log("G1-6 seat 2's wallet rotates its session key; old token must stop working");
  const newSession = Keypair.generate();
  const rotate = (seat, newKey, signer) => ix("rotate_session", [
    r(signer.publicKey, true), w(runtime), w(hands[seat]), w(permissionPdaFromAccount(hands[seat])),
    w(permissionPdaFromAccount(runtime)), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
  ], Buffer.concat([u8(seat), newKey.toBuffer()]));
  check("rotation", "another player's wallet cannot rotate seat 2", true, await rejected(tee, [rotate(2, Keypair.generate().publicKey, players[1].wallet)], [players[1].wallet]));
  check("rotation", "authority cannot rotate seat 2", true, await rejected(tee, [rotate(2, authority.publicKey, authority)], [authority]));
  check("rotation", "seat 2 cannot rotate to the authority key", true, await rejected(tee, [rotate(2, authority.publicKey, players[2].wallet)], [players[2].wallet]));
  check("rotation", "seat 2 cannot rotate to another wallet", true, await rejected(tee, [rotate(2, players[4].wallet.publicKey, players[2].wallet)], [players[2].wallet]));
  check("rotation", "seat 2 cannot rotate to another seat's session", true, await rejected(tee, [rotate(2, players[4].session.publicKey, players[2].wallet)], [players[2].wallet]));
  await send(tee, [rotate(2, newSession.publicKey, players[2].wallet)], [players[2].wallet], { skipPreflight: true });
  const oldDenied = await waitFor(async () => !(await canRead(conn.session2, hands[2])), 10_000);
  check("rotation", "old session2 token denied after removal", true, !!oldDenied.value, `took ${oldDenied.ms} ms`);
  const newConn = teeConn(await tokenFor(newSession));
  check("rotation", "new session key reads hand2", true, !!(await waitFor(async () => canRead(newConn, hands[2]), 10_000)).value);
  check("rotation", "new session key reads runtime", true, !!(await waitFor(async () => canRead(newConn, runtime), 10_000)).value);
  check("rotation", "old session2 token denied runtime", true, !!(await waitFor(async () => !(await canRead(conn.session2, runtime)), 10_000)).value);

  // ---------------- G1-7: unauthorized calls ----------------
  log("G1-7 unauthorized permission changes and writes");
  check("authorization", "stranger cannot set hand0 readers", true, await rejected(tee, [setReaders(0, [stranger.publicKey], stranger)], [stranger]));
  check("authorization", "session1 cannot set hand0 readers", true, await rejected(tee, [setReaders(0, [players[1].session.publicKey], players[1].session)], [players[1].session]));
  check("authorization", "session1 still cannot read hand0", false, await canRead(conn.session1, hands[0]));
  check("authorization", "stranger cannot close hand0", true, await rejected(tee, [ix("close_ephemeral", perKeys(hands[0], stranger), Buffer.from([1, 0]))], [stranger]));
  check("authorization", "stranger cannot deal", true, await rejected(tee, [ix("poc_deal", [r(stranger.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [stranger]));
  check("authorization", "authority cannot redeal a dealt hand", true, await rejected(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority]));
  check("authorization", "empty reader list rejected", true, await rejected(tee, [setReaders(1, [])], [authority]));
  // Security review: the operator must never be able to read a hand.
  const s0 = players[0].session.publicKey, s1 = players[1].session.publicKey, s3 = players[3].session.publicKey;
  check("authorization", "authority cannot add itself to hand0 (even with owner consent)", true, await rejected(tee, [setReaders(0, [s0, authority.publicKey], authority, players[0].session)], [authority, players[0].session]));
  check("authorization", "reader list without the owner rejected", true, await rejected(tee, [setReaders(0, [s1])], [authority]));
  check("authorization", "outside key as opponent rejected", true, await rejected(tee, [setReaders(0, [s0, stranger.publicKey], authority, players[0].session)], [authority, players[0].session]));
  check("authorization", "wallet as opponent rejected", true, await rejected(tee, [setReaders(0, [s0, players[1].wallet.publicKey], authority, players[0].session)], [authority, players[0].session]));
  check("authorization", "three readers rejected", true, await rejected(tee, [setReaders(0, [s0, s1, s3], authority, players[0].session)], [authority, players[0].session]));
  check("authorization", "authority still cannot read hand0", false, await canRead(conn.authority, hands[0]));
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
  for (let s = 0; s < SEATS; s++) await send(tee, [ix("close_salt", perKeys(saltAccs[s]), u8(s))], [authority], { skipPreflight: true });
  await send(tee, [ix("undelegate_table", [w(authority.publicKey, true), w(runtime), w(handLog), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
  const home = await waitFor(async () => { const a = await base.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 120_000, 500);
  check("base layer", "runtime back on base", true, !!home.value);
  for (const k of [dealer, ...hands, ...saltAccs]) check("base layer", `${k.toBase58().slice(0, 6)}… absent on Solana`, null, await base.getAccountInfo(k));
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
