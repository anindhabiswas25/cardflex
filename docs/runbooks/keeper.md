# Keeper

The keeper (`services/keeper`) moves every table forward with
permissionless instructions only: start hands, time out absent players,
request VRF, deal, reveal, commit + sync each hand, heartbeat. It never
takes a player's own step and holds no table key. If it stops, games pause
and money is still safe (players can be refunded after the timeout).

## Start

```bash
export CARDFLEX_PER_TOKEN=$(cf-admin token)          # read token, ~30 days
export CARDFLEX_KEEPER_KEY=~/.config/cardflex/keeper.json   # fee payer, NOT the table authority
export CARDFLEX_AUTHORITY=<your table authority pubkey>     # drive only your tables
export CARDFLEX_DB=/var/lib/cardflex/hands.sqlite           # optional: index every hand for the API
export HEARTBEAT_SECS=300 STUCK_SECS=120 PER_SOCKETS=16
pnpm keeper
```

Run exactly one keeper per authority. Two would race (harmless, but they
waste fees on failed duplicates).

## SOL budget

- Base layer: **5,000 lamports per hand** (one `sync_hand`), plus one sync
  per heartbeat (every 300 s per table, only if no hand committed
  meanwhile) and per departed seat (CF-054, CF-057).
- Commits always pass MagicBlock's fee vault; the table's runtime pays them
  (Devnet charges nothing today). Without the vault a table stops
  committing after 10 hands (CF-057).
- Per table-hour at a busy table (≈ 1 hand/min): 60 × 5,000 ≈ **0.0003 SOL**
  (heartbeats don't fire while hands commit). 50 busy tables ≈ 0.015
  SOL/hour ≈ 0.36 SOL/day. An idle table: 12 heartbeats/hour = 0.00006 SOL.
- Keep ≥ 1 day of budget in the keeper wallet; `REFUND_NEAR` alarms fire if
  it runs dry and syncs stop. Full model: docs/findings/cf-057-fees.md.

## Token rotation

The PER token is a 30-day JWT with no refresh. Every ~3 weeks, and at once
if it might have leaked:

```bash
export CARDFLEX_PER_TOKEN=$(cf-admin token)   # new token
# restart the keeper with it
```

A token can only read; it can't sign. It reads what the table authority
reads: the runtime (public game state), never cards, salts or seeds.

## Health

- Log line per step: `<table> <step>`; failures say `failed (n)` with a
  back-off up to 30 s.
- `cf-admin watch` alarms (`REFUND_NEAR`) are the outside check that the
  keeper is syncing.
- Lots of `fetch failed`: the PER may be throttling this IP (CF-054). Lower
  `PER_SOCKETS`, check nothing else on the machine hammers the PER.
