import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { handCtx, rosterHash, saltCommitment, verifyCard, vrfCallerSeed } from "../src/fairness.ts";

const vectors = JSON.parse(readFileSync(new URL("../../../docs/spec/vectors/cf-fairness-v2.json", import.meta.url), "utf8"));
const b = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

test("fairness helpers reproduce the frozen CF-Fairness v2 vectors", () => {
  for (const c of vectors.cases) {
    const i = c.input, o = c.output;
    const wallets = i.wallets.map((w: string) => new PublicKey(b(w)));
    const roster = rosterHash(i.seats, wallets);
    assert.equal(hex(roster), o.roster_hash, `${c.name}: roster`);
    const ctx = handCtx(new PublicKey(b(i.program_id)), new PublicKey(b(i.table)), BigInt(i.hand_no), roster, i.rules_version);
    assert.equal(hex(ctx), o.hand_ctx, `${c.name}: ctx`);
    const comm = i.seats.map((s: number, k: number) => saltCommitment(ctx, s, b(i.salts[k])));
    assert.deepEqual(comm.map(hex), o.salt_commitments, `${c.name}: commitments`);
    assert.equal(hex(vrfCallerSeed(ctx, comm)), o.vrf_caller_seed, `${c.name}: caller seed`);
    const root = b(o.merkle_root);
    for (const p of o.proofs) {
      const card = o.deck[p.position];
      assert.ok(verifyCard(root, ctx, p.position, card, b(p.leaf_salt), p.siblings.map(b)), `${c.name}: proof ${p.position}`);
      assert.ok(!verifyCard(root, ctx, p.position, (card + 1) % 52, b(p.leaf_salt), p.siblings.map(b)), "a wrong card fails");
    }
  }
});
