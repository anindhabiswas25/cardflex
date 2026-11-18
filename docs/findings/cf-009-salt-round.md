# CF-009 findings — salt round on Devnet PER

- **Date:** 2026-11-18
- **Result:** the salt round works on Devnet, and the full privacy suite
  (now with salts) passes **231/231 in 2 of 2 runs** from `dev-machine-1`.
- **Code:** `open_salt`, `start_hand`, `submit_salt` and `close_salt` in
  `programs/card-flex/src/lib.rs`; `SolSha256` and phases in `table.rs`; the
  salt section of `packages/probes/src/privacy-suite.mjs`.

## What the program does (CF-Fairness v2 spec §2–3)

1. **`open_salt(seat)`** creates an ephemeral `SaltAccount` per seat. Its
   only permission member is the `TableRuntime` PDA, so **no one, not even
   the submitting player, can read a salt back**.
2. **`start_hand`** (table authority) runs only on a locked table in phase
   `IDLE`. It fixes the dealing order (seat order while the button is fixed
   at seat 0), then computes `roster_hash` and `hand_ctx` on-chain with
   `fairness-core` over `sol_sha256`. Phase becomes `SALTS_PENDING`.
3. **`submit_salt(seat, salt)`** must be signed by that seat's session key,
   once per hand. It writes the salt into the seat's `SaltAccount` and only
   `c_i = SHA256("CF_SALT_V2" || hand_ctx || seat || salt)` into the public
   `TableRuntime`. When every dealt seat has submitted, the phase becomes
   `SALTS_DONE`, ready for the VRF request (CF-010).

## Devnet checks added (all pass, both runs)

| Check | Result |
| --- | --- |
| Submit before `start_hand` | rejected |
| On-chain `roster_hash`, `hand_ctx` vs an independent JS implementation of the spec | equal |
| All six on-chain `c_i` vs JS | equal |
| Session 1 submitting for seat 0; wallet 0 submitting for seat 0; seat 0 writing into seat 1's salt account; a second submit | all rejected |
| Phase after six salts | `SALTS_DONE` |
| Raw salt bytes in the committed or readable `TableRuntime` | none |
| Seat 0's salt transaction as seen by session 1, the authority, a stranger, no token and **session 0 itself** | returned redacted: no instructions, 0 data bytes, no salt |
| Matrix: 15 identities × 6 salt accounts | nobody reads any salt |
| After cleanup | no salt account on Solana |

The program's hasher also has a host test
(`tests/test_fairness_hash.rs`). Through `SolSha256` it reproduces the frozen
vector values, so on-chain and off-chain hashing agree byte for byte. The
Devnet JS cross-check confirms the same on the real syscall.

## The question this answers

Other seats are members of the `TableRuntime` permission, with the
`TX_MESSAGE` flag, and `submit_salt` writes `TableRuntime`. We needed to
know whether that membership exposes the instruction data carrying the salt.
**It doesn't.** The transaction comes back redacted to every identity,
because the salt account in the same transaction has no human member. The
detection method was shown to catch secret bytes in the CF-006 spike, where
a member did see them.

Rule for later instructions: **any instruction whose data carries a secret
must also write an account whose permission has no human member.**
Otherwise members of the other touched accounts may see the data. P5 keeps
`submit_salt` shaped this way.

## Remaining for P2

- CF-010: request the VRF with `caller_seed` (spec §3) when `SALTS_DONE`;
  callback derives the seed.
- CF-011: shuffle, deal and Merkle root in-program from the seed; measure
  compute units; remove the P1 test deck.
- Salt deadline (a seat that doesn't submit is sat out) arrives with the
  crank work in P5.
