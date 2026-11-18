# CF-013 findings — recovery when PER is unavailable (P3)

- **Date:** 2026-11-18
- **Policy:** ADR 0004
- **Code:**
  - `configure_table`, `buy_in`, `commit_hand`, `sync_hand` and
    `emergency_refund` in `programs/card-flex`;
  - the `TableVault` and `SeatLedger` accounts;
  - `tests/test_recovery.rs`;
  - `packages/probes/src/recovery.mjs` (`pnpm recovery -- --region <label>`).

## Step 2: money skeleton and recovery logic (LiteSVM, 4 tests)

| Behaviour | Result |
| --- | --- |
| `buy_in` moves exactly the amount into the vault and records `SeatLedger` (payout wallet fixed) | pass |
| Buy-in limits, taken seat, one wallet per table; terms frozen after the first buy-in | rejected as expected |
| `sync_hand` via the **delegated** path checks the delegation record (validator = recorded TEE validator, owner = our program) | pass; a wrong validator or wrong owner is rejected |
| Stale (same) commit | rejected |
| Mid-hand commit (`DEALT`): liveness clock refreshes, stacks **not** copied | pass |
| `emergency_refund` before the timeout, with a wrong payout wallet, or with a seat missing | rejected |
| After the timeout: each seat paid exactly `synced_stack`; vault down by the total; status `REFUNDED` | pass |
| After a refund: second refund and sync of a later commit rejected | pass |
| A recent sync postpones the refund | pass |

## Step 3: Devnet outage drill (`pnpm recovery`, 19/19)

A 3-seat table with real 0.01 SOL buy-ins, delegated to the TEE validator:

1. Ledgers equal the buy-ins; the delegation's validator is recorded in
   `TableConfig`.
2. **Heartbeat:** `commit_hand` in PER reached the base layer in **3.96 s**;
   `sync_hand` accepted it; a replay was rejected.
3. A hand was started, salted, seeded by VRF and **dealt**, then PER went
   silent (no more commits).
4. A refund before the timeout was rejected. **68.6 s after the last sync**
   (timeout 60 s), a **bystander** wallet called `emergency_refund`:
   - each of the 3 wallets received exactly 10,000,000 lamports;
   - the vault paid exactly 30,000,000;
   - status is `REFUNDED`, and a second refund was rejected.
5. **PER came back** and committed. The late commit landed on Solana, but
   `sync_hand` rejected it (table not active), so no money moved. A second
   deal and a new VRF request were both rejected (no redeal).
6. The PER side was then finished, revealed, closed and undelegated.

Regressions after these changes: hand flow 52/52, privacy suite 231/231,
six-player test pass.

## What this shows for G3

- Money is recoverable with **no cooperation** from PER, the operator or the
  backend: a stranger triggered the refund on the base layer alone.
- The refund is exact and covers a hand interrupted mid-play.
- State that arrives after a refund can't move money.
- No hand is dealt twice.

Still to show (step 4): what happens to delegated and ephemeral state when
the validator itself restarts mid-hand ("resume the same hand").
