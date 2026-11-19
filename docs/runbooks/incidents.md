# Incidents

Background: money lives only in the table vault on Solana; the PER holds
game state. Players can always get their last synced stack back without the
PER, the operator or the backend (ADR 0004). Nothing below needs a player's
key, and nothing can pay anyone but a seat's recorded wallet.

## PER outage

**You see:** keeper logs `fetch failed` / timeouts for PER; `REFUND_NEAR`,
then `REFUND_DUE`; players can't act.

1. Check whether it's us or them: `curl` a `getSlot` to
   `https://devnet-tee.magicblock.app` from another network. One IP being
   throttled (CF-054) looks like an outage; another machine will answer.
2. If MagicBlock is down: post in their Discord with the time and
   endpoint. Keep the keeper running; when PER returns, play continues from
   the same phase (nothing is redealt).
3. If it stays down past the refund timeout (30 min in production), anyone
   (us, a player, a bot) calls `emergency_refund` per table, then
   `claim_refund` per seat. Each seat gets its last synced stack; bets of the
   interrupted hand are returned because that hand was never synced. The
   table never resumes (ADR 0004 rule 6). Tell players their money is back.
4. Don't create new tables until the PER is healthy (`cf-admin global set
   --pause` if needed; withdrawals keep working).

## Stuck hand

**You see:** a table in the same phase for minutes; `cf-admin table status`
shows no change.

- Every phase can be moved on by anyone, and the keeper does it: salt
  timeout (30 s) → `cancel_salts`; VRF timeout → `cancel_hand`; slow player
  (25 s) → `timeout_turn`. If none of these fires, the keeper is down or
  throttled: see [keeper.md](keeper.md).
- If the hand's secret accounts are gone (next section), the keeper calls
  `abort_lost_hand` after `STUCK_SECS` (120 s); look for "aborted: its secret
  state was lost" in its log.

## Lost secret state

**You see:** keeper log "hand #N aborted: its secret state was lost";
`cancelled_hands` went up; the next hand doesn't start (salt submissions or
the deal fail).

`abort_lost_hand` already ended the hand without moving money wrongly
(stacks back to the start of the hand). The lost accounts must be
re-created before the next hand:

```bash
cf-admin table repair <config>
```

It tries to re-create the dealer, every seat hand and every salt; ones that
still exist are left alone ("exists"). Any `FAILED` line: rerun. Then the
keeper starts the next hand by itself. If it happens again, record it and
tell MagicBlock (it means the TEE lost state; ADR 0004 amendment, CF-053).

## Vault mismatch

See `VAULT_SHORT` in [alarms.md](alarms.md). Pause first; withdrawals keep
working while paused, so pausing never traps players.

## Players can't cash out

`cash_out` needs the leave to be synced: `leave_seat` → (hand ends,
`next_hand`) → `commit_hand` + `sync_hand` → ledger `left` → `cash_out`. The
keeper syncs departed seats by itself. If it's down, anyone can do the
commit + sync by hand (`cf-admin table status` shows the phase); then
`cash_out` (permissionless, pays the recorded wallet).

## Keys

- A leaked **keeper PER token** reads only public game state (never cards,
  salts or seeds). Rotate it ([keeper.md](keeper.md#token-rotation)).
- A leaked **keeper fee key** can spend only the keeper's SOL. Move the SOL,
  make a new key, restart the keeper.
- A leaked **table authority** key can close or open secret accounts between
  hands (aborting hands, no money moved) and close its tables; it can't move
  player funds. Close its tables (`cf-admin table close`), players cash out.
- A leaked **upgrade authority** can replace the program: the worst case.
  It must be a multisig before public Devnet ([multisig.md](multisig.md)).
