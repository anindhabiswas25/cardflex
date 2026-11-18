# ADR 0002 — Account lifecycle: base, delegated, ephemeral-only

- **Status:** Accepted. One assumption is still to be proven in P1 (A1 below).
- **Date:** 2026-11-18
- **Ticket:** CF-005
- **Amends:** PRD v1.2 §5.1.1, §10.2, §10.7, §13.3, §15.2–15.4, §25.3

## Context

Every Card Flex account sits in one of three places:

- **Base:** a normal Solana account, never delegated.
- **Delegated:** created on Solana, then handed to the PER. While
  delegated, the base-layer copy is owned by the delegation program and only
  changes when the PER commits.
- **Ephemeral-only:** created inside the PER (rent 32 lamports/byte, paid by
  a sponsor account). Never written to Solana.

Facts that drive the decision (SDK 0.17.3 source and the CF-004 run):

1. **A commit writes the account's full data to Solana in plaintext.** The
   delegation program performs it and doesn't consult our program. Any
   account that is ever committed must hold no secret at commit time.
2. **Our program can't veto a commit.** PRD v1.2 §10.7 ("later commits from
   PER are rejected") isn't possible as written.
3. **`DelegateConfig::default()` sets `commit_frequency_ms = u32::MAX`,** so
   the validator never auto-commits. Any other value would make the
   validator commit on its own schedule.
4. **Commits cost fees.** Without a fee payer, an account stops after 10
   commits (MagicBlock docs). Per-hand commits need a funded commit sponsor.
5. **Ephemeral-only accounts never reach Solana.** If the PER loses them,
   they are gone.

## Decision

| Account | Location | Readers in PER | Committed | Why |
| --- | --- | --- | --- | --- |
| `GlobalConfig` | Base | — | — | Authority, fees, refund timeout, pause |
| `TableConfig` | Base | — | — | Boot, limits, rules version, **status** (`ACTIVE`, `PAUSED`, `REFUNDED`, `CLOSED`), last synced hand |
| `TableVault` | Base | — | — | All lamports. Never delegated (D5) |
| `SeatLedger[i]` | Base | — | — | Wallet, payout address, synced stack, session key |
| `TableRuntime` | Delegated | seated session keys + indexer | After every hand (`commit_hand`) and on close | Public table state: seats, stacks, pot, turn, `action_seq`, salt commitments, Merkle root, `hand_no`. **Never holds secrets** |
| `HandLog` | Delegated | public | Same commit as `TableRuntime` | Ring buffer of the last 8 hand summaries plus the full reveal of the last hand (VRF output, salts, action-log hash). Replaces `HandRecord` and `HandSecrets` |
| `DealerState` | Ephemeral-only | none | Never | Deck and seed inputs for the current hand |
| `SaltAccount[i]` | Ephemeral-only | none | Never | Player salt for the current hand |
| `SeatHand[i]` | Ephemeral-only | that seat's session key | Never | 3 cards, leaf salts, proofs |

Rules:

1. **Delegation config:** always `commit_frequency_ms = u32::MAX`, set
   explicitly and checked by a test. Validator is always the TEE validator
   from `GlobalConfig`.
2. **Before any commit,** `TableRuntime` and `HandLog` must contain only
   public or already-revealed data. A unit test serializes both after every
   state transition and checks that no current-hand card, salt or seed bytes
   appear.
3. **Ephemeral-only accounts are sponsored by `TableRuntime`.** It carries
   lamports from the base layer at delegation, as `probe_init` did in
   CF-004. They are closed (rent returned) at table close, before
   `undelegate_table`.
4. **Money moves only on the base layer, from committed state.** A new
   permissionless base instruction, `sync_hand`, reads the committed
   `TableRuntime` and `HandLog`. It accepts them only if:
   - they are the expected PDAs;
   - the delegation record names our program and the TEE validator;
   - `hand_no` is greater than `TableConfig.last_synced_hand`;
   - `TableConfig.status` is `ACTIVE`.

   It then updates `SeatLedger` stacks and rake owed. `cash_out` uses only
   synced `SeatLedger` values.
5. **Refund:** `emergency_refund` (permissionless after
   `refund_timeout_secs` with no new synced hand) sets `TableConfig.status
   = REFUNDED` and pays every seat its synced stack. Later commits may still
   land on `TableRuntime`, but `sync_hand` ignores them because of the status,
   so they can't move money. This replaces "commits after refund are
   rejected".
6. **Permanent history:** the base copy of `HandLog` only holds recent hands.
   The permanent record of each hand is the commit transaction on Solana,
   which the indexer stores (PRD §19) with its signature.
7. **Commit fees:** each table has a funded commit sponsor. The exact
   `MagicIntentBundleBuilder` fee-payer setup is a P5 task, tested over more
   than 26 commits.

## Assumption to prove in P1

**A1.** An `EphemeralPermission` can be attached to an **ephemeral-only**
account, and it hides that account from non-members through every read path.
MagicBlock's examples only show permissions on delegated accounts.

- **Test:** CF-006/CF-007 privacy probe suite.
- **If A1 fails:** `DealerState`, `SaltAccount` and `SeatHand` become
  delegated accounts created at `create_table`. They are then never included
  in `commit_hand`, and the program zeroizes them before `undelegate_table`.
  Rule 2's test then also covers these accounts.

## Consequences

- No secret can reach Solana through a commit, because secret accounts are
  never committed.
- If the PER loses ephemeral state mid-hand, that hand can't continue. The
  table pauses, and money is safe through `sync_hand` and `emergency_refund`
  (G3 tests this).
- Six fewer base-layer accounts to fund per table, because the hands, salts
  and dealer state cost only ephemeral rent.
- Base instructions must read delegated accounts that our program doesn't
  own. They use unchecked accounts with explicit PDA and delegation-record
  checks, never Anchor's `Account<T>` owner check. P6 needs negative tests:
  - an account substituted for the real one;
  - a non-delegated copy;
  - a delegation record pointing at the wrong validator.
- The PRD's `HandRecord` and `HandSecrets` merge into `HandLog`.

## Open questions for MagicBlock (added to delivery plan §11)

- Do ephemeral-only accounts survive a PER restart?
- Is the base-layer data of a delegated account readable and stable between
  commits? (Expected yes; verify in P5.)
