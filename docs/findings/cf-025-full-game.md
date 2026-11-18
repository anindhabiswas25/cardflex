# CF-025 — Full six-player game on Devnet (P5 exit)

- **Date:** 2026-11-19 (probe timestamps are UTC)
- **Region:** `dev-machine-1`
- **Program:** `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL` (devnet POC build, 686 KB)
- **Probe:** `pnpm game -- --region <label> [--hands N]` (`packages/probes/src/game.mjs`)
- **Reports:** `docs/probes/*-cf025-game-dev-machine-1.json`, one hand record
  per hand (`*-game-hand<N>.json`, `cf-hand-record/2`)

## What was run

Six players buy in (boot 25,000 lamports, buy-in 40 boots, rake 2.5% capped
at 10,000). Every hand runs the full loop with no backend in the action
path: `start_hand` → each dealt seat's session key submits a salt →
`request_shuffle` (MagicBlock VRF, ephemeral queue) → `deal_hand` → players
act with their session keys (`act`) using a random policy; illegal choices
are refused by the program in simulation and another is tried → the game
ends the hand (`HAND_COMPLETE`) → `reveal_hand` → `cf-verify` on the public
record → Side Show views revoked → `commit_hand` → `sync_hand` on the base
layer → `next_hand`.

## Results

| Run | Hands | Checks | Endings | Side Show grants |
| --- | --- | --- | --- | --- |
| 3 hands | 3 | 39/39 | last player, Show, Show | (probe bug, see below) |
| 5 hands | 5 | 66/66 | 5 × last player | 1 (both players read each other) |

Also rerun on this build: `pnpm handflow` 67/67 (real accepted Side Show,
view grant and revoke, a real 25 s turn timeout on the PER clock, the game
replayed by `cf-verify`), `pnpm privacy-suite` 230/230 (G1; grants outside
the game rejected), `pnpm recovery` 20/20 (G3 outage drill).

Per hand, every time:

- `cf-verify`: all checks VALID, including **Game result** (the action log
  replayed on the rebuilt deck gives the recorded winners, payouts and rake).
- Stacks + collected rake = total buy-ins (no lamport created or lost).
- After commit + sync, every `SeatLedger.synced_stack` equals the settled
  stack.
- `next_hand`: button moves to the first dealt seat (5 → 0 → 1 → 2 → 3),
  dealing order rotates with it, `hand_no` + 1.
- No live reader grant before the next hand.

## Timings (dev-machine-1)

| Step | Observed |
| --- | --- |
| `start_hand` → all hands readable (salts, VRF, deal) | 3.6–5.3 s, one 10.9 s |
| `commit_hand` → visible on the base layer | 0.7–1.4 s |
| Whole hand incl. random betting, reveal, verify, sync | 23–56 s |

The betting time is dominated by the probe's random policy (many refused
choices, each a simulation round trip) and by sequential confirmation; it
is not a latency measurement of play.

## Found and fixed during CF-025

- **Side Show viewers carried over to the next hand.** `side_show_viewers`
  was only reset when a later Side Show resolved. It could not be exploited
  (`side_show_view` checks `side_show_hand_no`), but stale state is a trap;
  `next_hand` now clears it (test in `test_table.rs`).
- **Probe bug:** the 3-hand run tried the view grant after the hand ended,
  where the program (correctly) refuses it, and swallowed the error. The
  probe now grants right after an accepted Side Show and checks that both
  players can read each other's hand.

## Not covered on Devnet

- Pot-limit endings (needs ~1,000 boots in the pot; covered in LiteSVM,
  `pot_limit_forces_a_showdown_on_chain`).
- Only one region. Other regions' probes are still open (G3 condition).
- The keeper (who calls VRF request, deal, reveal, timeouts, commit, sync,
  next hand) was the probe itself; a real keeper is P8.
