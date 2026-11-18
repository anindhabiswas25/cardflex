# CF-012 findings — independent verifier and gate G2

- **Date:** 2026-11-18
- **G2 status: passed** (provisional on the same terms as G1: one location
  so far). All four G2 criteria from PRD §13.6 are met; see the table.
- **Code:**
  - `crates/fairness-verifier`: library plus the `cf-verify` CLI;
  - `HandLog`, `reveal_hand` and `open_hand_log_permission` in
    `programs/card-flex`;
  - `handRecordFromLog` in `packages/probes/src/common.mjs`.
- **Raw data:** `docs/probes/*p2-handflow*.json` and
  `docs/probes/*hand-record-*.json` (real Devnet hand records).

## What was built

1. **`HandLog`** (ADR 0002): a public account created with the table,
   delegated with `TableRuntime` and committed back with it. It gets an
   explicit **public** permission (`open_hand_log_permission`,
   `is_private = false`) instead of relying on the default.
2. **`reveal_hand`** (anyone may call it, once, after `DEALT`) copies the
   spec §9 reveal into `HandLog`:
   - hand number, rules and protocol versions;
   - seats and wallets in dealing order;
   - salts, re-checked against their commitments;
   - commitments, `hand_ctx`, roster hash, VRF caller seed, VRF output and
     Merkle root.

   In P5 it runs only after showdown, because a reveal makes the deck public.
3. **`cf-verify <record.json>`** is offline. It doesn't depend on the program
   crate, the network, MagicBlock or the backend. It reads a
   `cf-hand-record/1` record, rebuilds everything with `fairness-core` and
   prints the PRD §22 report:

   ```text
   Protocol version:         VALID
   Roster hash:              VALID
   Game context:             VALID
   Salt commitments:         VALID         6 salts match their commitments
   Randomness binding:       VALID         VRF caller seed …
   Shuffle reconstruction:   VALID
   Deck uniqueness:          VALID         52 distinct cards
   Merkle root:              VALID
   Dealing map:              VALID         6 shown hands match the deal
   Overall:                  VALID
   ```

   Exit status: 0 = VALID, 1 = INVALID, 2 = unreadable record.

## Evidence

| Test | Result |
| --- | --- |
| Honest record | VALID |
| Every frozen spec vector case | VALID |
| One field tampered at a time (root, caller seed, roster, context, VRF output, a salt, a shown card, protocol version) | INVALID at the expected check(s) |
| **10,000 random hands** (2–6 seats), honest | 10,000 VALID |
| Same 10,000 with one random tamper each | 10,000 INVALID |
| LiteSVM: real `deal_hand` + `reveal_hand`, then the verifier on the resulting `HandLog` | VALID |
| **Devnet** (2 runs): real salts, VRF, deal and reveal; `HandLog` read **with no token**; record verified with `cf-verify` | VALID |
| Devnet: the same record with one salt changed | INVALID, "Salt commitments" flagged |
| Devnet: after undelegate, the `HandLog` committed to the **Solana base layer** equals the PER reveal and verifies | VALID |
| Devnet: second reveal | rejected |

## Gate G2 (PRD §13.6)

| Criterion | Evidence | Status |
| --- | --- | --- |
| Verifier rebuilds 10,000 test hands | `pnpm check:g2` (CI step) | met |
| Spoofed VRF callback rejected | CF-010: stranger and authority fake callbacks rejected before, during and after fulfilment; scoped identity | met |
| Second shuffle impossible | CF-010/011: second request, second deal and late callback (hand-number bound) rejected; salts frozen mid-hand | met |
| Compute cost per deal measured | CF-011: 56–86k CU | met |

## Security review follow-up: no reveal during play (fixed)

The background review found that `reveal_hand` was allowed, by anyone, as soon
as a hand was `DEALT`. Publishing the salts and VRF output then would let
everyone rebuild every hand mid-play. Fixed:

- `reveal_hand` requires the new phase `HAND_COMPLETE`.
- Only `end_hand` sets it: an interim, authority-only stand-in. P5 replaces
  it with showdown / last-player resolution; no game is played on these
  tables yet.
- `DEALT` now counts as "hand in progress", so seat hands, salts and the
  dealer state can't be closed during play.
- The test-deck `poc_deal` goes straight to `HAND_COMPLETE` (it isn't
  played).

Devnet rerun: the hand flow passes 51/51, including reveal during play
rejected, closing a hand during play rejected, and a stranger unable to end
the hand. The privacy suite still passes 231/231; the six-player test
passes.

## Second follow-up: cleanup only after the reveal (fixed)

The next review found that once a hand reached `HAND_COMPLETE`, the salt
accounts could be closed **before** `reveal_hand`. That would make the hand
permanently unverifiable, so the audit could be suppressed. Now
`HAND_COMPLETE` also counts as in progress: hands, salts and the dealer
state can be closed only after `REVEALED`, or in `IDLE` after a cancel. The
unplayed test-deck hand uses its own terminal phase, `POC_DONE`. Devnet: the
hand flow passes 52/52, including "closing a salt account before the reveal
rejected"; the privacy suite passes 231/231; the six-player test passes.

## Not covered yet (later phases)

- Showdown, ranking and payouts aren't in the record yet (P4/P5). The
  verifier checks the deal, not the winner.
- A WASM build of the verifier for the browser (P7).
- `end_hand` is an operator-only stand-in. P5 must make showdown or
  last-player resolution the only way to reach `HAND_COMPLETE`, and remove
  `end_hand`.
