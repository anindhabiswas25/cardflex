import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, PROGRAM_ID, decode, decodeAccount, discriminatorOf, encode, loadVerifier, sizeOf, verifierWasmUrl } from "@card-flex/client-sdk";
import { handLogBytes } from "@card-flex/client-sdk/testing";
import { indexOnce } from "../src/indexer.ts";
import { apiHandler, startServer } from "../src/server.ts";
import type { ChainSource, RawTable } from "../src/source.ts";
import { Store } from "../src/store.ts";

const probes = new URL("../../../docs/probes/", import.meta.url);
const records = readdirSync(probes).filter((f) => /-game-hand\d+\.json$/.test(f)).slice(0, 5).map((f) => JSON.parse(readFileSync(new URL(f, probes), "utf8")));

/** An account of `name` with every field zero, then `patch` applied. */
function account(name: "TableConfig" | "TableRuntime", patch: (o: any) => void): Uint8Array {
  const size = 8 + sizeOf({ defined: { name } });
  const zero = new Uint8Array(size);
  zero.set(discriminatorOf(name), 0);
  const obj = decodeAccount<any>(name, zero);
  patch(obj);
  const out: number[] = [...discriminatorOf(name)];
  encode({ defined: { name } }, obj, out);
  return Uint8Array.from(out);
}

class FakeSource implements ChainSource {
  logs = new Map<string, Uint8Array>();
  tables: RawTable[] = [];
  add(rec: any) {
    const config = new PublicKey(rec.table);
    if (this.tables.some((t) => t.config.equals(config))) return;
    const seats = rec.seats.map((s: any) => s.seat);
    this.tables.push({
      config,
      configData: account("TableConfig", (c) => { c.max_seats = 6; c.status = 1; c.min_buy_in = 1_000_000n; c.max_buy_in = 5_000_000n; c.seated = 0b111111; }),
      runtimeData: account("TableRuntime", (r) => {
        r.config = config; r.max_seats = 6; r.boot = BigInt(rec.game.boot); r.rake_bps = rec.game.rake_bps; r.rake_cap = BigInt(rec.game.rake_cap);
        r.occupied = seats.reduce((m: number, s: number) => m | (1 << s), 0); r.hand_no = BigInt(rec.hand_no) + 1n;
        rec.seats.forEach((s: any) => { r.wallets[s.seat] = new PublicKey(s.wallet); r.stacks[s.seat] = 1_000_000n; });
      }),
      runtimeOwner: DELEGATION_PROGRAM_ID,
    });
  }
  async listTables() { return this.tables; }
  async handLog(config: PublicKey) { return this.logs.get(config.toBase58()) ?? null; }
}

test("indexes, verifies and settles real Devnet hands; the API serves them", async () => {
  assert.ok(records.length >= 3);
  const verifier = await loadVerifier(readFileSync(verifierWasmUrl));
  const store = new Store();
  const src = new FakeSource();
  let indexed = 0;
  for (const rec of records) {
    src.add(rec);
    src.logs.set(rec.table, handLogBytes(rec));
    const st = await indexOnce(src, store, verifier);
    assert.deepEqual(st.errors, []);
    indexed += st.newHands;
    // Same log again: not indexed twice.
    assert.equal((await indexOnce(src, store, verifier)).newHands, 0);
  }
  assert.equal(indexed, records.length);

  for (const rec of records) {
    const h = store.hand(rec.table, rec.hand_no)!;
    assert.equal(h.verified, 1, `hand ${rec.hand_no} verified`);
    const seats = store.handSeats(rec.table, rec.hand_no);
    const net = seats.reduce((a, x) => a + BigInt(x.net), 0n);
    assert.equal(net, -BigInt(rec.game.rake), "nets sum to minus the rake");
    assert.equal(BigInt(h.pot), seats.reduce((a, x) => a + BigInt(x.contributed), 0n));
    assert.deepEqual(seats.filter((x) => x.won).map((x) => x.seat).sort(), [...rec.game.winners].sort());
    for (const x of seats) assert.equal(JSON.parse(x.cards_json).length, 3);
  }

  // Tampered hand: stored, flagged, never hidden.
  const bad = structuredClone(records[0]);
  bad.hand_no = "999";
  bad.game.rake = String(BigInt(bad.game.rake) + 1n);
  src.logs.set(bad.table, handLogBytes(bad));
  assert.equal((await indexOnce(src, store, verifier)).invalidHands, 1);
  assert.equal(store.hand(bad.table, "999")!.verified, 0);

  // ---- API ----
  const api = apiHandler(store);
  const get = (path: string) => api("GET", new URL(path, "http://x"));
  const tables = get("/tables").body as any[];
  assert.ok(tables.length >= 1 && tables[0].live === true && tables[0].buyIn.min === "1000000");
  const rec = records[0];
  const hands = get(`/tables/${rec.table}/hands`).body as any[];
  assert.ok(hands.some((x) => x.handNo === rec.hand_no && x.verified));
  const one = get(`/hands/${rec.table}/${rec.hand_no}`).body as any;
  assert.equal(one.record.format, "cf-hand-record/2");
  assert.ok(one.checks.every((c: any) => c.status !== "INVALID"));
  const wallet = rec.seats[0].wallet;
  const player = get(`/players/${wallet}`).body as any;
  assert.ok(player.handsPlayed >= 1);
  assert.equal(get("/nope").status, 404);
  assert.equal(api("POST", new URL("/tables", "http://x")).status, 405, "read-only");

  // Over real HTTP too.
  const server = await startServer(store, 0);
  const port = (server.address() as any).port;
  const r = await fetch(`http://127.0.0.1:${port}/tables/${rec.table}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(((await r.json()) as any).config, rec.table);
  server.close();
  void decode; void PROGRAM_ID;
});
