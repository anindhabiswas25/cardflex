# CF-004 findings — Devnet round trip on MagicBlock PER

- **Date:** 2026-11-18
- **Status:** Done from `dev-machine-1`. The round trip works end to end.
  Write latency meets the target at p50 but not at p95.
- **Raw data:** `docs/probes/*cf004*.json` (the first four runs predate the
  `--target` option and are all `tee`)
- **Script:** `packages/probes/src/roundtrip.mjs` (`pnpm roundtrip -- --region <label> [--target tee|er-as] [--writes N]`)

## What runs

1. **Base layer:** fund a fresh per-run authority (it plays the role of a
   per-seat session key), call `probe_init`, then `probe_delegate` to the
   TEE validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`.
2. **PER:** get an auth token for the authority, wait until the account
   appears, then `probe_make_private` (ephemeral permission, `is_private`,
   one member = authority with TX_LOGS | TX_MESSAGE | TX_BALANCES).
3. **PER:** N × `probe_write(u64)`. The run measures the send RPC, the time
   to confirmation, and the time until a WebSocket subscriber sees the new
   value (what other players see).
4. **Privacy smoke check:** read the account with the owner's token, a
   stranger's token and no token.
5. **PER:** `probe_commit` and wait until the base layer shows the last
   value. Then `probe_undelegate` and wait until the program owns the
   account on the base layer again.

## Deployment

| Item | Value |
| --- | --- |
| Program | `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL` (devnet) |
| Size | 318,544 bytes; rent 1.62 SOL |
| Upgrade authority (temporary) | `Cf3ux3ZqSfYutZyxLeEWLeNkpUkPBMneyU3VUwEUww8x`, devnet deployer. Moves to a Squads multisig before public Devnet |
| Deploy signature | `4GpR17cqFxtjb2U4Rt7LMCytNkSzV6dD7BfDC2gFxGHttvmkmDy2aXG7oQLgrzxUFvCbTKP21wUaJmYSK6YPLCLy` |
| Devnet SOL | `https://rpc.magicblock.app/devnet` gave airdrops when `api.devnet.solana.com` was rate-limited |

## Results — `dev-machine-1`

Two clean PER runs of 100 writes each (blockhash cached and refreshed every
20 writes, as a real client would):

| Measure | PER run A | PER run B | Target (PRD §30) |
| --- | --- | --- | --- |
| Write seen by other players, p50 | 85.5 ms | 91.9 ms | < 200 ms ✔ |
| Write seen by other players, p95 | 435.8 ms | 517.7 ms | < 250 ms ✘ |
| Writes over 200 ms after warm-up | ~25% | 14 of 95 (15%) | — |
| Send RPC p50 | 90.8 ms | 91.2 ms | — |
| Write confirmed (sender), p50 | 226.2 ms | 176.9 ms | — |
| Delegation visible in PER | 111 ms | 111 ms | — |
| Commit → value on base layer | 11.6 s | 1.1 s | off the hot path |
| Undelegate → owned on base layer | 355 ms | 188 ms | — |
| Privacy smoke check | owner reads; stranger token and no token denied | same | — |

Patterns:

- **Warm-up stall.** The first 1–3 writes after the account went private
  took 0.6–10 s. All later writes sent in about 90 ms.
- **Steady-state tail.** About 15–25% of writes take 250–400 ms, sometimes
  about 1 s. The other players' delay matches the sender's send-RPC time,
  so the time is lost at ingress, before execution.
- **Commit time to the base layer varies widely** (0.8–11.6 s across runs).
  The game must never wait for a base-layer commit between hands (PRD §16
  already says commits are asynchronous).
- **First attempt of one run failed** with `fetch failed` while logging in
  to PER. A retry a minute later worked. Its probe account is still delegated
  on devnet (harmless).

## Baseline: public ER (`devnet-as`), same script, `--target er-as`

| Measure | Public ER Asia |
| --- | --- |
| Write seen by others, p50 | 92.5 ms |
| Write seen by others, p95 | 1,891.7 ms |
| Writes over 200 ms | 27 of 94 (29%) |
| Failures | 1 `fetch failed` |
| Delegation visible | 5.3 s |

The public ER has the **same p50 and a worse tail**. The PER's privacy layer
does not cause the latency tail; it looks like shared Devnet load. That is an
inference from one location on one day.

## What this means

1. **The core MagicBlock flow works on Devnet:** delegate to the TEE
   validator, create a private permission, write, commit and undelegate.
2. **The p50 latency target is met with room to spare** (about 90 ms from
   this location, against a 200 ms target).
3. **The p95 target is at risk.** This goes on the delivery-plan risk list.
   Next steps:
   - measure from the other target regions (CF-003);
   - ask MagicBlock whether Devnet ingress queueing is expected, and what
     latency Mainnet PER gives;
   - retest during P8 load testing;
   - the UI must handle a 0.5–1 s confirmation without looking broken: show
     the action as pending, and let the timer pause visually.
4. **Warm-up:** send one no-op write right after sit-down, before the first
   real action, so a player's first chaal doesn't hit the stall.
5. **Retries:** clients must retry PER RPC calls (with the same signed
   transaction, so a retry can't double-apply) on transient `fetch failed`.

## Permission flag values (from SDK 0.17.3 source)

`AUTHORITY = 1`, `TX_LOGS = 2`, `TX_BALANCES = 4`, `TX_MESSAGE = 8`,
`ACCOUNT_SIGNATURES = 16` (bit flags in one byte). This answers the
"numeric flag values" gap from the research.
