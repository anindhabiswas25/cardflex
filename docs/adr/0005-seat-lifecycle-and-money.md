# ADR 0005 — Seat lifecycle and money while a table is live

- **Status:** Accepted (P6). Join in PER depends on reading a base-layer
  account from PER, to be proven on Devnet in CF-035.
- **Date:** 2026-11-19
- **Tickets:** CF-030 … CF-035
- **Builds on:** ADR 0002 (account lifecycle), ADR 0004 (recovery: money only
  in `TableVault`, only `SeatLedger.synced_stack` is ever paid)
- **Amends:** PRD v1.2 §10.5–10.6, §15.2

## Problem

Until P5 a table had a fixed set of players: `buy_in` wrote the seat straight
into `TableRuntime`, which only works before the runtime is delegated. A real
table needs players to join, leave and cash out while it is live in PER,
and rake has to reach the treasury. The base layer only sees what PER
commits, so it must decide from committed state alone:

- when a seat's money may be paid out, and how much;
- that an old occupant's stack is never paid to, or credited to, the next
  occupant of the same seat;
- that nothing is paid twice.

## Decisions

1. **Seat epochs.** `TableRuntime.seat_epoch[s]` (u32) counts sit-downs at
   seat `s`. Every `SeatLedger` carries the `epoch` it was created for
   (`TableConfig.next_epoch[s]`, bumped by each `buy_in`). A committed stack
   is copied into a ledger **only if their epochs match**. This is what
   keeps two occupants of one seat apart.
