import { test } from "node:test";
import assert from "node:assert/strict";
import { PHASE, decodeAccount, discriminatorOf, sizeOf, type TableRuntime } from "@card-flex/client-sdk";
import { VRF_TIMEOUT_SLOTS, decide, type Ctx } from "../src/decide.ts";

function runtime(patch: (r: any) => void): TableRuntime {
  const d = new Uint8Array(8 + sizeOf({ defined: { name: "TableRuntime" } }));
  d.set(discriminatorOf("TableRuntime"), 0);
  const r = decodeAccount<any>("TableRuntime", d);
  r.locked = true;
  r.boot = 25_000n;
  patch(r);
  return r;
}
const ctx = (p: Partial<Ctx> = {}): Ctx => ({ nowSecs: 1_000n, slot: 10_000n, lastCommitSecs: 990n, heartbeatSecs: 300n, handGapSecs: 3n, departedSynced: 0, ...p });

test("idle: starts a hand only with 2+ players who can pay the boot, after the pause", () => {
  const two = (r: any) => { r.occupied = 0b11; r.stacks[0] = 1_000_000n; r.stacks[1] = 1_000_000n; };
  assert.equal(decide(runtime(two), ctx()).kind, "start_hand");
  assert.equal(decide(runtime((r) => { two(r); r.last_hand_end = 998n; }), ctx()).kind, "wait", "program's 3 s gap since the last hand");
  assert.equal(decide(runtime((r) => { two(r); r.last_hand_end = 997n; }), ctx()).kind, "start_hand");
  assert.equal(decide(runtime((r) => { two(r); r.last_hand_end = 997n; }), ctx({ handGapSecs: 5n })).kind, "wait", "keeper's own longer pause");
  assert.equal(decide(runtime((r) => { two(r); r.stacks[1] = 24_999n; }), ctx()).kind, "wait", "seat 1 can't pay the boot");
  assert.equal(decide(runtime((r) => { two(r); r.locked = false; }), ctx()).kind, "wait", "not live yet");
});

test("idle: revoke live grants first; sync departed players; heartbeat when quiet", () => {
  assert.deepEqual(decide(runtime((r) => { r.grants = 0b110; r.occupied = 0b111; }), ctx()), { kind: "revoke_views", pairs: [[1, 2]] });
  assert.deepEqual(decide(runtime((r) => { r.departed = 0b100; }), ctx()), { kind: "commit_and_sync", reason: "departed" });
  assert.equal(decide(runtime((r) => { r.departed = 0b100; }), ctx({ departedSynced: 0b100 })).kind, "wait");
  assert.deepEqual(decide(runtime(() => {}), ctx({ lastCommitSecs: 600n })), { kind: "commit_and_sync", reason: "heartbeat" });
});

test("salts: wait for players, cancel after the deadline", () => {
  const r = runtime((x) => { x.phase = PHASE.SALTS_PENDING; x.salts_deadline = 1_030n; });
  assert.equal(decide(r, ctx()).kind, "wait");
  assert.equal(decide(r, ctx({ nowSecs: 1_030n })).kind, "cancel_salts");
  assert.equal(decide(runtime((x) => { x.phase = PHASE.SALTS_DONE; }), ctx()).kind, "request_shuffle");
});

test("VRF: wait for the callback, cancel after the timeout", () => {
  const r = runtime((x) => { x.phase = PHASE.VRF_PENDING; x.vrf_request_slot = 7_000n; });
  assert.equal(decide(r, ctx({ slot: 7_000n + VRF_TIMEOUT_SLOTS - 1n })).kind, "wait");
  assert.equal(decide(r, ctx({ slot: 7_000n + VRF_TIMEOUT_SLOTS })).kind, "cancel_hand");
});

