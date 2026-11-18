# CF-035 — Money drill on Devnet (P6 exit)

- **Date:** 2026-11-19 (probe timestamps are UTC)
- **Region:** `dev-machine-1`
- **Program:** `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL` (devnet POC build, 856 KB)
- **Probe:** `pnpm money -- --region <label>` (`packages/probes/src/money.mjs`)
- **Report:** `docs/probes/*-cf035-money-dev-machine-1.json`
- **P6 exit (plan):** vault reconciles to the lamport; no double cash-out. **Met.**

## Result: 53/53 checks passed

Table: 6 seats, boot 25,000, buy-in 1,000,000, rake 2.5% capped at 10,000.

| Step | Vault | Σ synced stacks | Unswept rake | Vault − formula |
| --- | --- | --- | --- | --- |
| setup (4 players) | 4,690,880 | 4,000,000 | 0 | 0 |
| hand 0 synced | 4,690,880 | 3,995,000 | 5,000 | 0 |
| seat 4 bought in, not joined | 5,690,880 | 4,995,000 | 5,000 | 0 |
| hand 1 synced (seat 1 left) | 5,690,880 | 4,988,750 | 11,250 | 0 |
| seat 1 cashed out | 4,790,880 | 4,088,750 | 11,250 | 0 |
| hand 2 synced (new player in seat 1) | 5,790,880 | 5,082,500 | 17,500 | 0 |
| rake swept | 5,773,380 | 5,082,500 | 0 | 0 |

Formula (ADR 0005): vault = rent-exempt minimum (690,880) + Σ synced stacks
+ unswept rake. After every step it held **exactly**, `check_vault(strict)`
passed, and buy-ins = vault − rent + cash-outs + swept rake (no lamport
created or lost).

## What was proven

- **Join while live (the open ADR 0005 assumption):** seat 4 bought in on the
  base layer while the table was delegated; `join_seat` inside PER read the
  base `SeatLedger` (a PER clone) and seated it on the **first attempt,
  ~1.0 s** after the buy-in confirmed. A second join of the same ledger was
  refused. The joined player read its own dealt hand and not others'.
- **Leave mid-hand:** seat 1's leave was flagged during the hand (still
  seated), applied by `next_hand` (departed); cash-out before the sync was
  refused; the sync marked the ledger `left` with the final stack.
- **Cash-out:** to another wallet refused; the vault paid exactly the final
  stack; the wallet got it plus the ledger rent; a second cash-out refused.
- **Seat reuse:** a new player bought seat 1 (epoch 2) and joined in PER;
  the new session reads seat 1's hand, the **old session lost access**.
- **Rake:** 17,500 collected over three hands; the treasury received exactly
  that; a second sweep refused.

Same build: `handflow` 67/67, `privacy-suite` 230/230, `recovery` 20/20,
`game` (3 hands) 39/39.

## Found during the run

- Delegating a table now needs more rent: `TableRuntime` (1.2 KB) and
  `HandLog` (2.6 KB) grew in P5. The probes' table authority was funded with
  0.03 SOL; `delegate_table` failed with "insufficient lamports". Probes now
  fund 0.06 SOL. A real client must budget this (≈ 0.05 SOL per table on top
  of `create_table`).
- The program grew to 856 KB. A deploy needs a temporary buffer as large as
  the program (4.35 SOL of rent, refunded by the upgrade) plus a one-time
  extend (0.67 SOL); the deployer ran short once. `deploy-devnet.sh` hid the
  CLI's real error ("insufficient funds") behind "incomplete; resuming".
  Slimming the program is a P8 item.

## Not covered

- Join of a seat whose PER clone is stale (the guard makes it fail and
  retry; not observed).
- Concurrent leave + emergency refund on Devnet (covered in LiteSVM).
- One region only.
