// CF-057 fee measurement on Devnet: what each party pays at each step of
// the player journey (connect wallet -> buy in -> join -> play -> leave ->
// cash out), and whether per-hand commits keep landing past MagicBlock's
// "10 commits without a fee payer" (we play HANDS > 10 hands on one table).
//
// Every party has its own fresh key, so base-layer balance deltas are exact:
//   operator (table authority), keeper (fee payer), 2 players (wallet +
//   session key). The runtime PDA's base lamports show whether commits charge
//   the delegated account. Writes docs/probes/<ts>-cf057-fees-<region>.json.
// Usage: pnpm --filter @card-flex/keeper fees   (HANDS=12 REGION=dev-machine-1)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, DELEGATION_PROGRAM_ID, ENDPOINTS, PHASE, act, buyIn, cashOut, magicFeeVault, confirmByPolling, sendAndConfirm, decodeLedger, decodeRuntime, joinSeat, newSalt, newSessionKey,
  perConnection, perLogin, submitSalt, tableAddresses,
} from "@card-flex/client-sdk";
import { buildIx } from "@card-flex/client-sdk";
import { closeTablePer, createTable, delegateTable, openTablePer, setKeeper } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const HANDS = Number(process.env.HANDS ?? 12);
const REGION = process.env.REGION ?? "dev-machine-1";
const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = 1_000_000_000;

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  // CF-067: Devnet endpoints drop requests now and then; retries never resend a landed transaction.
  await sendAndConfirm(conn, ixs, signers, { skipPreflight, retries: 5, backoffMs: 2_000 });
}

// ---- parties ----
const operator = Keypair.generate();
const keeperKey = Keypair.generate();
const players = [0, 1].map((seat) => ({ seat, wallet: Keypair.generate(), session: newSessionKey() }));
const fund = async (to: PublicKey, lamports: number) => send(base, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: to, lamports })], [deployer]);
// Keep the throwaway keys, so a crashed run can still close its table and
// return the funds (KEYS_DIR, default /tmp).
const keysFile = `${process.env.KEYS_DIR ?? "/tmp"}/cf057-keys-${Date.now()}.json`;
writeFileSync(keysFile, JSON.stringify({ operator: [...operator.secretKey], keeper: [...keeperKey.secretKey], wallets: players.map((p) => [...p.wallet.secretKey]), sessions: players.map((p) => [...p.session.secretKey]) }), { mode: 0o600 });
console.log(`throwaway keys: ${keysFile}`);
await fund(operator.publicKey, 0.12 * SOL);
await fund(keeperKey.publicKey, 0.04 * SOL);
for (const p of players) await fund(p.wallet.publicKey, 0.01 * SOL);

const tracked = () => ({
  operator: operator.publicKey, keeper: keeperKey.publicKey,
  wallet0: players[0].wallet.publicKey, wallet1: players[1].wallet.publicKey,
  session0: players[0].session.publicKey, session1: players[1].session.publicKey,
});
type Snap = Record<string, number>;
async function snap(extra: Record<string, PublicKey> = {}): Promise<Snap> {
  const all = { ...tracked(), ...extra };
  const keys = Object.keys(all);
  const infos = await base.getMultipleAccountsInfo(Object.values(all));
  return Object.fromEntries(keys.map((k, i) => [k, infos[i]?.lamports ?? 0]));
}
const steps: { step: string; delta: Snap }[] = [];
let last: Snap = await snap();
async function record(step: string, extra: Record<string, PublicKey> = {}) {
  const now = await snap(extra);
  const delta: Snap = {};
  for (const k of new Set([...Object.keys(now), ...Object.keys(last)])) {
    const d = (now[k] ?? 0) - (last[k] ?? 0);
    if (d !== 0) delta[k] = d;
  }
  steps.push({ step, delta });
  console.log(`${step.padEnd(34)} ${Object.entries(delta).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ") || "(no base-layer cost)"}`);
  last = now;
}

// With the fee vault the table's runtime PDA pays its own commits (CF-057).
const feeVault = process.env.FEE_VAULT === "0" ? undefined : magicFeeVault();

// ---- operator opens a table ----
const { config, ixs } = createTable(operator.publicKey, { tableId: BigInt(Date.now()), seats: 2, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 1_800 });
const t = tableAddresses(config);
const extra = { runtime: t.runtime, vault: t.vault, ledger0: t.ledger(0), ledger1: t.ledger(1) };
last = await snap(extra);
await send(base, ixs, [operator]);
await record("operator: create + configure table", extra);

// ---- players: connect wallet, buy in, join (before the table goes live) ----
for (const p of players) {
  await send(base, [buyIn({ wallet: p.wallet.publicKey, config, seat: p.seat, amount: 1_000_000n, sessionKey: p.session.publicKey })], [p.wallet]);
  await record(`player ${p.seat}: buy_in (1,000,000 lamports)`, extra);
  await send(base, [joinSeat({ payer: p.wallet.publicKey, config, seat: p.seat, live: false })], [p.wallet]);
  await record(`player ${p.seat}: join_seat`, extra);
}

