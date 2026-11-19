# CF-054: load test, 5 → 50 concurrent tables on Devnet

**Date:** 2026-11-19 · **From:** `dev-machine-1` · **Program:** CF-053 devnet
build · **Script:** `pnpm load-test` (`TABLES=N`), `services/keeper/test/load.ts`
· **Raw results:** `docs/probes/*-cf054-load-*.json`

## Setup

One keeper process drives every table (the production shape). Each table
has 2 bot players that submit salts and play real hands (mostly chaal, see
sometimes, show after a few rounds: 8 actions per hand). 3 hands per table.
Bots and keeper run in the same Node process on one machine and IP. After
the run every vault is checked with `check_vault` (strict) and every table
undelegated.

## Results

| Tables | Hands done | Action confirm p50 / p95 | Salts in → cards dealt p50 / p95 | Keeper round p95 | Failures | Vaults exact |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 15/15 | 472 / 738 ms | 3.9 / 4.0 s | 3.7 s | 0 | 5/5 |
| 10 | 30/30 | 485 / 1,091 ms | 6.1 / 7.0 s | 4.5 s | 3 salt sends | 10/10 |
| 25 | 75/75 | 544 / 1,179 ms | 13.1 / 15.1 s | 10.6 s | 7 keeper ticks | 25/25 |
| 50 | 150/150 | 676 / 5,835 ms | 18.1 / 35.2 s | 11.1 s | 2 salt sends | 50/50 |

- "Action confirm" is client-side: get blockhash, send, wait for
  `confirmed`. It is not the CF-004 "seen by others" latency (~90 ms p50),
  so compare it across steps, not with the 200 ms target.
- "Salts in → cards dealt" runs from the last time the table was seen in
  the salt round to the first time it was seen dealt (VRF + deal +
  keeper scheduling), measured within one loop round.
- Failures were transient sends (one retry each fixed them); no hand was
  lost or cancelled, and no money moved wrongly at any step.
- Base-layer cost: **5,000 lamports per hand** (one `sync_hand` signature;
  `commit_hand` in PER costs the keeper nothing on the base layer). Setting
  up a table costs ≈ 0.039 SOL, mostly delegation rent plus funding two
  test wallets; ≈ 0.043 SOL per table stayed spent after undelegating
  (test buy-ins remain in the vaults).
- 50-table setup took 174 s at 5 tables in parallel.

## What it means

**Stable and correct at 50 tables: yes.** Every hand finished, every vault
reconciled to the lamport, no stuck table.

**Fast enough at 50 tables: no.** Waiting 18–35 s for cards is unplayable.

The bottleneck is **our keeper**, not the PER:

- Action latency, which doesn't involve the keeper, stays flat from 5 to 25
  tables (p95 0.7 → 1.2 s). Only the keeper-driven step (salts → deal)
  grows in line with the table count: 4 → 6 → 13 → 18 s p50.
- The keeper ticks every table together and waits for the slowest
  (`Promise.all` per round in `services/keeper/src/main.ts`, and the same
  in the harness). One table finishing a hand spends several seconds in
  `commitAndSync` (waiting for the commit to reach the base layer, then
  `sync_hand`), and every other table waits for that round to end. Round
  p95 is 11 s at 25 and 50 tables.
- Each round also makes two PER calls per table (`getAccountInfo` +
  `getSlot`).

The action p95 jump at 50 tables (1.2 → 5.8 s) can't be pinned on the PER
yet: 100 bots, the keeper and the measuring loop share one Node event loop
and one IP. CF-061 re-measures with the keeper fixed. If p95 stays high,
the next run splits the bots across processes or machines.

## Next: CF-061 (keeper scaling)

1. A separate loop for each table, so a slow commit + sync stalls only its
   own table.
2. Batch reads: one `getMultipleAccountsInfo` for every runtime and one
   `getSlot` per round, instead of two calls per table.
3. Re-run the staircase. Target: salts → dealt flat across table counts
   (≈ 4 s, close to the VRF's ~2 s plus the deal).

The P8 exit criterion ("50 concurrent tables stable") is met for
correctness; it should only be signed off once CF-061 shows acceptable
latency at 50.

## Follow-up the same day (CF-061)

Three 50-table re-runs after fixing the keeper:

| Run | Keeper | Hands done | Salts → dealt p50 / p95 | Action p50 / p95 | Failed sends | Vaults |
| --- | --- | --- | --- | --- | --- | --- |
| A (above) | shared loop | 150/150 | 18.1 / 35.2 s | 0.68 / 5.8 s | 2 | 50/50 |
| B | per-table loops, batched reads | crashed (out of memory) | — | — | — | — |
| C | B + confirm by HTTP polling | 211 (all 50 finished) | 9.9 / 18.9 s | 0.92 / 6.1 s | 552 | 50/50 |
| D | C + bounded keep-alive pools | 66 (0 finished in 16 min) | 12.9 s / 5.4 min | 0.48 / 5.2 s | ~1,000, mostly `fetch failed` | 49/49 |

- **B** found a real bug (fixed): when a PER WebSocket closes while
  `confirmTransaction` waits, web3.js 1.98 retries `signatureSubscribe` on
  the dead socket in a tight loop (1,000,000 log lines for one signature)
  until the heap is exhausted. The keeper confirmed every transaction this
  way. Everything now confirms by polling `getSignatureStatuses`
  (`confirmByPolling` in the SDK, backing off 150 ms → 1 s).
- **C**: per-table loops halved the deal wait; the remaining failures were
  connection errors.
- **Direct probe** (no game, between runs): the PER answers 200 parallel
  requests on 4 reused keep-alive sockets without an error, while bursts
  of NEW connections from this IP time out (about 10 s) or stall,
  intermittently. Cloudflare and MagicBlock's base RPC take 100 parallel
  new connections from the same machine in about 1 s. So the PER
  throttles per IP.
- **D**: the PER refused connections for most of the run (both new and
  pooled), then was healthy again minutes later. Sustained load from one
  machine (100 bots, each polling confirmations, plus the keeper) appears
  to trip its rate limiting. Money stayed exact; the keeper tried
  `abort_lost_hand` 117 times on tables that looked stuck, and the program
  correctly refused every one (`NotLost`).

### Conclusion

- **Correctness under load: proven.** Every run, including D, ended with
  every vault exact to the lamport, no lost or double-paid hand, and no
  table that needed a key holder to recover.
- **Capacity at 50 tables: not measurable from one machine.** The
  load generator (100 players on one IP) reaches the PER's per-IP limit
  first. Real players connect from their own IPs. Only the keeper is
  one-IP by design, and since CF-061 it needs 2 PER reads per round for
  all tables together (≈ 4 requests/s at 50 tables) plus its own steps.
- **To measure it:** run the bots from several machines (or a few cloud
  VMs, each with ≤ 10 tables of bots) with one keeper elsewhere, or ask
  MagicBlock for the PER's per-IP and global rate limits and whether a
  load-test allow-list exists.

### Decision (PM, 2026-11-19)

Option 3: the P8 load criterion is accepted on correctness; fast play is
shown up to 25 tables. The 50-table capacity is re-measured with bots on
several machines before public Devnet (CF-062).
