#!/usr/bin/env node
// CF-004: base -> PER -> base round trip on Devnet, with write-latency
// measurements and a privacy smoke check.
//
// Usage:
//   pnpm roundtrip -- --region <label> [--writes 50]
// Env:
//   CARDFLEX_DEVNET_KEYPAIR  funded devnet wallet (default ~/.config/cardflex/devnet-deployer.json)
//   CARDFLEX_BASE_RPC        base-layer RPC (default https://rpc.magicblock.app/devnet)
//   CARDFLEX_TEE_RPC         PER endpoint (default https://devnet-tee.magicblock.app)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount, GetCommitmentSignature, getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const PROGRAM_ID = new PublicKey("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");
// --target tee (default): MagicBlock PER. --target er-as: public ER in Asia,
// used only as a latency baseline (no privacy, so privacy steps are skipped).
const TARGETS = {
  tee: { rpc: "https://devnet-tee.magicblock.app", validator: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", private: true },
  "er-as": { rpc: "https://devnet-as.magicblock.app", validator: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57", private: false },
};
const BASE_RPC = process.env.CARDFLEX_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
const KEYPAIR = process.env.CARDFLEX_DEVNET_KEYPAIR ?? `${homedir()}/.config/cardflex/devnet-deployer.json`;

// Discriminators from target/idl/card_flex.json.
const IX = {
  probe_init: [93, 147, 195, 252, 166, 56, 221, 247],
  probe_delegate: [128, 139, 94, 152, 221, 11, 5, 142],
  probe_make_private: [168, 174, 112, 25, 59, 214, 160, 161],
  probe_write: [14, 140, 183, 133, 37, 195, 5, 31],
  probe_commit: [213, 253, 176, 239, 206, 141, 229, 183],
  probe_undelegate: [229, 233, 69, 5, 125, 134, 139, 48],
  probe_secret_create: [15, 83, 170, 113, 225, 30, 29, 228],
  probe_secret_write: [72, 5, 150, 93, 160, 113, 217, 201],
  probe_secret_close: [124, 238, 62, 201, 70, 53, 136, 92],
};

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const region = arg("region");
if (!region) { console.error("Missing --region <label>"); process.exit(2); }
const WRITES = Number(arg("writes", "50"));
const TARGET = arg("target", "tee");
if (!TARGETS[TARGET]) { console.error(`--target must be one of ${Object.keys(TARGETS).join(", ")}`); process.exit(2); }
const TEE_RPC = process.env.CARDFLEX_TEE_RPC ?? TARGETS[TARGET].rpc;
const TEE_VALIDATOR = new PublicKey(TARGETS[TARGET].validator);
const PRIVATE = TARGETS[TARGET].private;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const stats = (xs) => (xs.length ? { n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) } : { n: 0 });
const sleep = (t) => new Promise((r) => setTimeout(r, t));
const log = (...a) => console.error(...a);
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const ix = (name, keys, data = Buffer.alloc(0)) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([Buffer.from(IX[name]), data]) });
const w = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

