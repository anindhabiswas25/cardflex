# Runbooks

Operator procedures for Card Flex on Devnet (CF-056). Each one says what
you see, what it means and what to do. The program enforces every money
rule itself: no runbook step can move a player's funds anywhere except to
that player's own recorded wallet.

| Runbook | Use when |
| --- | --- |
| [alarms.md](alarms.md) | `cf-admin watch` raised an alarm |
| [incidents.md](incidents.md) | PER outage, stuck hand, lost secret state, refund, vault mismatch |
| [keeper.md](keeper.md) | running the keeper: start, token rotation, SOL budget |
| [deploy.md](deploy.md) | upgrading the program |
| [multisig.md](multisig.md) | handing program control to a Squads multisig |

## Production values (CF-056)

| Setting | Value | Why |
| --- | --- | --- |
| Refund timeout (`--refund-timeout`, per table) | **1,800 s** | After a PER outage players wait at most 30 min for their money. A refund that fires early is safe (everyone gets their last synced stack), so shorter favours players. |
| Keeper heartbeat (`HEARTBEAT_SECS`) | **300 s** | 6× margin under the refund timeout, in every phase, including long hands. |
| Stuck-hand check (`STUCK_SECS`) | 120 s | Longer than any normal wait (turn 25 s, salts 30 s, VRF timeout). |
| PER sockets (`PER_SOCKETS`) | 16 | The PER throttles new connections per IP (CF-054). |
| Alarm check (`cf-admin watch --every`) | 60 s | Refund warning at half the timeout gives 15 min to react. |

## Commands at a glance

```bash
cf-admin watch                         # alarms, every 60 s (or --once from cron)
cf-admin table status <config>         # one table: phase, stacks, sync age
cf-admin table check <config> --strict # reconcile the vault
cf-admin table repair <config>         # re-create lost secret accounts (after abort_lost_hand)
cf-admin global set --pause            # stop new tables and buy-ins (never withdrawals)
pnpm reconcile -- --table <config> --strict
```

`cf-admin` = `node services/admin/src/cli.ts` (or `pnpm admin -- …`).
