# ADR 0004 — Recovery policy when PER is unavailable

- **Status:** Accepted
- **Date:** 2026-11-18
- **Ticket:** CF-013 (P3, gate G3)
- **Builds on:** ADR 0002 (account lifecycle; money only on the base layer)

## Problem

The game runs inside MagicBlock's PER. If PER stops answering, crashes or
loses state, players must never lose money and the operator must never be
able to choose a better outcome. The rule from the PRD stays: **resume the
same hand or refund exactly; never redeal.**

## What the base layer can know

- `TableConfig`, `TableVault` and `SeatLedger` are never delegated; they
  always work.
- `TableRuntime` and `HandLog` are delegated. On the base layer we only see
  what PER last **committed**. A commit is done by the delegation program
  on the validator's behalf; our program can't refuse it (ADR 0002).
- The delegation record (`PDA["delegation", account]` under the delegation
  program) tells us the validator (`authority`) and the owner program. Base
  instructions check it before trusting a committed copy.

## Decisions

1. **Money lives only in `TableVault`** (base, program-owned, never
   delegated). Buy-ins go there. P3 implements `buy_in`; cash-out and rake
   come in P6.
2. **`SeatLedger.synced_stack`** is the only amount the base layer will ever
   pay out. It changes only through `sync_hand`.
3. **`commit_hand`** (PER, anyone may call it) bumps `TableRuntime.commit_seq`
   and commits `TableRuntime` and `HandLog` without undelegating. A keeper
   calls it after each hand and as a heartbeat while idle.
4. **`sync_hand`** (base, anyone may call it) reads the committed
   `TableRuntime` and accepts it only if:
   - it is the table's runtime PDA;
   - it is delegated to the validator recorded in `TableConfig`, by our
     program (checked via the delegation record), or it is back under our
     program;
   - `commit_seq` is greater than the last synced one;
   - the table status is `ACTIVE`.

   It always refreshes the **liveness clock** (`last_sync_time`). It copies
   stacks into the seat ledgers **only between hands** (committed phase
   `IDLE`, `REVEALED` or `POC_DONE`), so bets of an unfinished hand never
   become payable.
5. **`emergency_refund`** (base, anyone may call it) needs status `ACTIVE`
   and `now ≥ last_sync_time + refund_timeout_secs`.
   - It pays every seated ledger its `synced_stack` from the vault to the
     wallet recorded at buy-in.
   - It sets status `REFUNDED`.
   - The interrupted hand was never synced, so its bets are returned
     automatically.
6. **After a refund,** `sync_hand` and `buy_in` fail on status. A late commit
   can still land on the delegated copy, but no instruction pays from it.
   The table never resumes.
7. **`refund_timeout_secs`** is set per table at creation, bounded to
   60–86,400 s. 60 s exists only so Devnet drills are practical. A
   production value comes with P8 and the keeper design.
8. **Resume after a PER restart:** if PER comes back with the same delegated
   and ephemeral state, play continues from the same phase; nothing is
   redealt (one shuffle per `hand_ctx`, CF-011). If ephemeral state is lost
   but the runtime survived mid-hand, the hand can't continue. It waits for
   the refund timeout (P5 adds an explicit abort path that returns boots
   and is counted like `cancel_hand`).

## What G3 must show (PRD §13.6)

- After a PER outage the same state resumes, **or** every seat is refunded
  exactly its last synced stack.
- No hand is dealt twice.
- Commits after a refund can't move money.
- Money is recoverable without any cooperation from PER, the operator or
  the backend.

## Trade-offs

- An idle but healthy table becomes refundable if nobody commits for
  `refund_timeout_secs`. The keeper heartbeat prevents this, and a refund
  only returns players' own stacks, so the worst case is an inconvenience.
- The liveness clock trusts that a commit means PER is alive. A validator
  that commits but never runs hands would keep the table open; the players'
  defence is leaving (P6 cash-out). Recorded for P8 review.