test("deal, play, reveal, finish", () => {
  const order = (x: any) => { x.dealing_order = [2, 0, 1, 0, 0, 0]; x.dealing_count = 3; };
  assert.deepEqual(decide(runtime((x) => { order(x); x.phase = PHASE.SEEDED; }), ctx()), { kind: "deal_hand", order: [2, 0, 1] });
  const dealt = (x: any) => { order(x); x.phase = PHASE.DEALT; x.turn_deadline = 1_020n; x.action_seq = 4n; x.game.order = [2, 0, 1, 0, 0, 0]; x.game.n = 3; x.hand_no = 5n; };
  assert.equal(decide(runtime(dealt), ctx()).kind, "wait", "player to act");
  assert.deepEqual(decide(runtime(dealt), ctx({ nowSecs: 1_020n })), { kind: "timeout_turn", order: [2, 0, 1], seq: 4n });
  // Accepted Side Show between seats 0 and 1, not granted yet.
  const ss = (x: any) => { dealt(x); x.side_show_hand_no = 5n; x.side_show_viewers[0] = 0b10; x.side_show_viewers[1] = 0b01; };
  assert.deepEqual(decide(runtime(ss), ctx()), { kind: "grant_view", a: 0, b: 1 });
  assert.equal(decide(runtime((x) => { ss(x); x.grants = 0b11; }), ctx()).kind, "wait", "already granted");
  assert.equal(decide(runtime((x) => { ss(x); x.side_show_hand_no = 4n; }), ctx()).kind, "wait", "stale viewers from an old hand are ignored");
  assert.deepEqual(decide(runtime((x) => { order(x); x.phase = PHASE.HAND_COMPLETE; }), ctx()), { kind: "reveal_hand", order: [2, 0, 1] });
  assert.deepEqual(decide(runtime((x) => { order(x); x.phase = PHASE.REVEALED; }), ctx()), { kind: "finish_hand", order: [2, 0, 1] });
});

test("CF-053: a stuck hand in any phase gets abort_lost_hand; idle or revealed tables never do", () => {
  const order = (x: any) => { x.dealing_order = [2, 0, 1, 0, 0, 0]; x.dealing_count = 3; };
  for (const phase of [PHASE.SALTS_PENDING, PHASE.SALTS_DONE, PHASE.VRF_PENDING, PHASE.SEEDED, PHASE.DEALT, PHASE.HAND_COMPLETE]) {
    const r = runtime((x) => { order(x); x.phase = phase; x.turn_deadline = 2_000n; x.salts_deadline = 2_000n; });
    assert.deepEqual(decide(r, ctx({ stuck: true })), { kind: "abort_lost_hand", order: [2, 0, 1] }, `phase ${phase}`);
    assert.notEqual(decide(r, ctx()).kind, "abort_lost_hand", `phase ${phase} not stuck`);
  }
  for (const phase of [PHASE.IDLE, PHASE.REVEALED]) {
    assert.notEqual(decide(runtime((x) => { order(x); x.phase = phase; }), ctx({ stuck: true })).kind, "abort_lost_hand");
  }
});

test("CF-056: heartbeat during a long hand too, never instead of a real step", () => {
  const order = (x: any) => { x.dealing_order = [2, 0, 1, 0, 0, 0]; x.dealing_count = 3; x.game.order = [2, 0, 1, 0, 0, 0]; x.game.n = 3; };
  const dealt = runtime((x) => { order(x); x.phase = PHASE.DEALT; x.turn_deadline = 2_000n; });
  assert.equal(decide(dealt, ctx()).kind, "wait", "player thinking, heartbeat not due");
  assert.deepEqual(decide(dealt, ctx({ lastCommitSecs: 600n })), { kind: "commit_and_sync", reason: "heartbeat" }, "long hand: keep the refund clock fresh");
  const salts = runtime((x) => { order(x); x.phase = PHASE.SALTS_PENDING; x.salts_deadline = 2_000n; });
  assert.equal(decide(salts, ctx({ lastCommitSecs: 600n })).kind, "commit_and_sync");
  // A due step wins over the heartbeat.
  const timedOut = runtime((x) => { order(x); x.phase = PHASE.DEALT; x.turn_deadline = 900n; });
  assert.equal(decide(timedOut, ctx({ lastCommitSecs: 600n })).kind, "timeout_turn");
});
