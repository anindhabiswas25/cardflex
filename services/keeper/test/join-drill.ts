// Devnet drill: a player who buys in mid-hand is seated by the keeper and
// dealt into the very next hand, without calling join_seat themselves.
// Usage: pnpm --filter @card-flex/keeper join-drill
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  ACTION, ENDPOINTS, PHASE, act, buyIn, confirmByPolling, sendAndConfirm, decodeRuntime, joinSeat, magicFeeVault, newSalt, newSessionKey,
  perConnection, perLogin, submitSalt, tableAddresses, type TableRuntime,
} from "@card-flex/client-sdk";
import { closeTablePer, createTable, delegateTable, openTablePer } from "../../admin/src/admin.ts";
import { Keeper } from "../src/keeper.ts";

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: [string, boolean, string?][] = [];
const check = (n: string, ok: boolean, note?: string) => { checks.push([n, ok, note]); console.log(`${ok ? "✓" : "✗"} ${n}${note ? ` (${note})` : ""}`); };

async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[], skipPreflight = false) {
  // CF-067: Devnet endpoints drop requests now and then; retries never resend a landed transaction.
  await sendAndConfirm(conn, ixs, signers, { skipPreflight, retries: 5, backoffMs: 2_000 });
}

const { config, ixs } = createTable(admin.publicKey, { tableId: BigInt(Date.now()), seats: 3, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 1_800 });
const t = tableAddresses(config);
await send(base, ixs, [admin]);
console.log("table", config.toBase58());
type Bot = { wallet: Keypair; session: Keypair; seat: number; conn?: Connection; seated: boolean };
const bots: Bot[] = [0, 1, 2].map((seat) => ({ wallet: Keypair.generate(), session: newSessionKey(), seat, seated: seat < 2 }));
for (const b of bots) await send(base, [SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: b.wallet.publicKey, lamports: 4_000_000 })], [admin]);
for (const b of bots.slice(0, 2)) {
  await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: b.seat, amount: 1_000_000n, sessionKey: b.session.publicKey })], [b.wallet]);
  await send(base, [joinSeat({ payer: b.wallet.publicKey, config, seat: b.seat, live: false })], [b.wallet]);
}
await send(base, [delegateTable(admin.publicKey, config)], [admin]);
const per = perConnection((await perLogin(admin)).token);
for (let i = 0; i < 60 && !(await per.getAccountInfo(t.runtime).catch(() => null)); i++) await sleep(1000);
for (const ix of openTablePer(admin.publicKey, config, 3)) await send(per, [ix], [admin], true);
for (const b of bots) b.conn = perConnection((await perLogin(b.session)).token);
console.log("table live with 2 players; player 2 will buy in mid-hand");

const keeper = new Keeper({ base, per, key: admin, feeVault: magicFeeVault(), heartbeatSecs: 300n, handGapSecs: 4n, log: (m) => console.log("  keeper:", m) });
const read = async (): Promise<TableRuntime | null> => { const a = await per.getAccountInfo(t.runtime).catch(() => null); return a ? decodeRuntime(a.data) : null; };

let boughtInAtHand = -1n;
let dealtIn: bigint | null = null;
const t0 = Date.now();
while (Date.now() - t0 < 6 * 60_000 && dealtIn === null) {
  await keeper.tick(config).catch(() => {});
  const rt = await read();
  if (!rt) { await sleep(500); continue; }
  // Mid-hand: player 2 buys in on the base layer, and does nothing else.
  if (boughtInAtHand < 0n && rt.phase === PHASE.DEALT) {
    const b = bots[2];
    await send(base, [buyIn({ wallet: b.wallet.publicKey, config, seat: 2, amount: 1_000_000n, sessionKey: b.session.publicKey })], [b.wallet]);
    boughtInAtHand = rt.hand_no;
    console.log(`player 2 bought in during hand #${rt.hand_no}`);
  }
  if (boughtInAtHand >= 0n && rt.hand_no > boughtInAtHand && rt.dealing_order.slice(0, rt.dealing_count).includes(2)) dealtIn = rt.hand_no;
  // Seated players submit salts and play (pack after a chaal or two).
  for (const b of bots) {
    if (!((rt.occupied >> b.seat) & 1)) continue;
    const dealt = rt.dealing_order.slice(0, rt.dealing_count).includes(b.seat);
    if (rt.phase === PHASE.SALTS_PENDING && dealt && !((rt.salts_in >> b.seat) & 1)) {
      await send(b.conn!, [submitSalt({ session: b.session.publicKey, config, seat: b.seat, salt: newSalt() })], [b.session], true).catch(() => {});
    } else if (rt.phase === PHASE.DEALT && rt.game.order[rt.game.turn] === b.seat) {
      const action = rt.action_seq < 2n ? ACTION.CHAAL : ACTION.PACK;
      const amount = action === ACTION.CHAAL ? rt.game.stake * (rt.game.seats[b.seat].seen ? 2n : 1n) : 0n;
      await send(b.conn!, [act({ session: b.session.publicKey, config, action, amount, expectedSeq: rt.action_seq, dealingOrder: rt.game.order.slice(0, rt.game.n) })], [b.session], true).catch(() => {});
    }
  }
  await sleep(400);
}
check("player 2 bought in while a hand was being played", boughtInAtHand >= 0n, `hand #${boughtInAtHand}`);
check("keeper seated player 2 and the very next hand dealt them in", dealtIn === boughtInAtHand + 1n, dealtIn === null ? "never dealt in" : `dealt in hand #${dealtIn}`);
const rt = await read();
check("player 2 is seated with its full buy-in", !!rt && ((rt.occupied >> 2) & 1) === 1);

for (const ix of closeTablePer(admin.publicKey, config, 3, magicFeeVault())) await send(per, [ix], [admin], true).catch(() => {});
const failed = checks.filter((c) => !c[1]).length;
console.log(`\njoin drill — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed); table ${config.toBase58()}`);
process.exit(failed ? 1 : 0);
