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

## Amendment (same day, security review)

- **Validator pinned:** tables may only be delegated to MagicBlock's TEE
  validator (`TEE_VALIDATOR` in `table.rs`); the validator can't change once
  recorded; `sync_hand` trusts committed state only from it. The local
  stack's validator is allowed only in builds with feature `local-stack`.
- **Pull-based refunds:** `emergency_refund` only sets `REFUNDED`; each seat's
  payout is a separate `claim_refund` (anyone may submit it, paid only to
  the recorded wallet, once), so one failing payout can't block the others.
  `min_buy_in` is at least the rent-exempt minimum.

## Amendment (2026-11-19, CF-053): abort a hand whose secret state was lost

Rule 8 left a gap: if PER keeps the delegated runtime but loses the
ephemeral accounts (dealer, seat hands, salts) mid-hand, no instruction
could move the table on (`deal_hand`, `act`/`timeout_turn` and
`reveal_hand` all need them). Worse, heartbeat commits and syncs keep
refreshing the liveness clock, so the refund timeout never fires, and a
leave requested mid-hand waits for a `next_hand` that never comes. Players'
money would stay frozen for as long as anyone kept committing.

- **`abort_lost_hand`** (permissionless, PER): `remaining_accounts` = the
  dealer, then the seat hands, then the salts of the dealt seats in dealing
  order. It succeeds only if at least one of them doesn't exist or has lost
  its tag (zeroed). These
  accounts can't be closed while a hand is in progress (CF-011 freeze), so a
  missing one can only mean lost state. The accounts are private, so an RPC
  reader can't tell "missing" from "hidden"; only the program can, which is
  why the keeper simply tries the instruction once a hand has made no
  progress for `STUCK_SECS` (default 120 s) and treats `NotLost` as "all
  fine".
- **Money:** before settlement nothing moved (boots and bets live in
  `TableRuntime.game` until the hand ends), so the hand is dropped. A hand
  that settled (`HAND_COMPLETE`) but can no longer be revealed would be an
  unverifiable result, so it is **voided**: each dealt seat gets back
  `stack + contributed − payout` (its stack at the start of the hand) and
  the hand's rake is subtracted from `rake_owed`, checked for conservation.
  Safe because `sync_hand` copies stacks and rake only between hands, so
  nothing was ever paid from that result.
- **Afterwards:** counted in `cancelled_hands` (selective-abort monitoring),
  `hand_no` moves on (late actions or callbacks can't match), pending leaves
  are applied, the table is IDLE with the same button. No redeal. The
  operator re-creates the lost accounts with `open_dealer` /
  `open_seat_hand` / `open_salt`; a re-created seat hand has its owner as
  the only reader, so `open_seat_hand` also clears that seat's Side Show
  grant bit (otherwise `start_hand` would refuse forever). Until then
  players can leave and cash out as usual.
- **Trust:** only the TEE operator can make ephemeral state disappear, so
  this adds no new power to players or to the table authority. An operator
  that deletes state to void hands it dislikes is the selective-abort risk
  already on the risk list; it shows as a rising `cancelled_hands`
  (alerting: CF-060).
- **Not verified on Devnet yet:** LiteSVM tests cover every phase and the
  reversal; that PER accepts a transaction naming a missing ephemeral
  account needs a Devnet drill after the next deploy.

## Amendment (2026-11-19, CF-056): production refund timeout and heartbeat

- **Refund timeout 1,800 s** for production tables (`cf-admin table create`
  default; the program still allows 60–86,400 s). A refund that fires is
  safe for players (each gets their last synced stack, the interrupted
  hand's bets come back), so a shorter timeout favours them: after a PER
  outage they wait at most 30 minutes.
- **Keeper heartbeat 300 s in every phase.** Before CF-056 the keeper
  heartbeated only between hands. A hand can last longer than the timeout
  (pot limit 1,024 boots at up to 25 s per turn), so a table could become
  refundable mid-hand and anyone could void that hand, e.g. players stalling
  a hand they were losing. A mid-hand `sync_hand` refreshes the clock and
  copies no stacks (rule 4), so heartbeating during hands is safe.
- Alarms (`cf-admin watch`): `REFUND_NEAR` at half the timeout, `REFUND_DUE`
  at the timeout, live tables only. Runbooks: `docs/runbooks/`.
