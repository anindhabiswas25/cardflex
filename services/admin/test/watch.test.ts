import { test } from "node:test";
import assert from "node:assert/strict";
import { TABLE_STATUS, decodeAccount, discriminatorOf, sizeOf } from "@card-flex/client-sdk";
import { assess, keeperAlerts, KEEPER_MIN_LAMPORTS, teeAlerts, type TableFacts } from "../src/watch.ts";

function blank<T>(name: "TableConfig" | "TableRuntime", patch: (x: any) => void): T {
  const d = new Uint8Array(8 + sizeOf({ defined: { name } }));
  d.set(discriminatorOf(name), 0);
  const x = decodeAccount<any>(name, d);
  patch(x);
  return x as T;
}
// A healthy live table: 2 seats, vault exactly rent + stacks + unswept rake.
function facts(p: (f: TableFacts) => void = () => {}): TableFacts {
  const cfg = blank<any>("TableConfig", (c) => {
    c.status = TABLE_STATUS.ACTIVE; c.ever_delegated = true; c.refund_timeout_secs = 1_800;
    c.last_sync_time = 10_000n; c.seated = 0b11; c.synced_rake = 500n; c.rake_swept = 200n;
  });
  const rt = blank<any>("TableRuntime", (r) => { r.hand_no = 40n; r.cancelled_hands = 2n; });
  const f: TableFacts = { config: "T", cfg, rt, live: true, vaultLamports: 1_000n + 3_000n + 300n, vaultRentFloor: 1_000n, ledgerStacks: [1_000n, 2_000n], nowSecs: 10_100n };
  p(f);
  return f;
}
const codes = (f: TableFacts) => assess(f).map((a) => `${a.level}:${a.code}`);

test("CF-056: a healthy table raises nothing", () => {
  assert.deepEqual(codes(facts()), []);
});

test("vault short is critical; surplus is a warning", () => {
  assert.deepEqual(codes(facts((f) => { f.vaultLamports -= 1n; })), ["critical:VAULT_SHORT"]);
  assert.deepEqual(codes(facts((f) => { f.vaultLamports += 7n; })), ["warning:VAULT_SURPLUS"]);
});

test("refund clock: warn at half the timeout, critical when anyone can refund", () => {
  assert.deepEqual(codes(facts((f) => { f.nowSecs = 10_000n + 899n; })), []);
  assert.deepEqual(codes(facts((f) => { f.nowSecs = 10_000n + 900n; })), ["warning:REFUND_NEAR"]);
  assert.deepEqual(codes(facts((f) => { f.nowSecs = 10_000n + 1_800n; })), ["critical:REFUND_DUE"]);
  // A table that isn't live (never delegated, or closed) has no running clock.
  assert.deepEqual(codes(facts((f) => { f.nowSecs = 99_999n; f.live = false; })), []);
  // CF-073: nor does an empty live table (not heartbeated, can't be refunded).
  assert.deepEqual(codes(facts((f) => { f.nowSecs = 99_999n; f.cfg.seated = 0; f.ledgerStacks = []; f.vaultLamports = 1_000n + 300n; })), []);
});

test("refunded table with unclaimed seats; cancel rate", () => {
  assert.deepEqual(codes(facts((f) => { (f.cfg as any).status = TABLE_STATUS.REFUNDED; f.nowSecs = 99_999n; })), ["warning:CLAIMS_PENDING"]);
  assert.deepEqual(codes(facts((f) => { (f.rt as any).cancelled_hands = 9n; })), ["warning:CANCEL_RATE"], "9 of 40 > 20%");
  assert.deepEqual(codes(facts((f) => { (f.rt as any).hand_no = 5n; (f.rt as any).cancelled_hands = 4n; })), [], "too few hands to judge");
});

test("CF-058: TEE attestation alarms", () => {
  const m = { mrTd: "aa".repeat(48), rtMr0: "bb".repeat(48), rtMr1: "cc".repeat(48), rtMr2: "dd".repeat(48) };
  const codes = (r: Parameters<typeof teeAlerts>[1]) => teeAlerts("https://tee", r).map((a) => `${a.level}:${a.code}`);
  assert.deepEqual(codes({ ok: true, reasons: [], tcbStatus: "UpToDate", measurements: m }), []);
  assert.deepEqual(codes({ ok: false, reasons: ["measurements are not on the allow-list (software changed or unknown machine)"], tcbStatus: "UpToDate", measurements: m }), ["critical:TEE_MEASUREMENTS_CHANGED"]);
  assert.deepEqual(codes({ ok: false, reasons: ["TCB status OutOfDate, required UpToDate"], tcbStatus: "OutOfDate", advisoryIds: ["INTEL-SA-1"] }), ["critical:TEE_TCB"]);
  assert.deepEqual(codes({ ok: false, reasons: ["quote reportData does not match our challenge"] }), ["critical:TEE_QUOTE_REPLAYED"]);
  assert.deepEqual(codes({ ok: false, reasons: ["HTTP 502"] }), ["critical:TEE_QUOTE_INVALID"]);
  assert.deepEqual(codes({ error: "fetch failed" }), ["warning:TEE_UNREACHABLE"]);
});

test("CF-060: keeper alarms", () => {
  const codes = (o: Parameters<typeof keeperAlerts>[0]) => keeperAlerts(o).map((a) => `${a.level}:${a.code}`);
  assert.deepEqual(codes({ health: { ok: true, reasons: [] }, balance: KEEPER_MIN_LAMPORTS }), []);
  assert.deepEqual(codes({ health: { error: "ECONNREFUSED" } }), ["critical:KEEPER_DOWN"]);
  assert.deepEqual(codes({ health: { ok: false, reasons: ["no successful PER read for 45 s"] } }), ["critical:KEEPER_UNHEALTHY"]);
  assert.deepEqual(codes({ balance: KEEPER_MIN_LAMPORTS - 1n }), ["warning:KEEPER_LOW_FUNDS"]);
  assert.deepEqual(codes({}), []);
});
