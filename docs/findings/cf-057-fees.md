# CF-057: fee model, and the 10-commit limit

**Date:** 2026-11-19 · **From:** `dev-machine-1` · **Script:** `pnpm --filter
@card-flex/keeper fees` (`services/keeper/test/fees.ts`) · **Raw:**
`docs/probes/*-cf057-fees-*.json`

The script follows one table through the player journey (connect wallet →
buy in → join → play → leave → cash out → operator closes) with a fresh key
per party (operator, keeper, two players), so every base-layer balance
change is exact. It plays 12 hands to get past MagicBlock's "10 commits
without a fee payer".

## Launch blocker found and fixed: tables stopped after 10 hands

**Found:** after exactly 10 commits of a table, every further
`commit_hand` failed in PER with custom error `0xA0000000` (2684354560); 134
failed attempts in one run. Consequences:

- no commit means no `sync_hand`, so players who left could not cash out
  (`NotLeft`);
- the refund clock stopped being refreshed, so 30 minutes later the table
  became refundable and ended;
- `undelegate_table` also commits, so the operator couldn't close it either.

In practice every table would have died after ~10 hands. Earlier drills
never ran more than 10 hands on one table, so nothing had shown it.

**Tried, didn't work:** funding and delegating an escrow ("ephemeral
balance", delegation program instructions 9 and 10) for the keeper and
passing MagicBlock's fee vault. Commits still stopped at 10, and the escrow
was never charged (10,650,240 lamports before and after).

**Fix (works):** `commit_hand` and `undelegate_table` take an optional
`magic_fee_vault` (checked against the TEE validator's
`["magic-fee-vault", validator]` PDA; `BadFeeVault` otherwise). With it the
program makes the table's own **runtime PDA** the payer (it is delegated,
and the program signs with its seeds). Devnet run on the deployed build:
**13 of 13 commits landed**, hands, leaves, cash-outs and the close all
worked, and the runtime's balance in PER did not change (6,980,000 →
6,980,000): **no commit fee is charged on Devnet today**.

The keeper and `cf-admin table close` always pass `magicFeeVault()` (SDK).

## Who pays what (lamports, base layer)

| Step | Player | Operator | Keeper |
| --- | --- | --- | --- |
| create + configure table | | 25,036,320 (config, runtime incl. 7,083,680 for PER secret accounts, hand log, vault rent) | |
| buy in 1,000,000 | 2,300,400 = stake + 1,295,400 ledger rent + 5,000 fee | | |
| join seat | 5,000 | | |
| delegate to the TEE | | 6,345,560 | |
| PER permissions + secret accounts, PER login | 0 | 0 | |
| **each move (salt, bet, see, show, pack, Side Show)** | **0** | | |
| each hand (commit in PER + `sync_hand`) | | | 5,000 |
| leave | 0 | | 5,000 (sync) |
| cash out | receives stack + the full 1,295,400 rent, pays 5,000 | | |
| close + undelegate | | +92,320 back | |

**For a player, a whole session costs 15,000 lamports (0.000015 SOL)** in
fees: buy-in, join, cash-out. The ledger rent comes back in full; every
move inside PER is free (session key, no wallet pop-up, no SOL needed).

**Operator:** ≈ 0.031 SOL per table, almost all rent that stays locked in
the table's accounts (there is no instruction to close a table's accounts
and reclaim it; a small follow-up if tables are created and retired often).

**Keeper:** 5,000 lamports per hand plus one per heartbeat (300 s, only when
no hand committed meanwhile) and per departed seat. A busy table (~1 hand a
minute) ≈ 0.0003 SOL/hour; 50 busy tables ≈ 0.36 SOL/day. Budget ≥ 1 day.

## Open

- **Mainnet commit fees:** Devnet charged the runtime nothing. If MagicBlock
  charges per commit on Mainnet, it comes out of the runtime's balance
  (operator-funded at creation). Ask MagicBlock for the Mainnet fee; add a
  runtime-balance alarm to `cf-admin watch` and a way to top it up before
  Mainnet.
- The 10-commit rule and the error code aren't in MagicBlock's docs we have;
  worth confirming with them that runtime-as-payer is the intended pattern.