async function send(conn, instructions, signers, { skipPreflight = false, blockhash, onSent } = {}) {
  const tx = new Transaction().add(...instructions);
  const bh = blockhash ?? (await conn.getLatestBlockhash("confirmed"));
  tx.recentBlockhash = bh.blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const t0 = performance.now();
  onSent?.(t0);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
  const sendMs = ms(t0);
  const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  if (res.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(res.value.err)}`);
  return { sig, ms: ms(t0), send_ms: sendMs };
}

async function tokenFor(kp) {
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, async (m) => nacl.sign.detached(m, kp.secretKey));
  return token;
}
const teeConn = (token) =>
  new Connection(`${TEE_RPC}?token=${token}`, { commitment: "confirmed", wsEndpoint: `${TEE_RPC.replace(/^http/, "ws")}?token=${token}` });

async function waitFor(fn, timeoutMs, everyMs = 200) {
  const t0 = performance.now();
  while (performance.now() - t0 < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return { value: v, ms: ms(t0) };
    await sleep(everyMs);
  }
  return { value: null, ms: ms(t0), timedOut: true };
}

// ---------- run ----------
const report = { probe: "CF-004", version: 1, region, target: TARGET, started_at: new Date().toISOString(), program: PROGRAM_ID.toBase58(), steps: {} };
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8"))));
const authority = Keypair.generate(); // per-run, like a per-seat session key
const base = new Connection(BASE_RPC, "confirmed");
const [probe] = PublicKey.findProgramAddressSync([Buffer.from("probe"), authority.publicKey.toBuffer()], PROGRAM_ID);
const permission = permissionPdaFromAccount(probe);
const [secret] = PublicKey.findProgramAddressSync([Buffer.from("secret"), probe.toBuffer()], PROGRAM_ID);
const secretPermission = permissionPdaFromAccount(secret);
report.accounts = { authority: authority.publicKey.toBase58(), probe: probe.toBase58(), permission: permission.toBase58(), secret: secret.toBase58() };
log(`authority ${authority.publicKey.toBase58()}\nprobe     ${probe.toBase58()}`);

try {
  // 1. Base layer: fund authority, create probe, delegate to the TEE validator.
  log("1/7 base: fund + init");
  report.steps.fund = await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: authority.publicKey, lamports: 20_000_000 })], [payer]);
  report.steps.init = await send(base, [ix("probe_init", [w(probe), w(authority.publicKey, true), r(SystemProgram.programId)])], [authority]);

  log("2/7 base: delegate to TEE validator");
  report.steps.delegate = await send(base, [ix("probe_delegate", [
    r(authority.publicKey, true),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(probe, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(probe)),
    w(delegationMetadataPdaFromDelegatedAccount(probe)),
    w(probe),
    r(TEE_VALIDATOR),
    r(PROGRAM_ID),
    r(DELEGATION_PROGRAM_ID),
    r(SystemProgram.programId),
  ])], [authority]);

  // 2. PER: authenticate and wait until the delegated account is visible.
  log("3/7 PER: auth + wait for delegated account");
  let t0 = performance.now();
  const token = PRIVATE ? await tokenFor(authority) : null;
  report.steps.auth = PRIVATE ? { ms: ms(t0) } : { skipped: "public ER" };
  const tee = PRIVATE ? teeConn(token) : new Connection(TEE_RPC, { commitment: "confirmed", wsEndpoint: TEE_RPC.replace(/^http/, "ws") });
  const visible = await waitFor(async () => {
    const acc = await tee.getAccountInfo(probe);
    return acc && acc.owner.equals(PROGRAM_ID) ? acc : null;
  }, 60_000);
  report.steps.delegation_visible_in_per = { ms: visible.ms, ok: !!visible.value };
  if (!visible.value) throw new Error("delegated account never appeared in PER");

  log("4/7 PER: make private");
  if (PRIVATE) report.steps.make_private = await send(tee, [ix("probe_make_private", [
    r(authority.publicKey, true), w(probe), w(permission), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
  ])], [authority], { skipPreflight: true });

  // 3. Write latency: send -> confirmed, and send -> account notification
  // (what other players would see).
  log(`5/7 PER: ${WRITES} writes`);
  const pending = new Map();
  const notifyMs = [];
  const subId = tee.onAccountChange(probe, (acc) => {
    const value = acc.data.readBigUInt64LE(8 + 32);
    const t = pending.get(value);
    if (t !== undefined) { notifyMs.push(ms(t)); pending.delete(value); }
  }, { commitment: "processed" });
  await sleep(1000);
  const confirmMs = [];
  const sendMs = [];
  const failures = [];
  // A client caches the blockhash; refresh it every 20 writes (well inside its validity).
  let bh = null;
  for (let i = 1; i <= WRITES; i++) {
    if (i % 20 === 1) bh = await tee.getLatestBlockhash("confirmed");
    const value = BigInt(Date.now()) * 1000n + BigInt(i);
    try {
      const res = await send(tee, [ix("probe_write", [r(authority.publicKey, true), w(probe)], u64(value))], [authority], {
        skipPreflight: true, blockhash: bh, onSent: (t) => pending.set(value, t),
      });
      confirmMs.push(res.ms);
      sendMs.push(res.send_ms);
      report.last_value = value.toString();
    } catch (e) {
      failures.push(String(e.message ?? e).slice(0, 160));
    }
  }
  await sleep(1500);
  await tee.removeAccountChangeListener(subId);
  report.steps.writes = {
    send_rpc_ms: stats(sendMs), confirm_ms: stats(confirmMs), notify_ms: stats(notifyMs),
    missed_notifications: pending.size, failures,
    samples: { send_rpc_ms: sendMs, confirm_ms: confirmMs, notify_ms: notifyMs },
  };

  // 4. Privacy smoke check (full test suite is G1 / CF-007).
  log("6/7 privacy smoke check");
  if (PRIVATE) {
  const stranger = Keypair.generate();
  const strangerConn = teeConn(await tokenFor(stranger));
  const noTokenConn = new Connection(TEE_RPC, "confirmed");
  const readable = async (c) => { try { return !!(await c.getAccountInfo(probe)); } catch (e) { return `error: ${String(e.message ?? e).slice(0, 100)}`; } };
  report.steps.privacy_smoke = {
    owner_can_read: await readable(tee),
    stranger_token_can_read: await readable(strangerConn),
    no_token_can_read: await readable(noTokenConn),
  };
  }

  // 4b. ADR 0002 assumption A1: ephemeral-only account with a private permission.
  if (PRIVATE) {
    log("A1: ephemeral secret account");
    const secretKeys = [r(authority.publicKey, true), w(probe), w(secret), w(secretPermission), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID)];
    const secret1 = Buffer.alloc(32, 0xa1);
    const secret2 = Buffer.alloc(32, 0xb2);
    const a1 = {};
    try {
      a1.create = await send(tee, [ix("probe_secret_create", secretKeys, secret1)], [authority], { skipPreflight: true });
      const strangerA1 = Keypair.generate();
      const strangerA1Conn = teeConn(await tokenFor(strangerA1));
      const noTok = new Connection(TEE_RPC, "confirmed");
      const readSecret = async (c) => {
        try {
          const acc = await c.getAccountInfo(secret);
          if (!acc) return "denied/absent";
          return acc.data.subarray(8, 40).equals(secret1) || acc.data.subarray(8, 40).equals(secret2) ? `READ ${acc.data[8].toString(16)}` : "read (other data)";
        } catch (e) { return `error: ${String(e.message ?? e).slice(0, 80)}`; }
      };
      const multi = async (c) => {
        try { const [acc] = await c.getMultipleAccountsInfo([secret]); return acc ? "READ" : "denied/absent"; }
        catch (e) { return `error: ${String(e.message ?? e).slice(0, 80)}`; }
      };
      // Live subscription from a stranger: must receive nothing on writes.
      let strangerNotes = 0;
      const sub = strangerA1Conn.onAccountChange(secret, () => { strangerNotes++; }, { commitment: "processed" });
      let ownerNotes = 0;
      const ownerSub = tee.onAccountChange(secret, () => { ownerNotes++; }, { commitment: "processed" });
      await sleep(1000);
      a1.write = await send(tee, [ix("probe_secret_write", [r(authority.publicKey, true), r(probe), w(secret)], secret2)], [authority], { skipPreflight: true });
      await sleep(2000);
      await strangerA1Conn.removeAccountChangeListener(sub);
      await tee.removeAccountChangeListener(ownerSub);
      a1.reads = {
        owner_get: await readSecret(tee),
        stranger_get: await readSecret(strangerA1Conn),
        no_token_get: await readSecret(noTok),
        stranger_get_multiple: await multi(strangerA1Conn),
        no_token_get_multiple: await multi(noTok),
        owner_ws_notifications: ownerNotes,
        stranger_ws_notifications: strangerNotes,
        on_base_layer: (await base.getAccountInfo(secret)) ? "PRESENT" : "absent",
      };
      // Open question 2: is the transaction carrying the secret hidden from non-members?
      const txView = async (c, sig) => {
        try {
          const tx = await c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (!tx) return "denied/absent";
          const msg = tx.transaction.message;
          const ixs = msg.compiledInstructions ?? [];
          const keys = msg.staticAccountKeys ?? [];
          const raw = Buffer.concat(ixs.map((i) => Buffer.from(i.data)));
          if (raw.includes(secret2) || raw.includes(secret1)) return "VISIBLE incl. secret bytes";
          if (!ixs.length && !keys.length && !(tx.meta?.logMessages?.length)) return "redacted (signature + status only)";
          return `visible (${keys.length} keys, ${ixs.length} ixs, ${tx.meta?.logMessages?.length ?? 0} logs)`;
        } catch (e) { return `error: ${String(e.message ?? e).slice(0, 80)}`; }
      };
      await sleep(1000);
      a1.tx_visibility = {
        owner_create_tx: await txView(tee, a1.create.sig),
        stranger_create_tx: await txView(strangerA1Conn, a1.create.sig),
        no_token_create_tx: await txView(noTok, a1.create.sig),
        stranger_write_tx: await txView(strangerA1Conn, a1.write.sig),
        no_token_write_tx: await txView(noTok, a1.write.sig),
      };
      a1.tx_hidden = Object.entries(a1.tx_visibility).filter(([k]) => !k.startsWith("owner")).every(([, v]) => v.startsWith("redacted") || v === "denied/absent");
      a1.close = await send(tee, [ix("probe_secret_close", secretKeys)], [authority], { skipPreflight: true });
      a1.after_close_owner_get = await readSecret(tee);
      a1.pass = a1.reads.owner_get.startsWith("READ b2") && a1.reads.stranger_get === "denied/absent" && a1.reads.no_token_get === "denied/absent"
        && a1.reads.stranger_get_multiple === "denied/absent" && a1.reads.no_token_get_multiple === "denied/absent"
        && a1.reads.stranger_ws_notifications === 0 && a1.reads.on_base_layer === "absent"
        && a1.tx_hidden === true;
    } catch (e) {
      a1.pass = false;
      a1.error = String(e.message ?? e).slice(0, 300);
    }
    report.steps.a1_ephemeral_secret = a1;
  }

  // 5. Commit (stay delegated), then commit + undelegate.
  log("7/7 commit, then undelegate");
  const commitTx = await send(tee, [ix("probe_commit", [w(authority.publicKey, true), w(probe), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
  t0 = performance.now();
  const commitSig = await GetCommitmentSignature(commitTx.sig, tee);
  const baseHasValue = await waitFor(async () => {
    const acc = await base.getAccountInfo(probe);
    return acc && acc.data.readBigUInt64LE(8 + 32).toString() === report.last_value ? acc : null;
  }, 60_000, 500);
  report.steps.commit = { per_tx_ms: commitTx.ms, base_signature: commitSig, until_base_has_value_ms: ms(t0), base_value_matches: !!baseHasValue.value };

  const undelTx = await send(tee, [ix("probe_undelegate", [w(authority.publicKey, true), w(probe), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
  t0 = performance.now();
  const backHome = await waitFor(async () => {
    const acc = await base.getAccountInfo(probe);
    return acc && acc.owner.equals(PROGRAM_ID) ? acc : null;
  }, 120_000, 500);
  report.steps.undelegate = { per_tx_ms: undelTx.ms, until_owned_by_program_on_base_ms: backHome.ms, ok: !!backHome.value };
  if (PRIVATE) report.steps.a1_ephemeral_secret.on_base_after_undelegate = (await base.getAccountInfo(secret)) ? "PRESENT" : "absent";
  report.ok = !!backHome.value && !!baseHasValue.value && failures.length === 0 && (!PRIVATE || report.steps.a1_ephemeral_secret.pass === true);
} catch (e) {
  report.ok = false;
  report.error = String(e.stack ?? e).slice(0, 600);
}
report.finished_at = new Date().toISOString();

const out = resolve(arg("out", `${repoRoot}/docs/probes/${report.started_at.replace(/[:.]/g, "-")}-cf004-${TARGET}-${region}.json`));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + "\n");

const s = report.steps;
console.log(`\nCF-004 round trip — ${TARGET} — ${region} — ${report.ok ? "PASSED" : "FAILED"}`);
if (report.error) console.log(`error: ${report.error.split("\n")[0]}`);
const row = (k, v) => console.log(`  ${k.padEnd(34)} ${v}`);
if (s.delegate) row("base delegate confirm", `${s.delegate.ms} ms`);
if (s.delegation_visible_in_per) row("delegation visible in PER", `${s.delegation_visible_in_per.ms} ms`);
if (s.writes) {
  row("write send RPC p50 / p95", `${s.writes.send_rpc_ms.p50} / ${s.writes.send_rpc_ms.p95} ms`);
  row("write confirm p50 / p95", `${s.writes.confirm_ms.p50} / ${s.writes.confirm_ms.p95} ms (n=${s.writes.confirm_ms.n})`);
  row("write -> subscriber p50 / p95", `${s.writes.notify_ms.p50} / ${s.writes.notify_ms.p95} ms (n=${s.writes.notify_ms.n})`);
}
if (s.privacy_smoke) row("privacy smoke", JSON.stringify(s.privacy_smoke));
if (s.a1_ephemeral_secret) {
  row("A1 ephemeral secret", s.a1_ephemeral_secret.pass ? "PASS" : "FAIL");
  if (s.a1_ephemeral_secret.reads) row("A1 reads", JSON.stringify(s.a1_ephemeral_secret.reads));
  if (s.a1_ephemeral_secret.tx_visibility) row("A1 tx visibility", JSON.stringify(s.a1_ephemeral_secret.tx_visibility));
  if (s.a1_ephemeral_secret.error) row("A1 error", s.a1_ephemeral_secret.error);
}
if (s.commit) row("commit -> value on base", `${s.commit.until_base_has_value_ms} ms (match: ${s.commit.base_value_matches})`);
if (s.undelegate) row("undelegate -> owned on base", `${s.undelegate.until_owned_by_program_on_base_ms} ms`);
console.log(`\nFull results: ${out}`);
process.exit(report.ok ? 0 : 1);
