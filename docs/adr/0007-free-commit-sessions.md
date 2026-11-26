# ADR 0007 — Free-commit sessions

- **Status:** Accepted (CF-084)
- **Date:** 2026-11-25
- **Amends:** ADR 0002 (account lifecycle: tables are closed and reopened
  during normal operation), ADR 0004 (heartbeat rate, who may commit),
  ADR 0005 (players are seated out at a session's end)

## Context

Every `commit_hand` copies the runtime and the hand log from the PER to
Solana. MagicBlock's published prices (fees-and-commit-economics, checked
2026-11-19) and our own measurements (CF-057, CF-073):

- Commits 1–25 of a delegation have no live fee. From commit 26 every commit
  costs 1,000,000 lamports **per committed account**; we commit two, so
  2,000,000 lamports (measured exactly in CF-073).
- At undelegation MagicBlock takes a session fee (3,000,000 lamports) plus
  1,000,000 per commit after the first from the delegation deposit, **capped at
  the deposit** (no debt). We forfeit about 6,300,000 lamports per
  open + close (two delegated accounts).
- The runtime can't be refunded while delegated (base transfers don't reach
  the PER), which made tables drain and stall (CF-073, and Amethyst Hall
  again on 2026-11-25).

With one commit per hand, paid commits cost about 4 boots per hand on a
0.0005 SOL table: far more than its rake. Using only the free commits, a
session costs one forfeited deposit (~0.0063 SOL) for ~20 hands, which the
rake covers.

## Decision

1. **A table plays in sessions.** A session is one delegation. The program
   counts its commits: `TableRuntime.session_base_seq` (appended, CF-084) is
   set to `commit_seq` by `undelegate_table` and by `migrate_runtime`;
   `commit_seq - session_base_seq` = commits this session. Only
   `commit_hand` and `undelegate_table` commit, and both bump `commit_seq`,
   so this matches MagicBlock's count.
2. **Budget** (`FREE_COMMITS = 25`): `start_hand` refuses once 23 commits are
   used (`SESSION_HAND_COMMITS`, error `SessionOver`). The last two are for
   the session's end: one commit carrying every leave, then the close.
   `commit_hand` refuses past 24 (`FreeCommitsUsed`), except for the table
   authority, and for the named keeper once everyone has left between hands
   (that commit only carries final stacks: payouts are never blocked).
3. **`end_session`** (new, permissionless, IDLE only, budget used): every
   seated player leaves at once. Payout is the existing path (commit +
   `sync_hand` + `cash_out`).
4. **Recycling:** once a session is over and everyone has been synced, the
   table is closed (`undelegate_table`: one commit, no `commit_hand` before it
   any more) and opened again (delegate + PER setup, the existing `table open`
   + `table repair` steps). That is `cf-admin table recycle`, and the keeper
   does it itself when it holds the table authority.
5. **Operator key (model A).** New tables are created with a dedicated
   operator key as authority, kept on the keeper machine
   (`CARDFLEX_OPERATOR_KEY`), never the program's upgrade authority. The
   table authority can configure an empty table, open/close/repair it, name
   the keeper and revoke card views; **no instruction lets it move players'
   money** (cash-out pays only the recorded wallet; rake goes only to the
   global treasury). A leaked operator key can disrupt tables, not take funds.
6. **Commit rate:** strangers may commit only after
   `STRANGER_COMMIT_GAP_SECS` (1,200 s) without a commit (the refund safety net
   for a dead keeper; refund timeout 1,800 s), with or without the fee vault.
   The keeper keeps `COMMIT_MIN_GAP_SECS` (240 s) and its "state changed"
   shortcut. The keeper's heartbeat goes from 300 s to 900 s and stops in a
   session's last commits.
7. **Rake pays the fees.** Rake builds up in each vault and is swept to the
   global treasury (a dedicated wallet, not the deployer), which funds the
   operator key's deposits. Proposed settings: rake 10% with a per-hand cap of
   0.0005 SOL on every board (~1.8× the cost per hand). The operator does not
   intend to profit from rake; a growing surplus means the cap can come down.

## Consequences

- Players are seated out about every 20 hands (30–45 minutes of six-player
  play) and need one wallet signature to sit down again. The app explains it
  (session countdown, "Session ended" summary with "Play again").
- A table is unavailable for the recycle (close → reopen, not measured yet;
  expected 30–60 s). The lobby shows "New session starting…".
- Every hand is still committed to Solana, and an emergency refund still
  loses at most the current hand: no feature is cut.
- The cost depends on MagicBlock keeping the free tier and the deposit cap.
  If either changes, revisit (commit less, or pay commits with top-ups via
  `lamportsDelegatedTransferIx`).
- Drills that play more than 23 hands on one table now need a recycle in
  between.
- The treasury must exist (rent-exempt) before the first `sweep_rake`: a
  small sweep into an empty wallet fails (found 2026-11-26, money drill).
- Open with MagicBlock: is recycling every ~25 commits acceptable; does the
  close count as one of the 25; Mainnet prices.
