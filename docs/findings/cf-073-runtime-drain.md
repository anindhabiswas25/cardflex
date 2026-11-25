# CF-073: why table runtimes drained (Devnet, 2026-11-24)

## Symptom

The three lobby tables (Amethyst Hall `7qcinEeQ`, Emerald Court `EfMDxq9Q`,
Ruby Throne `AciNdk4G`) failed every `commit_hand` with
`InsufficientFundsForRent` from 2026-11-23; the keeper's `/health` was 503.
Earlier (CF-070) one table had "lost ~4M lamports in an hour, cause unknown".

## Method

Read every transaction touching each runtime in the PER (keeper read key):
~4,600 transactions, runtime lamport change per transaction, instruction
decoded from its discriminator (program logs are hidden in PER).

## Result

Only `commit_hand` ever took lamports from a runtime.

| Table | Successful commits | Free | Paid (2,000,000 each) | Failed afterwards |
|---|---|---|---|---|
| Amethyst Hall | 50 | 25 | 25 (0.05 SOL, the whole reserve) | 1,276 |
| Emerald Court | 27 | 25 | 2 | 1,594 |
| Ruby Throne | 27 | 25 | 2 | 1,601 |

- The first 25 commits after a delegation cost the runtime nothing; from
  #26 each one moves exactly 2,000,000 lamports to MagicBlock's magic fee
  vault (`EUJssY…`). The transactions are otherwise identical, and the
  switch happened at #26 on every table at different times (a per-table
  count, not a date). Re-delegating (close + open) resets the count: the
  first commit after reopening cost 0.
- The keeper heartbeated every 300 s in IDLE, also with nobody seated:
  12 commits/h, so ~2 h free, then 0.024 SOL/h. All three tables were empty.
- Emerald Court and Ruby Throne were opened before the 0.05 SOL reserve
  existed (~5M above rent): two paid commits left ~1.01M, under the 2M a
  commit needs. The CF-070 "unexplained ~4M" was two paid commits.
- A commit needs ≥ 2,000,000 lamports above rent, not ~15,000 (old
  `/health` text).

## Changes (CF-073)

ADR 0004 amendment: no idle heartbeat on a table without a ledger; the
program refuses `emergency_refund` there and restarts the refund clock at
the first buy-in; watch alarms and headroom threshold adjusted.

## Cost implication (open)

At 0.002 SOL per commit and one commit per hand, a hand costs the operator
0.002 SOL once a table's free commits are used. On a 0.0005 SOL-boot table
that is more than the rake of most pots. Ask MagicBlock: is this the intended
price, is there a cheaper commit (batching, fewer accounts), and is the
free count per delegation by design?

## Refuel procedure that worked

`cf-admin table close` (its commit fails on a drained runtime; the
undelegate still lands), `cf-admin table open` (delegates + 0.05 SOL; its
first PER step fails with `InvalidAccountData` because the runtime and
hand-log permissions survive in PER), then `cf-admin table repair`
(re-creates dealer, seat hands, salts).
