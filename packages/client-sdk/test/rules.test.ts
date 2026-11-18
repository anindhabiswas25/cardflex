import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Hand, RulesError, categoryOf, handKey, legalActions, replay } from "../src/rules.ts";

const v = JSON.parse(readFileSync(new URL("../../../docs/spec/vectors/teen-patti-rules-v1.json", import.meta.url), "utf8"));

test("ranking matches every frozen hand", () => {
  for (const c of v.ranking) {
    assert.equal(handKey(c.cards), c.key, c.name);
    assert.equal(categoryOf(c.cards), c.category, c.name);
  }
});

test("every frozen game replays to exactly the recorded result or error", () => {
  for (const c of v.games) {
    const stacks = Array<bigint>(6).fill(0n), keys = Array<number>(6).fill(0);
    c.order.forEach((s: number, k: number) => { stacks[s] = BigInt(c.stacks[k]); keys[s] = handKey(c.hands[k]); });
    const rules = { boot: BigInt(c.boot), rakeBps: c.rake_bps, rakeCap: BigInt(c.rake_cap) };
    let got: Record<string, unknown>;
    try {
      const h = replay(rules, stacks, c.order, Uint8Array.from(Buffer.from(c.actions, "hex")), keys);
      got = {
        end_reason: h.over!.reason,
        winners: [...h.over!.winners].sort(),
        payouts: h.over!.payouts.map(String),
        rake: String(h.over!.rake),
        final_stacks: c.order.map((s: number) => String(h.seats[s].stack)),
      };
    } catch (e) {
      assert.ok(e instanceof RulesError, String(e));
      got = { error: e.code, error_index: e.index ?? null };
    }
    const want = { ...c.expect };
    if (want.winners) want.winners = [...want.winners].sort();
    assert.deepEqual(got, want, c.name);
  }
});

test("legal actions for a fresh hand", () => {
  const h = new Hand({ boot: 1_000n, rakeBps: 0, rakeCap: 0n }, [100_000n, 100_000n, 100_000n, 0n, 0n, 0n], [0, 1, 2]);
  const me = legalActions(h, 0);
  assert.deepEqual(me, { see: true, chaal: 1_000n, chaalDouble: 2_000n, pack: true, show: false, sideShow: false, respond: false });
  const other = legalActions(h, 1);
  assert.equal(other.chaal, null, "not your turn");
  assert.equal(other.see, true, "see is allowed any time");
});
