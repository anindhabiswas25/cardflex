#!/usr/bin/env node
// CF-006: six-player P1 table on Devnet PER with the ADR 0002 account layout.
// Builds a table, deals the P1 TEST DECK (not random), then checks who can read
// what: every identity x every account. Cleans up and checks nothing secret
// reached the Solana base layer.
//
// Usage: pnpm tablepoc -- --region <label>
// Needs `anchor build` (reads discriminators from target/idl/card_flex.json).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount, getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const PROGRAM_ID = new PublicKey("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const BASE_RPC = process.env.CARDFLEX_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const TEE_RPC = process.env.CARDFLEX_TEE_RPC ?? "https://devnet-tee.magicblock.app";
const KEYPAIR = process.env.CARDFLEX_DEVNET_KEYPAIR ?? `${homedir()}/.config/cardflex/devnet-deployer.json`;
const SEATS = 6;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const idlPath = `${repoRoot}/target/idl/card_flex.json`;
if (!existsSync(idlPath)) { console.error("Run `anchor build` first (needs target/idl/card_flex.json)."); process.exit(2); }
const IDL = JSON.parse(readFileSync(idlPath, "utf8"));
const DISC = Object.fromEntries(IDL.instructions.map((i) => [i.name, Buffer.from(i.discriminator)]));

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }

const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (xs) => (xs.length ? { n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) } : { n: 0 });
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const log = (...a) => console.error(...a);
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ix = (name, keys, data = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([DISC[name], data]) });
const u8 = (v) => Buffer.from([v]);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };

