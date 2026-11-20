import { test } from "node:test";
import assert from "node:assert/strict";
import { health, READ_STALE_MS, TABLE_FAILING } from "../src/health.ts";
import type { TableState } from "../src/keeper.ts";

const st = (p: Partial<TableState> = {}): TableState => ({ lastCommitSecs: 0n, syncedEpochs: [-1, -1, -1, -1, -1, -1], backoffUntil: 0, failures: 0, hands: 3, progress: "", progressAt: 1_000_000, joinFails: new Map(), ...p });

test("CF-060: healthy keeper", () => {
  const h = health(new Map([["T1", st()]]), { startedAt: 0, lastReadAt: 1_000_000, lastScanAt: 1_000_000, tables: 1 }, 1_005_000);
  assert.equal(h.ok, true);
  assert.equal(h.perTable[0].progressAgeSecs, 5);
});

test("CF-060: stale reads and a failing table are unhealthy", () => {
  const now = 2_000_000;
  const h = health(new Map([["TableAAAAAAAA", st({ failures: TABLE_FAILING })]]), { startedAt: 0, lastReadAt: now - READ_STALE_MS - 1, lastScanAt: 0, tables: 1 }, now);
  assert.equal(h.ok, false);
  assert.equal(h.reasons.length, 2);
  // Never read since start (> 30 s) counts too; no tables at all is fine.
  assert.equal(health(new Map(), { startedAt: 0, lastReadAt: 0, lastScanAt: 0, tables: 2 }, READ_STALE_MS + 1).ok, false);
  assert.equal(health(new Map(), { startedAt: 0, lastReadAt: 0, lastScanAt: 0, tables: 0 }, 10 * READ_STALE_MS).ok, true);
});

test("CF-064 review: a table that hasn't named the keeper is unhealthy", () => {
  const h = health(new Map([["TableBBBBBBBB", st({ notKeeper: true })]]), { startedAt: 0, lastReadAt: 1_000, lastScanAt: 0, tables: 1 }, 2_000);
  assert.equal(h.ok, false);
  assert.match(h.reasons[0], /hasn't named this keeper/);
});

test("a table whose runtime is close to the commit margin is unhealthy", () => {
  const h = health(new Map([["TableCCCCCCCC", st({ headroom: 1_000_000 })]]), { startedAt: 0, lastReadAt: 1_000, lastScanAt: 0, tables: 1 }, 2_000);
  assert.equal(h.ok, false);
  assert.match(h.reasons[0], /above rent/);
  assert.equal(health(new Map([["T", st({ headroom: 5_000_000 })]]), { startedAt: 0, lastReadAt: 1_000, lastScanAt: 0, tables: 1 }, 2_000).ok, true);
});
