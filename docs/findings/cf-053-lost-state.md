# CF-053: aborting a hand whose secret state was lost

**Date:** 2026-11-19 · **Build:** devnet test-deck variant, 818,744 bytes ·
**Decision record:** ADR 0004 amendment (CF-053)

## Problem

ADR 0004 rule 8 assumed a hand that lost its ephemeral accounts (dealer,
seat hands, salts) would end through the refund timeout. Reading the code
for P8 showed it wouldn't:

- `deal_hand`, `act`/`timeout_turn` (they rank hands on every action) and
  `reveal_hand` all need those accounts, so the hand could never finish.
- Every `sync_hand` refreshes the liveness clock, including mid-hand
  heartbeats, so `emergency_refund` never became possible while a keeper ran.
- A leave asked for mid-hand waits for `next_hand`, which needs a revealed hand.

So players' money stayed frozen for as long as anyone kept committing. This
is a money-safety fix, not only an edge case.

## Fix

`abort_lost_hand` (permissionless, PER), the keeper wiring and a grant
reset in `open_seat_hand`. Details and reasoning: ADR 0004 amendment.

- The secret accounts are private: an RPC reader gets `null` whether they
  exist or not. Only the program can tell, so the instruction takes all of
  them (dealer, seat hands, salts of the dealt seats in dealing order) and
  succeeds only if one is missing. The keeper tries it once a hand has made
  no progress for `STUCK_SECS` (default 120 s); `NotLost` means all is well.
- Before settlement no stack has moved, so the hand is just dropped. A
  settled hand that can't be revealed is voided: start stacks restored,
  rake taken back, checked for conservation.

## Tests

LiteSVM (`tests/test_game.rs`):

| Test | Checks |
| --- | --- |
| `lost_state_aborts_a_dealt_hand_without_moving_money` | a zeroed (untagged) account counts as lost; refused while all accounts exist, for a short list, a wrong order and an undealt seat's account (state byte-identical); after losing a seat hand mid-betting: play blocked, abort works, stacks equal the start, `hand_no` +1, counted; second abort refused |
| `settled_but_unrevealable_hand_is_voided` | pot-limit showdown with rake; abort refused while revealable; after losing the dealer: every stack back to its start, rake back to 0, pending leave applied |
| `lost_salt_aborts_before_the_deal_without_strikes` | salt round with one salt missing: abort, no strike, commitments cleared |

Keeper: `decide` returns `abort_lost_hand` for a stuck hand in every
in-progress phase and never when idle or revealed (`pnpm test:keeper`).
SDK: instruction bytes and account order (`pnpm test:sdk`).

## Devnet drill (`pnpm lost-drill`)

We can't make the TEE lose state, so the drill closes a seat's salt account
between hands (allowed) and then starts a hand: the same "needed ephemeral
account missing" condition inside real PER.

First build: 11/11 twice (tables `BVuMiegi…`, `8WaCNAcr…`). Final build
(with the zeroed-account check): **11/11 twice**, tables
`F52Hy2T5tu2C1psiWjjZpadjaZsujLxxRg53yirM91PP` and
`CeersPg5r5B4MeMFXyypryC41Mvar5mdu8j2UwP1x1ZV` (one more attempt stopped in
its own setup on a lost confirmation; the drill's retry now treats
"already in use" as done). Regression: privacy suite 230/230 on the final
build; handflow 67/67 and keeper drill 7/7 on the first build (the tag
check changes only `abort_lost_hand`).

| Check | Result |
| --- | --- |
| Abort refused while idle | `WrongPhase` (6018) |
| Abort refused while every account exists | `NotLost` (6052), hand unchanged |
| Abort succeeds when a salt account is missing | yes; PER accepts a transaction naming a missing ephemeral account |
| Counted, hand moved on, no stack moved, no strike | yes |
| Keeper finds the stuck hand itself | aborted after 11–13 s (`STUCK_SECS` = 10), before the 30 s salt timeout |
| Recovery | after `open_salt` a full hand played, indexed VALID |
| Vault | `check_vault` strict: exact |

## Still open

- A real TEE restart that loses state can't be produced on Devnet. The
  check covers both shapes a restart could leave: the account gone, or still
  there but zeroed (no tag; every real one is tagged when opened). Anything
  else (an account restored with stale contents) would still be stuck, and
  the refund timeout only fires once nobody syncs; that case belongs in the
  operator runbook (CF-056: stop the keeper's heartbeat for that table).
- Re-creating the lost accounts is an operator step (`open_dealer` /
  `open_seat_hand` / `open_salt`); `cf-admin` has no single "repair"
  command yet (small follow-up for CF-056 runbooks).
