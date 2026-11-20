# P8 close-out: CF-064, CF-065, CF-059, CF-058, CF-060

**Date:** 2026-11-20 · **From:** `dev-machine-1` · **Program:** Devnet
`4XUaBSu…` (devnet test-deck build, byte-verified after each deploy) ·
**Live check:** `pnpm keeper-drill` (`services/keeper/test/drill.ts`)

## CF-064: nobody can drain a table with spam commits

**Problem (CF-057 review):** with MagicBlock's fee vault the table's runtime
PDA pays each `commit_hand`, and `commit_hand` is permissionless. On
Mainnet anyone could have called it in a loop to burn the table's budget.

**Fix:** when the runtime pays (fee vault passed), the commit must be useful:

- the state changed since the last paid commit **and** no hand is running
  (end of hand, a join or a leave), or
- `COMMIT_MIN_GAP_SECS` = 240 s passed since the last paid commit (the
  keeper heartbeat is 300 s, so it always qualifies), or
- the signer is the table authority (`cf-admin table close`).

Otherwise `CommitNotNeeded` (6055). "Changed" = SHA-256 of the runtime
bytes without the commit bookkeeping (`runtime_state_hash`: skips
`commit_seq` and the new tail fields). New `TableRuntime` tail fields:
`last_paid_commit` (i64) and `paid_commit_hash` ([u8; 32]) at bytes
1212–1251; earlier offsets unchanged. A spammer now gets at most one paid
commit per 240 s, the same order as the heartbeat itself.

The keeper treats `CommitNotNeeded` as "someone committed < 240 s ago":
it skips the wait and runs `sync_hand` (a `StaleCommit` there means it was
already synced), so a spammer who commits but never syncs can't push a
table towards its refund timeout.

**Verified:** LiteSVM (`paid_commit_rule`,
`runtime_state_hash_ignores_commit_fields`,
`commit_with_fee_vault_refused_when_not_needed`); Devnet keeper drill
8/8 with the fee vault (the drill had not passed it before): a stranger's
commit right after the keeper's returned `{"Custom":6055}`.

## CF-065: the keeper has its own read key

**Before:** the keeper read tables with the table authority's PER token
(`cf-admin token`), an authority-derived credential on the keeper machine
(CF-055 open item).

**Now:** `TableRuntime.keeper` (bytes 1252–1283), set by the table
authority with `set_keeper(keeper)` (base before delegation, or in PER: it
then rewrites the runtime permission). The runtime's readers are authority
+ keeper (if set) + seated session keys (`runtime_members`, used by every
path that writes that permission). The keeper key can't be the authority,
a table address, a seated wallet or session key, and once set no player can
use it as a session key. It is never added to a seat hand, salt or dealer
permission. `cf-admin table keeper <config> <pubkey|none>`; the keeper logs
in with `CARDFLEX_KEEPER_KEY` and exits after `RELOGIN_DAYS` (20, the token
lasts 30) for its supervisor to restart it.

**Verified:** LiteSVM `keeper_read_key_rules`; Devnet drill: the keeper key
reads nothing before it is named, reads the runtime after `set_keeper` in
PER, and reads 0 of 13 secret accounts (dealer, 6 seat hands, 6 salts); it
then ran the whole drill as the keeper.

## CF-059: empty permission member lists (MagicBlock open question 3)

We don't need MagicBlock's answer: the program never creates or updates a
**private** permission with an empty member list. "Nobody" is always
spelled as a key nobody can sign for (the default key for empty seats; the
runtime PDA for dealer and salts). `create_permission_with` refuses an
empty private list (`BadReaders`); `update_hand_readers` already required
1–3 readers; `runtime_members` always starts with the authority.
`tests/test_permission_members.rs` scans the source so a new permission
write can't slip in unreviewed. HandLog's permission is the one public one
(empty list with `is_private = false`, by design).

**Found while doing it:** the first version of the guard also refused the
public HandLog permission and broke table setup on Devnet (`BadReaders` at
`open_hand_log_permission`); fixed by checking private permissions only.

