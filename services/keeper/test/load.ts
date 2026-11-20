// CF-054 load test on Devnet: N tables at once, each with bot players, all
// driven by ONE keeper process (the production shape). Run as a staircase:
//   TABLES=5 pnpm load-test; then 10, 25, 50.
// Measures per step: action confirm latency (p50/p95/max), salt submit
// latency, VRF wait (request -> seeded), keeper round time, failed
// transactions by kind, hands per minute, base-layer cost per hand (keeper
// wallet), and setup cost per table. Writes docs/probes/<ts>-cf054-load-<N>.json.
// Env: TABLES (5), BOTS per table (2), HANDS per table (3), MINUTES cap (15),
//      REGION (dev-machine-1), TICK_MS (500)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Agent } from "node:https";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, act, buyIn, decodeRuntime, decodeTableConfig, joinSeat, newSalt, newSessionKey, perConnection,
  perLogin, rules, submitSalt, tableAddresses, type TableRuntime,
} from "@card-flex/client-sdk";
import { confirmByPolling, sendAndConfirm } from "@card-flex/client-sdk";
import { checkVault, closeTablePer, createTable, delegateTable, openTablePer } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";
import { runKeeper } from "../src/run.ts";

const N = Number(process.env.TABLES ?? 5);
const BOTS = Number(process.env.BOTS ?? 2);
const HANDS = Number(process.env.HANDS ?? 3);
const MINUTES = Number(process.env.MINUTES ?? 15);
const REGION = process.env.REGION ?? "dev-machine-1";
const TICK_MS = Number(process.env.TICK_MS ?? 500);

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

// ---- metrics ----
const lat = { act: [] as number[], salt: [] as number[], deal: [] as number[], round: [] as number[], actionsPerHand: [] as number[] };
const fails = new Map<string, number>();
const failSamples = new Map<string, string[]>();
const fail = (kind: string, why?: unknown) => {
  fails.set(kind, (fails.get(kind) ?? 0) + 1);
  if (why !== undefined) {
    const s = failSamples.get(kind) ?? [];
    const m = String((why as Error)?.message ?? why).replace(/\s+/g, " ").slice(0, 160);
    if (s.length < 3 && !s.includes(m)) s.push(m);
    failSamples.set(kind, s);
  }
};
// CF-061: one bounded keep-alive pool for all bots (one IP); the keeper gets
// its own, as in production. Without this, 100 bot connections opened up to
// 25 sockets each and the PER throttled the connection storm.
const BOT_SOCKETS = Number(process.env.BOT_SOCKETS ?? 32);
const botAgent = new Agent({ keepAlive: true, maxSockets: BOT_SOCKETS });
const keeperAgent = new Agent({ keepAlive: true, maxSockets: 16 });
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: xs.length ? Math.max(...xs) : null });

/** Retries a one-off call through network blips (Devnet endpoints time out now and then). */
async function retry<T>(label: string, f: () => Promise<T>, tries = 5): Promise<T> {
  for (let a = 1; ; a++) {
    try { return await f(); } catch (e) {
      fail(`net:${label}`);
      if (a >= tries) throw e;
      await sleep(1000 * a);
    }
  }
}
// A stray rejection from a background send must not kill a 15-minute run.
process.on("unhandledRejection", (e) => { fail("unhandled"); console.error("unhandled:", String((e as Error)?.message ?? e).slice(0, 160)); });

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false, retries = 2) {
  await sendAndConfirm(conn, ixs, signers, { skipPreflight, retries }); // CF-067: never twice
}
/** Bounded parallelism for setup. */
async function pool<T>(items: T[], k: number, f: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(k, items.length) }, async () => {
    while (next < items.length) { const i = next++; await f(items[i], i); }
  }));
}

