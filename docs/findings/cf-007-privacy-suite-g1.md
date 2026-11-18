# CF-007 findings — privacy probe suite and gate G1

- **Date:** 2026-11-18
- **Result:** 134 of 134 checks passed in 2 of 2 runs on Devnet PER from
  `dev-machine-1`.
- **G1 status: provisionally passed.** It becomes final after the suite passes
  from every target region, plus one run on a different day. The PM signs off.
- **Code:** `packages/probes/src/privacy-suite.mjs` (`pnpm privacy-suite --
  --region <label>`, needs `pnpm build:program:devnet-poc` and that build
  deployed), `programs/card-flex` `set_hand_readers`,
  `tests/test_no_secret_logs.rs`
- **Raw data:** `docs/probes/*cf007*.json` (12:59 UTC run stopped at the
  Side Show step, which revealed the rent bug below)

## Setup

Six-player table with the ADR 0002 layout, dealt from the P1 test deck.
Identities: table authority, a stranger, no token, six session keys, and
player 0's wallet.

## Checks (both runs identical)

| Group | Checks | What it proves |
| --- | --- | --- |
| subscriptions | 2/2 | A stranger and a no-token client subscribed to all 7 secret accounts during the deal got 0 notifications |
| own cards | 6/6 | Each session key reads exactly its 3 dealt cards |
| matrix | 80/80 | 10 identities × 8 accounts `getAccountInfo`: session i reads hand i and the runtime only; the authority reads the runtime only; the wallet, the stranger and no token read nothing; nobody reads the dealer state |
| encodings | 16/16 | `base64`, `base64` + `dataSlice`, `jsonParsed` and `base58` reads of hand 0 by the stranger, no token, session 1 and wallet 0 all return null |
| multi | 1/1 | session 0 `getMultipleAccounts [hand0, hand1, dealer, runtime]` returns `[yes, null, null, yes]` |
| enumeration | 6/6 | `getProgramAccounts` returns no secret account to the stranger, no token or the authority, and only hand 0 to session 0. `getSignaturesForAddress(hand0)` returns nothing to the stranger or no token |
| side show | 4/4 | Granting session 1 read access to hand 0 works in 89 ms; session 2 is still denied; revoking takes effect in 212 ms **with the same token** |
| rotation | 2/2 | After seat 2's reader is replaced, the old session's still-valid token is denied in 118 ms; the new key reads |
| authorization | 8/8 | The stranger and session 1 can't change readers; the stranger can't close a hand or deal; nobody can redeal a dealt hand; an empty reader list is rejected; cards unchanged after all attempts |
| logs | 1/1 | Deal transaction: **0 log lines visible even to the authority** (see below) |
| base layer | 8/8 | After cleanup the runtime is back on Solana; the dealer and all six hands are absent on Solana |

## Things found while building the suite

1. **Bug, fixed:** a Side Show grant failed with `InsufficientFundsForRent`.
   Growing a permission from 1 to 2 readers costs more ephemeral rent, and the
   table's budget only covered 1. `ephemeral_budget()` now funds every seat
   permission at `MAX_HAND_READERS = 3`, and `set_hand_readers` enforces that
   limit.
2. **An account in PER without a permission is public.** Two leftovers from
   earlier aborted runs (a `TableRuntime` and a `Probe`, both from runs that
   failed before their permission was created) are listed and readable by
   anyone. That is expected behaviour, and it is the reason secret accounts
   are created **and** permissioned in the same instruction (`open_dealer`,
   `open_seat_hand`), so they are never readable even briefly. Rule for P5:
   never write table data before its permission exists.
3. **Logs can't be audited from a client.** The PER returned 0 log lines for
   the deal even to the table authority. So "no secrets in logs" is enforced
   in the source instead: `test_no_secret_logs.rs` fails CI if any `msg!` is
   not on a fixed-string allow-list.
4. **Revocation is fast and token-independent.** Removing a reader takes
   effect within about 0.1–0.2 s, and the removed key's token keeps working
   for everything else but loses that account. This confirms the CF-003
   design (session key as reader, rotated at stand-up).

## G1 criteria (PRD v1.2 §13.6) against the evidence

| Criterion | Evidence | Status |
| --- | --- | --- |
| Six wallets each read exactly their own three cards | own cards 6/6, matrix | met |
| Other seats' hands, salts and dealer state fail through RPC, WebSocket, `getTransaction`, logs and session reuse | matrix, encodings, multi, enumeration, subscriptions, rotation; salt-style transactions redacted (CF-006 spike); logs enforced in source | met (salt accounts arrive in P2; their transaction redaction is already shown) |
| Salt transaction contents hidden from other seats | CF-006 spike: non-members see signature + status only | met for the mechanism; re-check in P2 with real `submit_salt` |
| No player can write card state | authorization 8/8 | met |
| From every target region | only `dev-machine-1` | **open** |

## Still open for G1 sign-off

- Run `pnpm privacy-suite -- --region <label>` from every target region and on
  a second day.
- Re-run once P2 adds real `SaltAccount`s and `submit_salt`.
