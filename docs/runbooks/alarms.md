# Alarms (`cf-admin watch`)

`cf-admin watch` checks every table of one operator (`--authority`, default:
your key) every 60 s and prints alarms; with `--webhook <url>` (or
`ALERT_WEBHOOK_URL`) it also POSTs them as JSON
`{ at, authority, alerts: [{ level, code, table, detail }] }`. It is
read-only and needs no key. From cron use `--once`: exit code 2 means at
least one critical alarm.

| Code | Level | Meaning | Do |
| --- | --- | --- | --- |
| `VAULT_SHORT` | critical | The vault holds less than rent + Σ synced stacks + unswept rake. Should be impossible (CF-034 invariant). | 1. `cf-admin global set --pause` (stops new tables and buy-ins; withdrawals keep working). 2. `cf-admin table check <config> --strict` and `pnpm reconcile -- --table <config>` to see every term. 3. Treat as a security incident: stop the keeper for that table, keep all logs, escalate. Don't sweep rake from it. |
| `REFUND_DUE` | critical | A live table hasn't synced for its whole refund timeout. Anyone can now call `emergency_refund`, which ends the table and returns every synced stack. | Usually the keeper is down or can't reach the PER. Restart the keeper ([keeper.md](keeper.md)); a successful sync clears it. If the PER is down, let the refund happen ([incidents.md](incidents.md#per-outage)). |
| `REFUND_NEAR` | warning | Half the refund timeout passed without a sync. | Check the keeper is running and its wallet has SOL. Check `cf-admin table status <config>`. |
| `CLAIMS_PENDING` | warning | The table was refunded and some seats haven't been paid. | `claim_refund` is permissionless: send one per seat (any payer); it pays only the recorded wallet. |
| `CANCEL_RATE` | warning | More than 20% of hands at a table were cancelled (after ≥ 10 hands). | Look at why: absent players (salt timeouts) are normal; aborts after VRF or lost state are not. A pattern of cancels right before showdowns would be the selective-abort risk; record and escalate to MagicBlock. |
| `VAULT_SURPLUS` | warning | The vault holds more than it owes (someone sent lamports straight to it). Harmless; strict checks fail. | Note it. The surplus stays in the vault; it can't be paid out by design. |
| `UNREADABLE` | info | A table couldn't be decoded (made by an older program layout). | Ignore for old drill tables. |
| `WATCH_FAILED` | critical | The check itself failed (RPC down?). | Check `CARDFLEX_BASE_RPC`; rerun. |