// ---- setup ----
type Bot = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection; busy?: boolean };
// saltSeenAt: last time this table was seen in the salt round; the first DEALT
// after it gives "salts in -> cards dealt" (VRF + deal), within one loop round.
type Table = { config: PublicKey; bots: Bot[]; lastPhase: number; saltSeenAt: number; lastSeq: bigint };
const tables: Table[] = [];
const balance0 = await retry("balance", () => base.getBalance(admin.publicKey));
const setupT0 = now();
console.log(`CF-054 load: ${N} tables x ${BOTS} bots, ${HANDS} hands each, region ${REGION}`);
const setupFailed: string[] = [];
await pool(Array.from({ length: N }, (_, i) => i), 5, async (i) => {
  let made: PublicKey | null = null;
  try { await setupOne(i, (c) => (made = c)); } catch (e) {
    fail("setup");
    setupFailed.push(String(made ?? "?"));
    console.error(`  table ${i} setup failed (${String(made ?? "not created")}): ${String((e as Error).message ?? e).slice(0, 120)}`);
  }
});
async function setupOne(i: number, created: (c: PublicKey) => void) {
  const { config, ixs } = createTable(admin.publicKey, { tableId: BigInt(Date.now()) * 100n + BigInt(i), seats: BOTS, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 3600 });
  await send(base, ixs, [admin]);
  created(config);
  const bots: Bot[] = Array.from({ length: BOTS }, (_, seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat }));
  for (const b of bots) {
    await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.wallet.publicKey, lamports: 4_000_000 })], [admin]);
    await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 1_000_000n, sessionKey: b.session.publicKey })], [b.wallet]);
    await send(base, [joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
  }
  await send(base, [delegateTable(admin.publicKey, config)], [admin]);
  const per = perConnection((await retry("login", () => perLogin(admin))).token);
  const t = tableAddresses(config);
  for (let k = 0; k < 60 && !(await per.getAccountInfo(t.runtime).catch(() => null)); k++) await sleep(1000);
  for (const ix of openTablePer(admin.publicKey, config, BOTS)) await send(per, [ix], [admin], true);
  for (const b of bots) b.conn = perConnection((await retry("login", () => perLogin(b.session))).token, undefined, "confirmed", botAgent);
  tables.push({ config, bots, lastPhase: -1, saltSeenAt: 0, lastSeq: 0n });
  console.log(`  table ${tables.length}/${N} live (${config.toBase58().slice(0, 8)})`);
}
const setupSecs = (now() - setupT0) / 1000;
const balanceAfterSetup = await retry("balance", () => base.getBalance(admin.publicKey));

// ---- keeper (one process, all tables) ----
const keeperKey = Keypair.generate();
await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: keeperKey.publicKey, lamports: 20_000_000 * Math.max(1, Math.ceil(N / 5)) })], [admin]);
const keeperBal0 = await retry("balance", () => base.getBalance(keeperKey.publicKey));
const reader = perConnection((await retry("login", () => perLogin(admin))).token, undefined, "confirmed", keeperAgent);
const keeper = new Keeper({
  base, per: reader, key: keeperKey, heartbeatSecs: 600n, handGapSecs: 4n,
  log: (m) => { const k = /\s(\w+) failed \(\d+\): (.*)/.exec(m); if (k) fail(`keeper:${k[1]}`, k[2]); },
});

// ---- bots: what a real client does (each acts at most once at a time) ----
let roll = 0.37;
const rnd = () => (roll = (roll * 9301 + 49297) % 233280 / 233280);
async function botStep(tb: Table, b: Bot, rt: TableRuntime) {
  if (b.busy) return;
  const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(b.seat);
  let ix: TransactionInstruction | null = null, kind = "";
  if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> b.seat) & 1)) {
    ix = submitSalt({ session: b.session.publicKey, config: tb.config, seat: b.seat, salt: newSalt() }); kind = "salt";
  } else if (rt.phase === PHASE.DEALT) {
    const h = rules.Hand.fromGameState(rt.game);
    if (h.toAct() !== b.seat) return;
    const l = rules.legalActions(h, b.seat);
    // Real hands run several rounds: mostly chaal, see once in a while, show
    // only after a few rounds, rarely pack early.
    let action: number = ACTION.PACK, amount = 0n;
    const r = rnd();
    const rounds = Number(rt.action_seq);
    if (l.respond) { action = ACTION.SIDE_SHOW_RESPOND; amount = r < 0.5 ? 1n : 0n; }
    else if (l.see && r < 0.25) action = ACTION.SEE;
    else if (l.show && rounds >= 8 && r < 0.5) action = ACTION.SHOW;
    else if (l.chaal !== null && (rounds < 12 || r < 0.85)) { action = ACTION.CHAAL; amount = l.chaal; }
    else if (l.show) action = ACTION.SHOW;
    ix = act({ session: b.session.publicKey, config: tb.config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) });
    kind = "act";
  }
  if (!ix) return;
  b.busy = true;
  const t0 = now();
  send(b.conn!, [ix], [b.session], true, 0)
    .then(() => (kind === "act" ? lat.act : lat.salt).push(now() - t0))
    .catch((e) => fail(`bot:${kind}`, e))
    .finally(() => { b.busy = false; });
}

