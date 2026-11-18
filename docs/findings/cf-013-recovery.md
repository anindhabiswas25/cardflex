# CF-013 findings — recovery when PER is unavailable (P3)

- **Date:** 2026-11-18
- **Policy:** ADR 0004
- **Code:**
  - `configure_table`, `buy_in`, `commit_hand`, `sync_hand` and
    `emergency_refund` in `programs/card-flex`;
  - the `TableVault` and `SeatLedger` accounts;
  - `tests/test_recovery.rs`;
  - `packages/probes/src/recovery.mjs` (`pnpm recovery -- --region <label>`).

## Step 2: money skeleton and recovery logic (LiteSVM, 4 tests)

| Behaviour | Result |
| --- | --- |
| `buy_in` moves exactly the amount into the vault and records `SeatLedger` (payout wallet fixed) | pass |
| Buy-in limits, taken seat, one wallet per table; terms frozen after the first buy-in | rejected as expected |
| `sync_hand` via the **delegated** path checks the delegation record (validator = recorded TEE validator, owner = our program) | pass; a wrong validator or wrong owner is rejected |
| Stale (same) commit | rejected |
| Mid-hand commit (`DEALT`): liveness clock refreshes, stacks **not** copied | pass |
| `emergency_refund` before the timeout, with a wrong payout wallet, or with a seat missing | rejected |
| After the timeout: each seat paid exactly `synced_stack`; vault down by the total; status `REFUNDED` | pass |
| After a refund: second refund and sync of a later commit rejected | pass |
| A recent sync postpones the refund | pass |

## Step 3: Devnet outage drill (`pnpm recovery`, 19/19)

A 3-seat table with real 0.01 SOL buy-ins, delegated to the TEE validator:

1. Ledgers equal the buy-ins; the delegation's validator is recorded in
   `TableConfig`.
2. **Heartbeat:** `commit_hand` in PER reached the base layer in **3.96 s**;
   `sync_hand` accepted it; a replay was rejected.
3. A hand was started, salted, seeded by VRF and **dealt**, then PER went
   silent (no more commits).
4. A refund before the timeout was rejected. **68.6 s after the last sync**
   (timeout 60 s), a **bystander** wallet called `emergency_refund`:
   - each of the 3 wallets received exactly 10,000,000 lamports;
   - the vault paid exactly 30,000,000;
   - status is `REFUNDED`, and a second refund was rejected.
5. **PER came back** and committed. The late commit landed on Solana, but
   `sync_hand` rejected it (table not active), so no money moved. A second
   deal and a new VRF request were both rejected (no redeal).
6. The PER side was then finished, revealed, closed and undelegated.

Regressions after these changes: hand flow 52/52, privacy suite 231/231,
six-player test pass.

## What this shows for G3

- Money is recoverable with **no cooperation** from PER, the operator or the
  backend: a stranger triggered the refund on the base layer alone.
- The refund is exact and covers a hand interrupted mid-play.
- State that arrives after a refund can't move money.
- No hand is dealt twice.

## Security review fixes (same day)

1. **Validator trust (high).** The authority chose the delegation
   validator, and `sync_hand` trusted whichever one was recorded, so a
   validator it controlled could commit fake stacks. Now:
   - `allowed_validator` accepts only MagicBlock's TEE validator
     (`MTEWGuq…`), plus the local stack's validator with the `local-stack`
     feature, for drills only;
   - `delegate_table` refuses any other validator and any change once one
     is recorded;
   - `sync_hand` re-checks the allow-list;
   - test: a rogue validator is never trusted, even if `TableConfig` names
     it.
2. **All-or-nothing refund (high).** One failing payout (for example a tiny
   amount to an empty wallet, below rent exemption) blocked every seat's
   refund. Now:
   - `emergency_refund` only switches the table to `REFUNDED`;
   - `claim_refund` (anyone, per seat) pays one seat, independently, only to
     its recorded wallet, once;
   - `min_buy_in` must be at least the rent-exempt minimum;
   - tests: independent claims, wrong wallet, double claim.

Devnet drill rerun on the fixed program: **20/20** (refund 66.5 s after the
last sync, three independent claims, a second claim rejected). Regressions:
hand flow 52/52, privacy suite 231/231, six-player test pass.

## Step 4: validator restart drill (local stack, `scripts/restart-drill.sh`)

The three local services run separately, so only the ephemeral validator is
killed and restarted (same command, same storage). Mid-hand state: a table
delegated, ephemeral hands and salts with permissions, hand started, 2 of 3
salts in.

| After the restart | Result |
| --- | --- |
| Runtime still delegated (base owner = delegation program) and readable in the ER | yes |
| Same hand number, `hand_ctx`, salt commitments, phase, salts-in mask | yes |
| Ephemeral seat hand still exists for its owner | yes |
| Permissions still hide hand 0 from a stranger and from seat 1 | yes |
| Seat 0 can't resubmit its salt (salt account and state kept) | yes |
| Last salt accepted, phase `SALTS_DONE`; the hand continues and cards are dealt; a second deal is rejected | yes |
| `commit_hand` / undelegate reaching the base layer | **no, in both the restart and a control run without restart** |

**Why commits fail locally:** with `RUST_LOG=info` the validator log shows
every commit rejected by the local base layer: *"failed to deserialize
solana_transaction::versioned::VersionedTransaction"*. The MagicBlock
validator 1.1.1 is built on solana-core 4.0, while our pinned
`solana-test-validator` is Agave 3.1.10. On Devnet (Agave 4.5) commits work
(outage drill). This is **not a restart effect** (the control run fails too).

**Correction (later the same day):** the first explanation, that Agave 3.1
can't parse solana 4.0 transactions, was wrong. With an approved, separate
Agave **4.0.3** `solana-test-validator` as the local base layer (installed
in `~/.local/share/agave-4.0.3/`; the pinned 3.1.10 CLI is untouched), the
log confirms `Version: 4.0.3`, and commits are rejected with the **same**
error. The real cause is still unknown. Candidates: a newer transaction
format or feature gate that only Devnet (Agave 4.5) has, or a
MagicBlock-specific local setup we're missing. Next options: try Agave
4.4.x, ask MagicBlock which local base-layer version validator 1.1.1
expects, or pin an older local validator. Commits after a restart remain
unverified locally; Devnet commits work.

## G3 evaluation (PRD §13.6)

| G3 criterion | Evidence | Result |
| --- | --- | --- |
| After a PER outage, every seat is refunded exactly | Devnet drill ×2, LiteSVM | **met** |
| …or the same state resumes | Local restart drill: delegated + ephemeral state, permissions and hand progress survive; the hand continues | **met for the validator software**; not testable on the Devnet TEE (we can't restart it) |
| No hand is dealt twice | Devnet (second deal, new VRF request rejected) and the restart drill | **met** |
| Money recoverable without PER, operator or backend | Bystander-triggered refund and claims on the base layer | **met** |
| Late commits can't move money | Devnet: late commit landed, sync rejected | **met** |

**Recommendation: GO on MagicBlock, conditionally.** Player funds never
depend on PER being available (base-layer vault, claims, validator pinned),
which is what G3 protects. The open items concern availability, not
safety:

1. commits after a restart (needs an Agave 4.x local validator);
2. whether a TEE restart on Devnet/Mainnet keeps ephemeral state and
   permissions (question for MagicBlock);
3. the refund timeout and keeper design for production (P8).

The final G3 sign-off is the PM's.