2. **Buy-in has two steps.** `buy_in` (base, wallet signs) moves lamports to
   the vault and creates the ledger with `synced_stack = buy_in`, the payout
   wallet and the chosen session key. It never touches `TableRuntime`.
   `join_seat` (permissionless, base before delegation or PER after) copies
   the ledger into the runtime when its epoch is **greater than**
   `seat_epoch[s]`, it is unsynced (`synced_stack == buy_in > 0`, so a
   refunded, zeroed ledger can't join) and the seat is free; it also gives the session key
   its read access (seat hand permission, runtime members). In PER the
   ledger is a read-only clone of the base account (MagicBlock clones
   non-delegated accounts); the program checks its address, owner and tag.
   A join takes effect between hands only (`IDLE`).
3. **Leaving.** `leave_seat` (in PER, the seat's session key or wallet
   signs) marks the seat as leaving. Between hands it is applied at once;
   during a hand the player keeps playing (or packs) and it is applied by
   `next_hand`. Applying it clears the seat from `occupied`, sets
   `departed[s]`, removes the session key from both permissions and keeps
   the final stack in `stacks[s]`. A departed seat is never dealt.
4. **Cash-out.** `sync_hand` (unchanged trust rules, ADR 0004) also copies
   `departed` into a matching-epoch ledger (`left = true`). `cash_out`
   (base, anyone may submit) pays a ledger with `left` its `synced_stack`
   to the recorded wallet, closes the ledger (rent to the wallet) and clears
   the seat's `seated` bit. The ledger is closed, so it can't be paid twice;
   a new sit-down creates a new ledger with a new epoch.
5. **A free seat.** A departed seat can be joined again only when the next
   epoch's ledger exists, which requires the old ledger to be closed, which
   requires the cash-out. So the old stack is always paid before a new
   occupant appears.
6. **Rake.** `act` accrues rake in `TableRuntime.rake_owed` (P5).
   `sync_hand` copies it to `TableConfig.synced_rake` between hands.
   `sweep_rake` (base, permissionless) pays `synced_rake − rake_swept` from
   the vault to `GlobalConfig.treasury`. Rake moves only from committed,
   synced results.
7. **GlobalConfig** (base PDA `["global"]`): authority, treasury,
   `max_rake_bps`, `paused`. `configure_table` enforces `rake_bps ≤
   max_rake_bps` (and the program's hard 10% cap). `paused` blocks new
   tables and new buy-ins; it never blocks cash-out, refunds or sweeping:
   players can always leave.
8. **Vault invariant** (PRD §10.4.1), checked by permissionless
   `check_vault` and by `pnpm reconcile`:

   `vault lamports = rent-exempt minimum + Σ synced_stack (all ledgers) + (synced_rake − rake_swept)`

   It holds exactly after every `buy_in`, `sync_hand`, `cash_out`,
   `sweep_rake`, `claim_refund`, since each moves the same amount on both
   sides. Between syncs the committed runtime may differ from the ledgers;
   that difference is money in play, not in the vault formula.
9. **Refunds** (ADR 0004) are unchanged. `emergency_refund` and
   `claim_refund` pay `synced_stack`; unswept rake stays sweepable.

10. **Cancelling an unjoined buy-in** (`cancel_buy_in`) is signed by the
    recorded wallet and allowed only on a table that was **never**
    delegated (`TableConfig.ever_delegated`). Once PER has run, it may hold
    a clone of the ledger and could seat it after the base account closed;
    so on a live table the way out is join, then leave. A cancelled epoch is
    simply skipped (join accepts any newer epoch).

## Amendment (same day, security review of CF-031)

- First version required `ledger.epoch == seat_epoch + 1`; a cancelled
  buy-in bumped the base counter, so the seat could never be joined again,
  and anyone could cancel. Fixed by decision 2 (`>`) and decision 10.
- First version allowed cancel whenever the runtime was back on the base
  layer; a stale PER clone could then seat refunded money after a
  re-delegation. Fixed by `ever_delegated` and the `synced_stack == buy_in`
  join check.

## Consequences

- A player's money is always on exactly one ledger with one epoch; the
  paths that pay (`cash_out`, `claim_refund`) both zero or close it.
- Cash-out needs a commit and a sync after the leave. Keepers already
  commit and sync after every hand (P5), so the wait is one hand at most,
  or one heartbeat when idle.
- Joining in PER relies on MagicBlock cloning a base account into PER
  correctly and freshly. A stale clone can only delay a join (the epoch
  check fails); it can't move money. To be measured in CF-035.

## Amendment (2026-11-25, CF-076): top-up without leaving the seat

A player whose stack runs low can add chips from their wallet and keep the
seat. Rules v1 are unchanged: chips never enter a hand in progress (no
all-in; a player who can't pay a bet must still pack).

- **`top_up(seat, amount)`** (base, signed by the ledger's wallet): the
  lamports go to the TableVault; the ledger's `buy_in` (now = all deposits
  of this sit-down) and `synced_stack` grow by `amount` at once, so cash-out
  and refunds pay a top-up back even if it never reaches the table. Limits:
  ≥ 1 boot; `synced_stack + amount ≤ max_buy_in`; table ACTIVE, not paused,
  the ledger's current epoch, not left. Refused while the runtime has the
  old layout (`RuntimeNotMigrated`).
- **`TableRuntime.credited[seat]`** (appended; runtime 1,284 → 1,332 bytes):
  how much of the ledger's deposits is in `stacks`. `join_seat` sets it to
  the buy-in.
- **`apply_top_up(seat)`** (PER, permissionless, IDLE only): adds
  `buy_in − credited` to the stack and sets `credited = buy_in`; refused when
  there is nothing to add. A stale PER clone of the ledger can only show
  fewer deposits (they only grow within an epoch), never more. The keeper
  applies top-ups between hands, after seating newcomers, before `start_hand`.
- **`sync_hand`** between hands: `synced_stack = stack + (buy_in − credited)`,
  so a deposit not yet applied is never dropped or counted twice.
- **`migrate_runtime`** takes the ledgers of every bought-in seat (seat
  order) and sets `credited` to each current sit-down's `buy_in` (the table
  is undelegated then, so base ledgers are current).
- Vault identity unchanged: `vault = rent + Σ synced_stack + unswept rake`.

Upgrade order on Devnet: close live tables with the old program, deploy,
`cf-admin table migrate`, `table open`, `table repair`. The new program can't
read a 1,284-byte live runtime, and a live table can't be migrated.

## Amendment (2026-11-25, CF-077): leaving before the cards costs nobody a boot

Boots are collected by `deal_hand`. A player who asked to leave
(`leave_seat`) after `start_hand` but before the deal used to be dealt in
anyway, time out and pack: everyone's boot went into a pot the others won
back minus rake.

- `deal_hand` cancels instead of dealing when any dealt-in seat is
  `leaving`: no boot from anyone, the hand counts in `cancelled_hands`, the
  next hand number, leaves applied (same reset as `cancel_hand`). Nobody has
  seen a card at that point (the deck is derived after the check), so
  leaving can't be used to dodge a bad hand.
- `cancel_salts` no longer waits for the deadline when every seat still
  missing a salt is `leaving`; the keeper sends it at once. The web client
  doesn't submit a salt for a seat that is leaving.
- In the pause between hands (`HAND_GAP_SECS`, keeper 8 s) a leave applies at
  once, so no hand starts with fewer than two players.

## Amendment (2026-11-25, CF-079): five seconds to leave for free

A hand went from `start_hand` to `deal_hand` in under 2 s, too short to leave
before the boot. `deal_hand` now refuses to deal sooner than
`LEAVE_WINDOW_SECS` (5) after the start (start = `salts_deadline -
SALT_SECS`, no new field), unless a dealt-in seat is leaving, in which case
it cancels at once (CF-077). The keeper waits the window (+1 s for clock
differences); the table shows "Cards in Ns · leave now and no boot is
taken". The keeper's pause between hands (`HAND_GAP_SECS`) is now 9 s.

## Amendment (2026-11-25, CF-082): the buy-in cap holds against the live stack

`top_up` can only check the cap against the last SYNCED stack (the base
layer doesn't see the live one), so a player who won since the last sync
could deposit past 200 boots. `apply_top_up` now applies at most
`boot * 200 − stack` (live, in PER) and moves `credited` by that amount only;
the rest stays pending: payable on leaving (`sync_hand` adds `buy_in −
credited`), never playable. Nothing to apply at the cap: `TopUpTooLarge`;
the keeper skips seats at the cap; the app's slider uses the live stack.
