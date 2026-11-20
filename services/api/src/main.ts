// Devnet indexer + API. Env: CARDFLEX_BASE_RPC, CARDFLEX_PER_RPC, CARDFLEX_DB
// (default ./cardflex.db), PORT (4000), HOST (127.0.0.1), POLL_MS (3000).
import { readFileSync } from "node:fs";
import { loadVerifier, verifierWasmUrl } from "@card-flex/client-sdk";
import { indexOnce } from "./indexer.ts";
import { startServer } from "./server.ts";
import { RpcSource } from "./source.ts";
import { Store } from "./store.ts";

const env = process.env;
const store = new Store(env.CARDFLEX_DB ?? "cardflex.db");
const verifier = await loadVerifier(readFileSync(verifierWasmUrl));
const src = new RpcSource(env.CARDFLEX_BASE_RPC, env.CARDFLEX_PER_RPC);
const port = Number(env.PORT ?? 4000), host = env.HOST ?? "127.0.0.1", pollMs = Number(env.POLL_MS ?? 3000);

await startServer(store, port, host);
console.log(`card-flex api on http://${host}:${port} (poll every ${pollMs} ms)`);
for (;;) {
  const t0 = performance.now();
  try {
    const st = await indexOnce(src, store, verifier);
    if (st.newHands || st.errors.length) console.log(new Date().toISOString(), { ...st, errors: st.errors.slice(0, 5) });
  } catch (e) {
    console.error("index pass failed:", String((e as Error).message ?? e));
  }
  await new Promise((r) => setTimeout(r, Math.max(0, pollMs - (performance.now() - t0))));
}
