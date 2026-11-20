# Alarms (`cf-admin watch`)

`cf-admin watch` checks every table of one operator (`--authority`, default:
your key) every 60 s, the TEE attestation every 600 s (`--tee-every`), and
with `--keeper-url` / `--keeper` the keeper's health and wallet, and prints alarms; with `--webhook <url>` (or
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
| `TEE_MEASUREMENTS_CHANGED` | critical | (CF-058) The PER's TDX measurements aren't on our pinned list. Players' clients refuse the TEE (`verifyTee`), so play stops. Either MagicBlock released new TEE software, or it's not their machine. | 1. `cf-admin tee` prints the new values. 2. Confirm the release with MagicBlock (announcement or direct answer); never pin values you can't attribute. 3. Add them to `DEVNET_TEE_MEASUREMENTS` (keep the old ones until the rollout ends), release the SDK/web app. 4. If MagicBlock can't confirm: treat as an incident, pause (`cf-admin global set --pause`), don't pin. |
| `TEE_TCB` | critical | (CF-058) Intel says the TEE platform isn't `UpToDate` (advisory ids in the detail). Clients refuse it. | Tell MagicBlock (they patch the host). Don't relax the check. |
| `TEE_QUOTE_REPLAYED` / `TEE_QUOTE_INVALID` | critical | (CF-058) The attestation quote doesn't answer our fresh challenge, or doesn't verify. Possible man-in-the-middle or broken endpoint. | Treat as an incident; check DNS/TLS for the PER endpoint; ask MagicBlock. |
| `TEE_UNREACHABLE` | warning | (CF-058) The attestation check couldn't run (PER or Intel PCCS down). | Retries every `--tee-every` (600 s). If the PER itself is down see [incidents.md](incidents.md#per-outage). |
| `KEEPER_DOWN` | critical | (CF-060) The keeper's `/health` didn't answer. Hands stop between phases; tables get refundable after the timeout. | Restart it ([keeper.md](keeper.md)). |
| `KEEPER_UNHEALTHY` | critical | (CF-060) The keeper runs but can't read the PER for 30 s, or a table keeps failing. | Read `reasons`; a single table failing: `cf-admin table status`, maybe `table repair`; PER reads failing: see the `fetch failed` note in keeper.md. |
| `KEEPER_LOW_FUNDS` | warning | (CF-060) The keeper wallet has < 0.05 SOL. Syncs stop when it's empty. | Top it up (≥ 1 day of budget, keeper.md). |
| `UNREADABLE` | info | A table couldn't be decoded (made by an older program layout). | Ignore for old drill tables. |
| `WATCH_FAILED` | critical | The check itself failed (RPC down?). | Check `CARDFLEX_BASE_RPC`; rerun. |