**Verified on Devnet:** empty seats' hands (reader = default key) return
nothing to a stranger or a seated player (0 of 6 reads), while a player
still reads its own hand in the same check.

## CF-058: TEE measurement-change alert

`cf-admin watch` now runs our own attestation check (`verifyTee`: fresh
challenge, Intel TCB `UpToDate`, pinned MRTD + RTMR0-2) every
`--tee-every` (600 s) and raises `TEE_MEASUREMENTS_CHANGED`, `TEE_TCB`,
`TEE_QUOTE_REPLAYED`/`TEE_QUOTE_INVALID` (critical) or `TEE_UNREACHABLE`
(warning). `cf-admin tee` prints the live values for pinning. On
2026-11-20 Devnet still matches the values pinned on 2026-11-18. Runbook:
`docs/runbooks/alarms.md` (never pin values MagicBlock can't attribute).

## CF-060: monitoring

Already there (CF-056): vault short/surplus, refund near/due, claims
pending, cancel rate. Added:

- keeper `GET /health` (`HEALTH_PORT`): 503 if no PER read succeeded for
  30 s or a table failed 5 steps in a row; per-table hands, failures and
  time since progress;
- `cf-admin watch --keeper-url … --keeper <pubkey>`: `KEEPER_DOWN`,
  `KEEPER_UNHEALTHY` (critical), `KEEPER_LOW_FUNDS` (< 0.05 SOL, warning).

Unit tests for every alarm rule (`services/admin/test/watch.test.ts`,
`services/keeper/test/health.test.ts`).

## CF-066: one-machine multi-user test (stands in for CF-062)

No extra machines are available, so CF-062 (bots on several IPs) waits.
`pnpm multiuser` (`services/keeper/test/multiuser.ts`) tests what matters
for real users from one machine: full six-seat tables where every player is
a separate user (own wallet, session key, PER login, own reads), people
thinking 0.3–3 s per move, a player buying in mid-hand, a player leaving and
cashing out, and own-hand-only privacy after every deal. One keeper process
(production scheduler, own read key, fee vault, indexer) drives all tables.

Run 2026-11-20, 4 tables × 6 users (24 users), 5 hands per table:
**25/25 passed** (`docs/probes/2026-11-20T16-42-14-619Z-cf066-multiuser-4x6-dev-machine-1.json`).

| Measure | p50 | p95 | max |
| --- | --- | --- | --- |
| Action confirm (send → confirmed, client side) | 269 ms | 1,078 ms | 13.4 s |
| Salt confirm | 458 ms | 986 ms | 3.9 s |
| Salts in → cards dealt (VRF + deal + keeper) | 3.2 s | 5.2 s | 5.3 s |
| Own hand readable after the deal is seen | 90 ms | 427 ms | 740 ms |

- 20 hands, all indexed and VALID (12 ended by show, 8 by last player).
- On every table the mid-hand buyer was seated by the keeper and dealt the
  next hand (bought in during #1, dealt #2).
- Every leaver was synced and cashed out exactly its synced stack (925,000
  lamports: 1,000,000 minus three packed boots); every vault exact.
- 72/72 own-hand reads succeeded; 0/72 reads of a neighbour's hand did.
- One keeper `timeout_turn` lost a race with the player's own action
  (`StaleAction`): the program refused the stale step, as designed.
- An earlier 3 × 6 run also passed (20/20), but its leavers had lost their
  whole stack, so the cash-out check proved little; the leaver now plays
  carefully and the check requires a non-zero amount.

Not covered (needs CF-062): capacity at 50 tables, because the PER limits
requests per IP (CF-054).

## Also fixed

- `pnpm admin -- <cmd>`: pnpm passes a bare `--`, which made the CLI skip
  the command word and print its help. It now ignores `--`.
- Probe scripts (`privacy-suite`, `game`, `money`, `recovery`, `table`,
  `restart`) built `commit_hand` / `undelegate_table` without CF-057's
  optional `magic_fee_vault` slot, so their cleanup failed with Anchor 3008
  (InvalidProgramId). They now pass `NO_FEE_VAULT` (= "not given").
- Drills: a slow confirm made the retry wrapper resend `delegate_table`;
  the second copy failed because the first had landed. Drills now accept
  "runtime already delegated" as success; a failed runtime read in the
  drill loop no longer ends the run.

## CF-067: old tables, safe retries, CLI arguments (follow-up the same day)

### Tables made before the layout change

CF-064/065 grew `TableRuntime` from 1,212 to 1,284 bytes. A survey of
Devnet found 296 tables: ~280 old ones with seated ledgers (all test
tables, ~0.79 SOL of test money), 6 of them still live in PER.

- **Money was never trapped.** `buy_in`, `cash_out`, `emergency_refund`,
  `claim_refund` and `sweep_rake` don't read the runtime. Proven live
  (`pnpm --filter @card-flex/keeper refund-old`): an old table still live in
  PER (`2s1p4LA…`) was refunded and both seats were paid exactly their
  synced stacks (1,034,375 and 937,500 lamports); vault exact afterwards.
- **Fix: `migrate_runtime`** (permissionless, base layer only): grows a
  1,212- or 1,252-byte runtime to the current size. Only those layouts are a
  prefix of the current one (fields were appended after `bump` since
  CF-050); the 1,190-byte pre-CF-050 layout moved `bump` and is refused.
  The new fields start at zero, their correct defaults. Operator:
  `cf-admin table migrate <config>`; `cf-admin tables` marks old layouts.
- **Found on Devnet while proving it:** the first version only topped the
  runtime up to bare rent. A runtime also holds the ephemeral budget that
  pays for its PER accounts (CF-007), so the next `table open` failed with
  `InsufficientFundsForRent`. Migration now adds exactly the extra rent and
  restores the full `ephemeral_budget()` (off the PER all ephemeral
  accounts are closed, so the whole budget belongs in the runtime); a
  surplus is kept.
- **Found with it (CF-065 bug):** the runtime permission was budgeted for
  authority + 6 sessions; with the keeper key it can have 8 members. The
  budget now covers `MAX_SEATS + 2`.
- **Found with it (pre-existing):** a table that was opened in PER before
  stays `locked`; `join_seat` and `set_keeper` on the base layer then
  failed with a misleading `BadSeatHand`. They now fail with
  `PerAccountsMissing` ("send it in PER while the table is live"), and
  `cf-admin table keeper` says to open the table first. Its runtime and
  hand-log permissions survive in PER across a close, so re-creating them
  on reopen fails harmlessly and joins in PER update them.
- **Live proof** (`TABLE=<old config> pnpm --filter @card-flex/keeper
  migrate-drill`, table `FVNaz1Z…`, 1,212 bytes, opened before, two old
  absent players): 12/12. Every old byte kept, new fields zero, second
  migrate refused, base `set_keeper` refused with the clear error, players
  joined in PER, the keeper's own key read it, 2 hands played and VALID,
  spam commit refused, vault exact after closing.

### Retries that applied a transaction twice

**Cause:** `confirmByPolling` threw on a single failed status poll (a
network blip), although the transaction might already have landed; every
send helper (drills, load test, admin CLI, probes) then built and sent a
**new** copy. The copy failed (e.g. `delegate_table` on an already
delegated table: `InvalidAccountData`), and the script reported a failure
for a step that had succeeded.

**Fix:** `confirmByPolling` keeps polling through failed polls until its
deadline. New SDK `sendAndConfirm`: each copy's signature is computed
before it is sent; before any resend and before giving up it checks
whether an earlier copy landed (`getSignatureStatuses` with history) and
returns that one; only transport failures are retried, an on-chain error
is final. All drills, the load and multi-user tests and `cf-admin` use it;
the probes' `send` does the same check. The keeper drill's "already
delegated" workaround and the drills' "already in use" skips are gone.
Unit test: a fake cluster where copy 1 lands but every confirm poll fails
→ exactly one send, the landed signature returned.

### `pnpm admin -- <cmd>`

Argument parsing moved to `services/admin/src/args.ts` with tests
(`args.test.ts`): a bare `--` is ignored, valued options don't leak into
positionals, boolean flags don't swallow the next word.
