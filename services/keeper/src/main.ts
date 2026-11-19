// Card Flex keeper (CF-051). Drives every live table it can read.
// Env:
//   CARDFLEX_PER_TOKEN   PER read token issued by the table authority (`cf-admin token`)
//   CARDFLEX_KEEPER_KEY  keypair file paying fees (needs SOL on the base layer for syncs)
//   CARDFLEX_TABLES      comma-separated TableConfig addresses to drive, or
//   CARDFLEX_AUTHORITY   drive every live table of this authority (anyone can create tables;
//                        the keeper never pays fees for strangers' tables). One of the two is required.
//   CARDFLEX_DB          SQLite file shared with the API (index every hand); optional
//   CARDFLEX_BASE_RPC, CARDFLEX_PER_RPC, TICK_MS (500), HEARTBEAT_SECS (300), HAND_GAP_SECS (5),
//   STUCK_SECS (120: a hand with no progress this long is checked for lost secret state, CF-053),
//   PER_SOCKETS (16: keep-alive sockets to the PER, CF-061),
//   (commits always pass MagicBlock's fee vault so the table's runtime pays; CF-057)
import { readFileSync } from "node:fs";
import { Agent } from "node:https";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, ENDPOINTS, PROGRAM_ID, loadVerifier, magicFeeVault, perConnection, runtimePda, sizeOf, verifierWasmUrl } from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { Keeper } from "./keeper.ts";
import { runKeeper } from "./run.ts";

const env = process.env;
if (!env.CARDFLEX_PER_TOKEN || !env.CARDFLEX_KEEPER_KEY || !(env.CARDFLEX_TABLES || env.CARDFLEX_AUTHORITY)) {
  console.error("set CARDFLEX_PER_TOKEN (cf-admin token), CARDFLEX_KEEPER_KEY (fee payer keypair file) and CARDFLEX_TABLES or CARDFLEX_AUTHORITY");
  process.exit(2);
}
const base = new Connection(env.CARDFLEX_BASE_RPC ?? ENDPOINTS.devnet.base, "confirmed");
// CF-061: a small, explicit keep-alive pool; the PER throttles new connections per IP.
const per = perConnection(env.CARDFLEX_PER_TOKEN, env.CARDFLEX_PER_RPC ?? ENDPOINTS.devnet.per, "confirmed", new Agent({ keepAlive: true, maxSockets: Number(env.PER_SOCKETS ?? 16) }));
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.CARDFLEX_KEEPER_KEY, "utf8"))));
const store = env.CARDFLEX_DB ? new Store(env.CARDFLEX_DB) : undefined;
const verifier = store ? await loadVerifier(readFileSync(verifierWasmUrl)) : undefined;
const keeper = new Keeper({
  base, per, key, store, verifier,
  heartbeatSecs: BigInt(env.HEARTBEAT_SECS ?? 300), handGapSecs: BigInt(env.HAND_GAP_SECS ?? 5),
  stuckSecs: Number(env.STUCK_SECS ?? 120),
  // CF-057: with the fee vault the table's runtime pays; without it only 10 commits per table work.
  feeVault: magicFeeVault(),
});
const tick = Number(env.TICK_MS ?? 500);

async function tables(): Promise<PublicKey[]> {
  if (env.CARDFLEX_TABLES) return env.CARDFLEX_TABLES.split(",").map((s) => new PublicKey(s.trim()));
  // Only this operator's tables: TableConfig.authority is the first field (offset 8).
  const authority = new PublicKey(env.CARDFLEX_AUTHORITY!);
  const configs = await base.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }, { memcmp: { offset: 8, bytes: authority.toBase58() } }],
    dataSlice: { offset: 0, length: 0 },
  });
  const rts = await base.getMultipleAccountsInfo(configs.map((c) => runtimePda(c.pubkey)), { dataSlice: { offset: 0, length: 0 } });
  return configs.filter((_, i) => rts[i]?.owner.equals(DELEGATION_PROGRAM_ID)).map((c) => c.pubkey);
}

console.log(`keeper ${key.publicKey.toBase58()} (tick ${tick} ms)`);
// CF-061: one batched reader + one independent worker per table.
await runKeeper(keeper, { per, tables, tickMs: tick });
