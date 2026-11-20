# Keeper

The keeper (`services/keeper`) moves every table forward with
permissionless instructions only: start hands, time out absent players,
request VRF, deal, reveal, commit + sync each hand, heartbeat. It never
takes a player's own step and holds no table key. If it stops, games pause
and money is still safe (players can be refunded after the timeout).

## Start

The keeper reads tables with its OWN key (CF-065): no authority credential
leaves the operator machine. Name it once per table (live or not):

```bash
cf-admin table keeper <config> <keeper pubkey>     # reader of the runtime only
```

```bash
export CARDFLEX_KEEPER_KEY=~/.config/cardflex/keeper.json   # fee payer + read key, NOT the table authority
export CARDFLEX_AUTHORITY=<your table authority pubkey>     # drive only your tables
export CARDFLEX_DB=/var/lib/cardflex/hands.sqlite           # optional: index every hand for the API
export HEARTBEAT_SECS=300 STUCK_SECS=120 PER_SOCKETS=16
export HEALTH_PORT=9464                                     # GET /health (CF-060)
pnpm keeper
```

Run it under a supervisor that restarts it (e.g. systemd `Restart=always`):
it logs in to the PER itself and exits after `RELOGIN_DAYS` (20) so the
restart picks up a fresh 30-day token.

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

Automatic: the keeper's own token is renewed by the restart every 20 days.
To cut it off at once (leaked keeper key): `cf-admin table keeper <config>
none` on every table, then name a new key. The keeper key can only read the
runtime (public game state), never cards, salts or the seed; the
privacy checks in `pnpm keeper-drill` and `pnpm multiuser` prove it.

Legacy: `CARDFLEX_PER_TOKEN=$(cf-admin token)` still works (the authority's
read token), but prefer the keeper's own key.

## Commits the table pays for (CF-064)

With the fee vault the table's runtime pays each commit, so the program
pays only for useful ones: the table's NAMED keeper after the state changed
between hands, anyone once 240 s passed since the last paid commit (the
heartbeat is 300 s). A keeper the table didn't name (`cf-admin table
keeper`) gets per-hand commits refused; it warns and `/health` reports it. Anything
else fails with `CommitNotNeeded`; the keeper then just syncs the recent
commit. The table authority may always commit (`cf-admin table close`).

## Health

- Log line per step: `<table> <step>`; failures say `failed (n)` with a
  back-off up to 30 s.
- `GET /health` on `HEALTH_PORT`: 200 when fine, 503 with `reasons` when
  no PER read succeeded for 30 s or a table failed 5 steps in a row;
  `perTable` lists hands, failures and how long since each table moved.
- `cf-admin watch --keeper-url http://host:9464/health --keeper <pubkey>`
  alarms on it (`KEEPER_DOWN`, `KEEPER_UNHEALTHY`, `KEEPER_LOW_FUNDS`), and
  `REFUND_NEAR` is the independent check that syncs are landing.
- "runtime has only N lamports above rent": the table's runtime is close
  to the margin MagicBlock requires of a commit payer and can't be topped
  up while live. Close it between hands (`cf-admin table close`), let
  players cash out, and reopen with `cf-admin table open` (funds a reserve),
  or let the refund path pay players. Always open tables with `table open`.
- Lots of `fetch failed`: the PER may be throttling this IP (CF-054). Lower
  `PER_SOCKETS`, check nothing else on the machine hammers the PER.