// ---- run: the production scheduler (CF-061) drives the tables; bots play ----
const runT0 = now();
let stopKeeper = false;
const keeperRun = runKeeper(keeper, {
  per: reader, tables: async () => tables.map((tb) => tb.config), tickMs: TICK_MS, scanMs: 5_000,
  stop: () => stopKeeper, log: (m) => { if (/failed/.test(m)) fail("keeper:loop"); },
});
const handsDone = () => tables.reduce((s, tb) => s + (keeper.tables.get(tb.config.toBase58())?.hands ?? 0), 0);
while (now() - runT0 < MINUTES * 60_000) {
  const r0 = now();
  // One batched read of every runtime for the bots (the keeper reads its own).
  const infos = await reader.getMultipleAccountsInfo(tables.map((tb) => tableAddresses(tb.config).runtime)).catch(() => null);
  await Promise.all(tables.map(async (tb, i) => {
    const info = infos?.[i];
    if (!info) return;
    const rt = decodeRuntime(info.data);
    if (rt.phase === PHASE.SALTS_PENDING) tb.saltSeenAt = now();
    if (rt.phase !== tb.lastPhase) {
      if (rt.phase === PHASE.DEALT && tb.saltSeenAt) { lat.deal.push(now() - tb.saltSeenAt); tb.saltSeenAt = 0; }
      if (tb.lastPhase === PHASE.DEALT) lat.actionsPerHand.push(Number(tb.lastSeq));
      tb.lastPhase = rt.phase;
    }
    if (rt.phase === PHASE.DEALT) tb.lastSeq = rt.action_seq;
    for (const b of tb.bots) await botStep(tb, b, rt);
  }));
  lat.round.push(now() - r0);
  if (tables.every((tb) => (keeper.tables.get(tb.config.toBase58())?.hands ?? 0) >= HANDS)) break;
  await sleep(TICK_MS);
}
stopKeeper = true;
await keeperRun;
const runSecs = (now() - runT0) / 1000;
const hands = handsDone();
const keeperSpent = keeperBal0 - (await retry("balance", () => base.getBalance(keeperKey.publicKey)));

// ---- money stays exact on every table ----
let exact = 0;
for (const tb of tables) {
  await retry("reconcile", async () => {
    const cfg = decodeTableConfig((await base.getAccountInfo(tb.config))!.data);
    const tx = new Transaction().add(checkVault(tb.config, cfg.seated, true));
    tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
    if (!(await base.simulateTransaction(tx)).value.err) exact++;
  });
}

// ---- tidy up: undelegate every table ----
const reader2 = perConnection((await retry("login", () => perLogin(admin))).token);
await pool(tables, 5, async (tb) => {
  for (const ix of closeTablePer(admin.publicKey, tb.config, BOTS)) await send(reader2, [ix], [admin], true, 1).catch(() => {});
});

const report = {
  ticket: "CF-054", region: REGION, at: new Date().toISOString(), tables: N, botsPerTable: BOTS, handsTarget: HANDS,
  setupSecs, runSecs, handsCompleted: hands, handsPerMinute: hands / (runSecs / 60),
  tablesFinished: tables.filter((tb) => (keeper.tables.get(tb.config.toBase58())?.hands ?? 0) >= HANDS).length,
  actionConfirmMs: summary(lat.act), saltConfirmMs: summary(lat.salt), saltsToDealtMs: summary(lat.deal), botLoopRoundMs: summary(lat.round),
  actionsPerHand: summary(lat.actionsPerHand),
  failures: Object.fromEntries(fails), failureSamples: Object.fromEntries(failSamples), botSockets: BOT_SOCKETS, vaultsExact: `${exact}/${tables.length}`, setupFailed,
  baseCostLamports: {
    setupPerTable: Math.round((balance0 - balanceAfterSetup) / N),
    // Net after undelegating (rent that came back); bots' buy-ins stay in the vaults.
    netPerTableAfterTeardown: Math.round((balance0 - (await retry("balance", () => base.getBalance(admin.publicKey)))) / N),
    keeperPerHand: hands ? Math.round(keeperSpent / hands) : null, keeperTotal: keeperSpent,
  },
};
console.log(JSON.stringify(report, null, 2));
const probes = new URL("../../../docs/probes/", import.meta.url).pathname; // repo root, whatever the cwd
mkdirSync(probes, { recursive: true });
const file = `${probes}${report.at.replace(/[:.]/g, "-")}-cf054-load-${N}-${REGION}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
console.log(`wrote ${file}`);
const ok = report.tablesFinished === N && exact === N && !setupFailed.length;
console.log(`\nCF-054 load ${N} tables — ${ok ? "PASSED" : "SEE REPORT"}`);
process.exit(ok ? 0 : 1);