async function send(conn, instructions, signers, { skipPreflight = false, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...instructions);
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      const t0 = performance.now();
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
      const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
      return { sig, ms: ms(t0) };
    } catch (e) {
      // Retry only transport errors; a program error is final.
      if (attempt >= retries || /failed: \{/.test(String(e.message))) throw e;
      log(`  retry after: ${String(e.message ?? e).slice(0, 80)}`);
      await sleep(1000);
    }
  }
}
const authFailures = [];
async function tokenFor(kp) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
      return token;
    } catch (e) {
      const cause = String(e.cause?.code ?? e.cause?.message ?? e.message ?? e).slice(0, 100);
      authFailures.push(cause);
      if (attempt >= 4) throw new Error(`auth failed after retries: ${cause}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}
const teeConn = (token) => token
  ? new Connection(`${TEE_RPC}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${TEE_RPC.replace(/^http/, "ws")}?token=${token}` })
  : new Connection(TEE_RPC, "confirmed");
async function waitFor(fn, timeoutMs, everyMs = 250) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return { value: v, ms: ms(t0) };
    await sleep(everyMs);
  }
  return { value: null, ms: ms(t0) };
}

// Mirror of table.rs poc_test_deck + deal_positions (P1 test deck, NOT random).
function testDeck(handNo) {
  const shift = Number((BigInt(handNo) * 7n + 3n) % 52n);
  return Array.from({ length: 52 }, (_, i) => (i + shift) % 52);
}
const dealPositions = (k, n) => [k, k + n, k + 2 * n];

// ---------- accounts ----------
const report = { probe: "CF-006", version: 1, region, started_at: new Date().toISOString(), program: PROGRAM_ID.toBase58() };
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const authority = Keypair.generate();
const players = Array.from({ length: SEATS }, () => ({ wallet: Keypair.generate(), session: Keypair.generate() }));
const tableId = BigInt(Date.now());
const [config] = PublicKey.findProgramAddressSync([Buffer.from("table"), authority.publicKey.toBuffer(), u64(tableId)], PROGRAM_ID);
const [runtime] = PublicKey.findProgramAddressSync([Buffer.from("table-runtime"), config.toBuffer()], PROGRAM_ID);
const [dealer] = PublicKey.findProgramAddressSync([Buffer.from("dealer"), runtime.toBuffer()], PROGRAM_ID);
const hands = Array.from({ length: SEATS }, (_, s) => PublicKey.findProgramAddressSync([Buffer.from("seat-hand"), runtime.toBuffer(), u8(s)], PROGRAM_ID)[0]);
report.accounts = { authority: authority.publicKey.toBase58(), config: config.toBase58(), runtime: runtime.toBase58(), dealer: dealer.toBase58(), hands: hands.map(String) };
const base = new Connection(BASE_RPC, "confirmed");
const perKeys = (target) => [
  r(authority.publicKey, true), w(runtime), w(target), w(permissionPdaFromAccount(target)),
  r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
];

report.steps = {};
try {
  // ---- base layer ----
  log("1/8 base: create table, seat six players, delegate");
  report.steps.fund = await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: authority.publicKey, lamports: 30_000_000 })], [payer]);
  report.steps.create_table = await send(base, [ix("create_table", [w(config), w(runtime), w(authority.publicKey, true), r(SystemProgram.programId)], Buffer.concat([u64(tableId), u8(SEATS)]))], [authority]);
  report.steps.joins = [];
  for (let s = 0; s < SEATS; s++) {
    // The deployer pays the fee; the player's wallet signs. Wallets need no SOL.
    report.steps.joins.push(await send(base, [ix("poc_join", [r(players[s].wallet.publicKey, true), w(runtime)], Buffer.concat([u8(s), players[s].session.publicKey.toBuffer()]))], [payer, players[s].wallet]));
  }
  report.steps.delegate = await send(base, [ix("delegate_table", [
    r(authority.publicKey, true), r(config),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(runtime, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(runtime)), w(delegationMetadataPdaFromDelegatedAccount(runtime)),
    w(runtime), r(TEE_VALIDATOR), r(PROGRAM_ID), r(DELEGATION_PROGRAM_ID), r(SystemProgram.programId),
  ])], [authority]);

  // ---- PER setup ----
  log("2/8 PER: auth everyone");
  const conns = {
    authority: teeConn(await tokenFor(authority)),
    stranger: teeConn(await tokenFor(Keypair.generate())),
    no_token: teeConn(null),
  };
  for (let s = 0; s < SEATS; s++) {
    conns[`session${s}`] = teeConn(await tokenFor(players[s].session));
    conns[`wallet${s}`] = teeConn(await tokenFor(players[s].wallet));
  }
  const tee = conns.authority;
  const vis = await waitFor(async () => { const a = await tee.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 60_000);
  report.steps.runtime_visible_in_per_ms = vis.ms;
  if (!vis.value) throw new Error("runtime never appeared in PER");

  log("3/8 PER: permissions, dealer state, six seat hands");
  report.steps.open_runtime_permission = await send(tee, [ix("open_runtime_permission", perKeys(runtime))], [authority], { skipPreflight: true });
  report.steps.open_dealer = await send(tee, [ix("open_dealer", perKeys(dealer))], [authority], { skipPreflight: true });
  report.steps.open_seat_hands = [];
  for (let s = 0; s < SEATS; s++) {
    report.steps.open_seat_hands.push(await send(tee, [ix("open_seat_hand", perKeys(hands[s]), u8(s))], [authority], { skipPreflight: true }));
  }

  // ---- deal + per-player delivery ----
  log("4/8 PER: deal (P1 test deck) and watch delivery");
  const notified = Array(SEATS).fill(null);
  let tDeal = 0;
  const subs = [];
  for (let s = 0; s < SEATS; s++) {
    const c = conns[`session${s}`];
    subs.push([c, c.onAccountChange(hands[s], (acc) => { if (notified[s] === null && acc.data[49] !== 0 || acc.data[50] !== 0) notified[s] = notified[s] ?? ms(tDeal); }, { commitment: "processed" })]);
  }
  await sleep(1500);
  tDeal = performance.now();
  report.steps.deal = await send(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority], { skipPreflight: true });
  await sleep(2500);
  for (const [c, id] of subs) await c.removeAccountChangeListener(id);

  // Each player re-reads their own hand (don't rely on the socket alone).
  const deck = testDeck(0);
  report.steps.delivery = [];
  const seen = new Set();
  let correct = 0;
  for (let s = 0; s < SEATS; s++) {
    const t0 = performance.now();
    const acc = await conns[`session${s}`].getAccountInfo(hands[s]);
    const readMs = ms(t0);
    const cards = acc ? [...acc.data.subarray(49, 52)] : null;
    const expected = dealPositions(s, SEATS).map((p) => deck[p]);
    const ok = !!cards && cards.every((c, i) => c === expected[i]);
    if (ok) correct++;
    cards?.forEach((c) => seen.add(c));
    report.steps.delivery.push({ seat: s, ws_notified_ms: notified[s], reread_ms: readMs, cards_match_deal: ok });
  }
  report.steps.delivery_summary = {
    seats_with_correct_cards: correct,
    distinct_cards: seen.size,
    ws_notified: notified.filter((x) => x !== null).length,
    ws_notify_ms: stats(notified.filter((x) => x !== null)),
  };

  // ---- privacy matrix ----
  log("5/8 privacy matrix: every identity x every account");
  const targets = { runtime, dealer, ...Object.fromEntries(hands.map((h, s) => [`hand${s}`, h])) };
  const expectRead = (who, what) => {
    if (what === "dealer") return false;
    if (what === "runtime") return who === "authority" || who.startsWith("session");
    if (what.startsWith("hand")) return who === `session${what.slice(4)}`;
    return false;
  };
  const matrix = {};
  const violations = [];
  for (const who of Object.keys(conns)) {
    matrix[who] = {};
    for (const [what, key] of Object.entries(targets)) {
      let got;
      try { got = !!(await conns[who].getAccountInfo(key)); } catch { got = false; }
      matrix[who][what] = got ? "R" : "-";
      if (got !== expectRead(who, what)) violations.push(`${who} ${got ? "CAN" : "cannot"} read ${what}`);
    }
  }
  report.steps.privacy = { matrix, violations, pass: violations.length === 0 };

  // ---- cleanup ----
  log("6/8 PER: close seat hands and dealer");
  report.steps.close = [];
  for (let s = 0; s < SEATS; s++) {
    report.steps.close.push(await send(tee, [ix("close_ephemeral", perKeys(hands[s]), Buffer.from([1, s]))], [authority], { skipPreflight: true }));
  }
  report.steps.close.push(await send(tee, [ix("close_ephemeral", perKeys(dealer), Buffer.from([0]))], [authority], { skipPreflight: true }));

  log("7/8 PER: commit + undelegate table runtime");
  report.steps.undelegate = await send(tee, [ix("undelegate_table", [w(authority.publicKey, true), w(runtime), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
  const home = await waitFor(async () => { const a = await base.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 120_000, 500);
  report.steps.runtime_back_on_base_ms = home.ms;

  log("8/8 base layer: secret accounts must not exist");
  const onBase = {};
  for (const [what, key] of Object.entries(targets)) {
    if (what === "runtime") continue;
    onBase[what] = (await base.getAccountInfo(key)) ? "PRESENT" : "absent";
  }
  // The committed runtime must say "dealt" and contain no 3-card hand bytes.
  const rt = home.value?.data;
  const leaked = rt ? players.some((_, s) => {
    const cards = Buffer.from(dealPositions(s, SEATS).map((p) => deck[p]));
    return rt.includes(cards);
  }) : null;
  report.steps.base_layer = { secret_accounts: onBase, runtime_contains_hand_bytes: leaked };
  report.ok = report.steps.privacy.pass
    && correct === SEATS && seen.size === SEATS * 3
    && !!home.value && Object.values(onBase).every((v) => v === "absent") && leaked === false;
} catch (e) {
  report.ok = false;
  report.error = String(e.stack ?? e).slice(0, 600);
}
report.auth_transient_failures = authFailures;
report.finished_at = new Date().toISOString();

const out = resolve(arg("out", `${repoRoot}/docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf006-${region}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

const s = report.steps;
console.log(`\nCF-006 six-player table — ${region} — ${report.ok ? "PASSED" : "FAILED"}`);
if (report.error) console.log(`error: ${report.error.split("\n")[0]}`);
if (s.delivery_summary) console.log(`delivery: ${JSON.stringify(s.delivery_summary)}`);
if (s.privacy) {
  const cols = Object.keys(Object.values(s.privacy.matrix)[0]);
  console.log(`\n${"reader \\ account".padEnd(16)} ${cols.map((c) => c.padStart(7)).join("")}`);
  for (const [who, row] of Object.entries(s.privacy.matrix)) console.log(`${who.padEnd(16)} ${cols.map((c) => row[c].padStart(7)).join("")}`);
  console.log(`\nviolations: ${s.privacy.violations.length ? s.privacy.violations.join("; ") : "none"}`);
}
if (s.base_layer) console.log(`base layer: ${JSON.stringify(s.base_layer)}`);
console.log(`\nFull results: ${out}`);
process.exit(report.ok ? 0 : 1);