// ---- operator takes it live ----
await send(base, [delegateTable(operator.publicKey, config)], [operator]);
await record("operator: delegate to the TEE", extra);
const opPer = perConnection((await perLogin(operator)).token);
for (let i = 0; i < 60 && !(await opPer.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const ix of openTablePer(operator.publicKey, config, 2)) await send(opPer, [ix], [operator], true);
// CF-064 review: only the table's named keeper gets per-hand paid commits.
await send(opPer, [setKeeper(operator.publicKey, config, keeperKey.publicKey, true)], [operator], true);
await record("operator: open permissions + secret accounts (PER)", extra);
const conns = await Promise.all(players.map(async (p) => perConnection((await perLogin(p.session)).token)));
await record("players: PER login (session keys)", extra);

// ---- play HANDS hands: keeper drives, players submit salts and act ----
const runtimeInPer = async () => (await opPer.getAccountInfo(t.runtime).catch(() => null))?.lamports ?? null;
const runtimeBefore = await runtimeInPer();
const keeper = new Keeper({ base, per: opPer, key: keeperKey, feeVault, heartbeatSecs: 300n, handGapSecs: 4n, log: (m) => { if (/failed/.test(m)) console.log("  keeper:", m); } });
const seqBefore = decodeRuntime((await base.getAccountInfo(t.runtime))!.data).commit_seq; // before play: fine to fail loudly
const t0 = Date.now();
while ((keeper.tables.get(config.toBase58())?.hands ?? 0) < HANDS && Date.now() - t0 < 25 * 60_000) {
  await keeper.tick(config).catch(() => {}); // network blips: next round
  const a = await opPer.getAccountInfo(t.runtime).catch(() => null);
  if (a) {
    const rt = decodeRuntime(a.data);
    for (const [i, p] of players.entries()) {
      const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(p.seat);
      if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> p.seat) & 1)) {
        await send(conns[i], [submitSalt({ session: p.session.publicKey, config, seat: p.seat, salt: newSalt() })], [p.session], true).catch(() => {});
      } else if (rt.phase === PHASE.DEALT && rt.game.order[rt.game.turn] === p.seat) {
        // A few real actions per hand, then fold.
        const action = rt.action_seq < 3n ? ACTION.CHAAL : ACTION.PACK;
        const amount = action === ACTION.CHAAL ? rt.game.stake * (rt.game.seats[p.seat].seen ? 2n : 1n) : 0n;
        await send(conns[i], [act({ session: p.session.publicKey, config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [p.session], true).catch(() => {});
      }
    }
  }
  await sleep(400);
}
const hands = keeper.tables.get(config.toBase58())?.hands ?? 0;
let seqAfter = seqBefore;
for (let i = 0; i < 5; i++) { const r = await base.getAccountInfo(t.runtime).catch(() => null); if (r) { seqAfter = decodeRuntime(r.data).commit_seq; break; } await sleep(2000); }
await record(`play ${hands} hands (keeper commits + syncs each)`, extra);
console.log(`commits landed on base: commit_seq ${seqBefore} -> ${seqAfter} (${seqAfter - seqBefore} commits)`);
const runtimeAfter = await runtimeInPer();
console.log(`runtime in PER: ${runtimeBefore} -> ${runtimeAfter} lamports (pays commits when the fee vault is passed)`);

// ---- players leave and cash out ----
for (const [i, p] of players.entries()) {
  await send(conns[i], [buildIx("leave_seat", { signer: p.session.publicKey, runtime: t.runtime }, { seat: p.seat })], [p.session], true);
}
await record("players: leave_seat (PER, session key)", extra);
for (let i = 0; i < 20; i++) { await keeper.tick(config).catch(() => {}); const l = await base.getAccountInfo(t.ledger(0)).catch(() => null); if (l && decodeLedger(l.data).left) break; await sleep(1500); }
await record("keeper: commit + sync the leaves", extra);
for (const p of players) {
  await send(base, [cashOut({ payer: p.wallet.publicKey, config, seat: p.seat, wallet: p.wallet.publicKey })], [p.wallet]);
  await record(`player ${p.seat}: cash_out`, extra);
}

// ---- operator closes the table ----
for (const ix of closeTablePer(operator.publicKey, config, 2, feeVault)) await send(opPer, [ix], [operator], true).catch((e) => console.log("  close step failed:", String(e).slice(0, 120)));
for (let i = 0; i < 60; i++) { const r = await base.getAccountInfo(t.runtime); if (r && !r.owner.equals(DELEGATION_PROGRAM_ID)) break; await sleep(2000); }
await record("operator: close + undelegate", extra);

const report = {
  ticket: "CF-057", region: REGION, at: new Date().toISOString(), config: config.toBase58(), hands,
  commits: Number(seqAfter - seqBefore), feeVault: !!feeVault,
  runtimeInPer: { before: runtimeBefore, after: runtimeAfter }, steps,
};
const dir = new URL("../../../docs/probes/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const file = `${dir}${report.at.replace(/[:.]/g, "-")}-cf057-fees-${REGION}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`wrote ${file}`);
// Return what's left to the deployer.
for (const k of [operator, keeperKey, ...players.map((p) => p.wallet)]) {
  const bal = await base.getBalance(k.publicKey);
  if (bal > 5_000) await send(base, [SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: deployer.publicKey, lamports: bal - 5_000 })], [k]).catch(() => {});
}
process.exit(hands >= HANDS ? 0 : 1);
