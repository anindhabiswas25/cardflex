# CF-084: free-commit sessions on Devnet (2026-11-25)

**From:** `dev-machine-1` · **Script:** `pnpm session-drill`
(`services/keeper/test/session-drill.ts`) · **Raw:**
`docs/probes/2026-11-25T19-51-cf084-session-drill-dev-machine-1.log` ·
**Decision:** ADR 0007

Three bot players, a throwaway operator key as table authority, the keeper
with that operator key. Boot 25,000 lamports, rake 10% capped at 0.5 boot.

## Result: PASSED 13/13

| Measured | Value |
|---|---|
| Hands in session 1 | 23 (start_hand refused at 23 commits; 1,135 s with bots, ~49 s per hand) |
| Commits in the session | exactly 25: 23 (hands), 1 (`end_session`'s leaves), 1 (the close) |
| Commit fees paid | **none**: the runtime's PER balance never dropped (19,191,648 lamports throughout) |
| Recycle (close + reopen + PER setup) | **12 s** |
| Operator cost per recycle | **6,359,032 lamports** (~0.0064 SOL): forfeited delegation deposits + Solana fees + a 13,472-lamport runtime top-up |
| Payouts at the session end | all 3 players paid by the keeper (ledgers closed) |
| Session 2 | the free count started at 0 again; the same players bought in again and played 2 hands, no fees |
| Hands | every indexed hand VALID |
| Vault | `check_vault` strict passes after everyone left |

So the plan's assumptions hold on Devnet: MagicBlock counts the close as a
commit (25 = 23 + 1 + 1), re-delegating resets the free count, and a session
costs one forfeited deposit (~0.0064 SOL), about **0.00028 SOL per hand** over
23 hands. A rake cap of 0.0005 SOL per hand covers it ~1.8×.

## Found on the way

- **No RPC timeout** (fixed): web3.js waits forever for an answer. One hung
  request froze the keeper on 2026-11-25 for over 2 h, and the first drill
  run. The SDK now aborts every request after 20 s (`rpcTimeout()` in
  `perConnection`/`baseConnection`, used by the keeper too), and the keeper's
  reader loop has a 15 s deadline.
- **A player out of chips** (decided 2026-11-26): they keep their seat and
  watch; `start_hand` deals only seats that can pay the boot, so with two or
  more others the next hand starts without them, and a top-up (applied by the
  keeper between hands) brings them back. The app now shows it: seat badge
  "no chips", "You're out of chips: you keep your seat and watch", and on a
  table with fewer than two players with chips "Waiting · Seat N out of chips".
  On a 2-player table nothing starts until a top-up, a new player or a leave;
  idle heartbeats (900 s) keep spending free commits, and when the session's
  budget is used `end_session` pays everyone out.
- Drill bots that never pack bust each other in two hands; the drill now buys
  in at 200 boots and tops up short stacks (it exercises CF-076 too).
- A laptop suspend froze one run; the drill is now run under
  `systemd-inhibit` on this machine.
