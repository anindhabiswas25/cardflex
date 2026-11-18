// Card Flex keeper (CF-051). Drives every live table it can read.
// Env:
//   CARDFLEX_PER_TOKEN   PER read token issued by the table authority (`cf-admin token`)
//   CARDFLEX_KEEPER_KEY  keypair file paying fees (needs SOL on the base layer for syncs)
//   CARDFLEX_TABLES      comma-separated TableConfig addresses (default: every delegated table)
//   CARDFLEX_DB          SQLite file shared with the API (index every hand); optional
//   CARDFLEX_BASE_RPC, CARDFLEX_PER_RPC, TICK_MS (500), HEARTBEAT_SECS (600), HAND_GAP_SECS (5)
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, ENDPOINTS, PROGRAM_ID, loadVerifier, perConnection, runtimePda, sizeOf, verifierWasmUrl } from "@card-flex/client-sdk";
import { Store } from "@card-flex/api/store";
import { Keeper } from "./keeper.ts";

const env = process.env;
if (!env.CARDFLEX_PER_TOKEN || !env.CARDFLEX_KEEPER_KEY) {
  console.error("set CARDFLEX_PER_TOKEN (cf-admin token) and CARDFLEX_KEEPER_KEY (fee payer keypair file)");
  process.exit(2);
}
const base = new Connection(env.CARDFLEX_BASE_RPC ?? ENDPOINTS.devnet.base, "confirmed");
const per = perConnection(env.CARDFLEX_PER_TOKEN, env.CARDFLEX_PER_RPC ?? ENDPOINTS.devnet.per);
const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(env.CARDFLEX_KEEPER_KEY, "utf8"))));
const store = env.CARDFLEX_DB ? new Store(env.CARDFLEX_DB) : undefined;
const verifier = store ? await loadVerifier(readFileSync(verifierWasmUrl)) : undefined;
const keeper = new Keeper({
  base, per, key, store, verifier,
  heartbeatSecs: BigInt(env.HEARTBEAT_SECS ?? 600), handGapSecs: BigInt(env.HAND_GAP_SECS ?? 5),
});
const tick = Number(env.TICK_MS ?? 500);

async function tables(): Promise<PublicKey[]> {
  if (env.CARDFLEX_TABLES) return env.CARDFLEX_TABLES.split(",").map((s) => new PublicKey(s.trim()));
  const configs = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }], dataSlice: { offset: 0, length: 0 } });
  const rts = await base.getMultipleAccountsInfo(configs.map((c) => runtimePda(c.pubkey)), { dataSlice: { offset: 0, length: 0 } });
  return configs.filter((_, i) => rts[i]?.owner.equals(DELEGATION_PROGRAM_ID)).map((c) => c.pubkey);
}

console.log(`keeper ${key.publicKey.toBase58()} (tick ${tick} ms)`);
let list: PublicKey[] = [];
let lastScan = 0;
for (;;) {
  if (Date.now() - lastScan > 30_000) {
    try { list = await tables(); lastScan = Date.now(); console.log(`driving ${list.length} table(s)`); } catch (e) { console.error("table scan failed:", String((e as Error).message ?? e)); }
  }
  await Promise.all(list.map((c) => keeper.tick(c).catch((e) => console.error(c.toBase58().slice(0, 8), String(e?.message ?? e)))));
  await new Promise((r) => setTimeout(r, tick));
}
