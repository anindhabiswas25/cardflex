import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { runKeeper } from "../src/run.ts";
import type { Keeper } from "../src/keeper.ts";

test("CF-061: a slow table doesn't hold back others; reads are batched; no step on a stale snapshot", async () => {
  const tables = Array.from({ length: 30 }, () => Keypair.generate().publicKey);
  const slow = tables[0].toBase58();
  const calls = { slot: 0, multi: 0 };
  const per = {
    getSlot: async () => { calls.slot++; return 1; },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => { calls.multi++; return keys.map(() => null); },
  } as unknown as Connection;
  const ticks = new Map<string, number>();
  const stale: string[] = [];
  const lastDone = new Map<string, number>();
  const keeper = {
    tick: async (c: PublicKey, snap: { at: number }) => {
      const id = c.toBase58();
      if (snap.at <= (lastDone.get(id) ?? 0)) stale.push(id);
      ticks.set(id, (ticks.get(id) ?? 0) + 1);
      if (id === slow) await new Promise((r) => setTimeout(r, 1_500)); // a commit + sync
      lastDone.set(id, Date.now());
      return { kind: "wait", why: "test" };
    },
  } as unknown as Keeper;
  const t0 = Date.now();
  await runKeeper(keeper, { per, tables: async () => tables, tickMs: 100, stop: () => Date.now() - t0 > 1_200, log: () => {} });

  const fast = ticks.get(tables[1].toBase58()) ?? 0;
  assert.equal(ticks.get(slow), 1, "the slow table is still in its one step");
  assert.ok(fast >= 6, `a fast table kept going (${fast} ticks)`);
  assert.ok(tables.slice(1).every((c) => (ticks.get(c.toBase58()) ?? 0) >= 6), "every fast table kept going");
  const rounds = calls.slot;
  assert.equal(calls.multi, rounds, "one batched read per round for 30 tables (not 30)");
  assert.deepEqual(stale, [], "no step on a snapshot taken before the table's previous step finished");
});
