# CF-006 findings — six-player table on Devnet PER

- **Date:** 2026-11-18
- **Status:** CF-006 done. Privacy matrix passes in 2 of 2 Devnet runs.
  Card delivery over WebSocket is unreliable, and Devnet timing is noisy.
- **Code:** `programs/card-flex/src/table.rs` plus the table instructions in
  `lib.rs`; `packages/probes/src/tablepoc.mjs` (`pnpm tablepoc -- --region <label>`)
- **Raw data:** `docs/probes/*cf006*.json` (the 12:19 UTC run is the first
  attempt, which failed at login before retries were added)

## What was built (ADR 0002 layout)

| Account | Where | Readers |
| --- | --- | --- |
| `TableConfig` | base | public |
| `TableRuntime` | delegated to the TEE validator, `commit_frequency_ms = u32::MAX` | table authority + six session keys |
| `DealerState` (deck) | ephemeral-only | permission member is the `TableRuntime` PDA, which can't sign, so nobody |
| `SeatHand[0..5]` | ephemeral-only | that seat's session key only |

Instructions:

- base: `create_table` (pre-funds the ephemeral rent budget), `poc_join`
  (wallet + session key), `delegate_table`;
- PER: `open_runtime_permission`, `open_dealer`, `open_seat_hand`,
  `poc_deal`, `close_ephemeral`, `undelegate_table`.

`poc_deal` uses the **P1 test deck**, a rotation of the canonical deck. It
is not random; P2 replaces it with CF-Fairness v2.

## Privacy matrix (identical in both runs)

`R` = account returned, `-` = null. 15 identities × 8 accounts = 120 reads.

```text
reader \ account runtime dealer  hand0  hand1  hand2  hand3  hand4  hand5
authority              R      -      -      -      -      -      -      -
stranger               -      -      -      -      -      -      -      -
no_token               -      -      -      -      -      -      -      -
session0               R      -      R      -      -      -      -      -
wallet0                -      -      -      -      -      -      -      -
session1..5            R      -   (own hand only)
wallet1..5             -      -      -      -      -      -      -      -
```

Violations: none. Also verified in both runs:

- all six players read exactly the 3 cards the test deal assigns them
  (18 distinct cards);
- after close, commit and undelegate, none of `DealerState` or
  `SeatHand[0..5]` exists on the Solana base layer;
- the committed `TableRuntime` contains no hand's card bytes.

The player's **wallet** can't read the hand, only the session key can. That
is the CF-003 decision working: a leaked wallet-signed PER token exposes
nothing.

## Problems found

| Issue | Run 1 | Run 2 | Consequence |
| --- | --- | --- | --- |
| Owner WebSocket update on deal (`accountSubscribe` on own `SeatHand`) | 6 of 6, ~0.8–1.1 s | **0 of 6** | WebSocket can't be the delivery path for cards |
| `poc_deal` confirmation | 2.4 s | 4.4 s | far above the PRD's 500 ms card-delivery target |
| `open_seat_hand` confirmation | 0.19–10.7 s | similar spread | setup must happen before play, never in the hot path |
| Login (`/auth/login`) | ok | 1 × `UND_ERR_CONNECT_TIMEOUT`, then retried | clients retry login with backoff |

Combined with CF-004 (write p50 about 90 ms on the same endpoint), this
suggests Devnet PER is under variable load, not that dealing is inherently
slow. That is an inference; it needs runs at other times and from other
regions.

## Security review follow-up (same day)

The automated security review flagged two issues; both are fixed:

1. **Predictable deck.** `poc_deal` now fails with `TestDeckDisabled` unless
   the program was built with the `poc-test-deck` cargo feature. CI and
   default builds have it off. Devnet uses `pnpm build:program:devnet-poc`.
2. **Seats could change after permissions were built.** `TableRuntime.locked`
   is set by `open_runtime_permission`. `poc_join` then fails with
   `TableLocked`, and `poc_deal` requires the lock.

Third Devnet run with both fixes: PASSED. A late join after the lock was
rejected, the privacy matrix had no violations, nothing secret was on the
base layer, and WebSocket delivered 2 of 6 hands (about 170 ms when it
arrived). That's more evidence for the polling decision.

## Decisions

1. **The client polls for its own hand.** After the deal (seen via
   `TableRuntime.dealt` or `hand_no`), the client reads its `SeatHand` with
   `getAccountInfo` every 100–150 ms until `hand_no` matches. WebSocket is
   only a hint. This is added to CF-016.
2. **Ephemeral accounts and permissions are created at sit-down, not per
   hand.** Each hand only rewrites them. The P5 design follows this; the P1
   POC already works this way.
3. **Report to MagicBlock:** missed `accountSubscribe` notifications for
   ephemeral accounts, plus the confirmation-time spread on `devnet-tee`.
4. **Gate G1 isn't closed yet.** CF-007 must still cover:
   - `getProgramAccounts` and `getSignaturesForAddress`;
   - token reuse after a member is removed;
   - mid-hand permission changes (Side Show);
   - unauthorized writes;
   - logs and errors;
   - runs from other regions.
