# CF-011 findings — shuffle, deal and commitment in the program

- **Date:** 2026-11-18
- **Result:** the real deal path runs in the program, matches CF-Fairness v2
  byte for byte, and costs 56–68k compute units for 2–6 seats (86k at the
  size-optimized build). On Devnet the full flow passes 39/39 in 2 of 2
  runs, with every card verified against the public root.
- **Code:** `deal_hand`, `cancel_hand` and `bench_deal` in
  `programs/card-flex/src/lib.rs`; `compute_deal` in `table.rs`; in-place
  tree functions in `crates/fairness-core`; tests in `tests/test_deal.rs`;
  Devnet in `packages/probes/src/handflow.mjs`.

## Design

- **`deal_hand`** (anyone may trigger it) is allowed only in `SEEDED`.
  - It reads the private seed from `DealerState`, shuffles (spec §5–6),
    builds the Merkle tree (spec §7) and deals round-robin (spec §8).
  - It writes the deck into `DealerState`, and each seat's 3 cards,
    positions, leaf salts and Merkle proofs into its private `SeatHand`.
    `SeatHand` grew to 727 bytes, so a player can check their own cards
    during play.
  - It publishes only `merkle_root` in `TableRuntime`, then moves to `DEALT`.
- **Memory:** a 64-leaf tree doesn't fit a 4 KB SBF stack frame, so
  `compute_deal` uses heap buffers and the new in-place
  `fill_leaves` / `root_and_proofs_in_place`. They give the same output as
  the reference functions (unit test).
- **Compute measurement:** PER hides compute units even from the table
  authority, so `bench_deal` (no accounts, no state) lets LiteSVM measure the
  same path. It must be removed before public Devnet (P8).

## Compute units (LiteSVM, release build)

| Seats | `bench_deal` (shuffle + tree + proofs) | `deal_hand` (incl. account writes) |
| --- | --- | --- |
| 2 | 35,584 | 56,000 |
| 3 | 36,095 | 56,386 |
| 4 | 36,606 | — |
| 5 | 37,117 | — |
| 6 | 37,628 | 68,044 |

That is about a third of the 200k default per-instruction budget, so the
deal could even move into the VRF callback later to save a transaction. The
ADR 0003 estimate of about 180 hash calls holds.

## Correctness (LiteSVM)

For 2, 3 and 6 seats, after `deal_hand`:

- the public root equals the host reference computed with software SHA-256;
- the deck in `DealerState` equals the reference shuffle;
- every card, position, leaf salt and proof in every `SeatHand` verifies
  against the root with `verify_card`, exactly as a player's client does;
- all cards are distinct.

Misuse is rejected: the wrong number of hands, the wrong order, a foreign
account, and a second deal.

## Security review fixes included

The background review of CF-010 found two issues; both are fixed here.

1. **Salt substitution.** `vrf_deal` now recomputes every `c_i` from the
   salt it reads and requires it to equal the committed value. Opening or
   closing a salt, hand or dealer account is refused while a hand is in
   progress (`HandInProgress`), tested in every in-progress phase.
2. **Stuck in `VRF_PENDING`.** `cancel_hand` (permissionless) is allowed only
   after `VRF_TIMEOUT_SLOTS = 3000` (about 30 s).
   - It counts the cancellation publicly (`cancelled_hands`) and moves the
     hand number on.
   - The VRF request now echoes the hand number in `callback_args`, and the
     callback rejects a different one (`StaleCallback`), so a late callback
     can't land on the next hand.
   - Tests cover the phase check, too-early refusal and successful cancel.
   - Returning boots on cancel belongs to the money work (P6).

## Devnet (`pnpm handflow`, 2 of 2 runs, 39/39 checks)

| Step | Run 1 | Run 2 |
| --- | --- | --- |
| VRF request confirmed | 373 ms | 318 ms |
| Request → callback (`SEEDED`) | 2.33 s | 2.15 s |
| `deal_hand` confirmed (sent by a stranger: permissionless) | 1.23 s | 1.24 s |
| All six players read their hands | 0.85 s | 0.91 s |

Checks that passed in both runs:

- a deal before `SEEDED` is rejected; so are a second deal, closing a salt
  account mid-hand, and cancelling before the VRF timeout;
- the phase reaches `DEALT` and the Merkle root is published;
- every card sits at its spec position;
- **all 18 cards verify against the public root with an independent JS
  verifier** (spec §7);
- all 18 cards are distinct;
- session 1 can't read seat 0's hand.

The privacy suite (231 checks) still passes after these changes.

Card delivery end to end (deal sent → all players have verified cards) is
about 2.1 s on Devnet today: 1.2 s for deal confirmation plus 0.9 s for
reads. The PRD target is 500 ms. The VRF wait (about 2.2 s) comes before
that, and can be overlapped with the previous hand's showdown.

## Program size (same day)

The upgrade with this code failed repeatedly over a flaky Devnet: 664 KB
means about 650 one-transaction chunks, and `solana program deploy` can't
resume. Fixes:

- **Scaffolding removed:** the CF-004 `probe_*` instructions and the A1
  spike. Their results stay in the findings docs; the code was last present
  in commit `e017823`, and `packages/probes/src/archive/roundtrip.mjs`
  needs that build.
- **Unused SDK feature `crank` dropped.**
- **`opt-level = "s"` for the program and `"z"` for dependencies:**

  | Build | Size | `deal_hand`, 6 seats |
  | --- | --- | --- |
  | before | 664 KB | 68 k CU |
  | scaffolding removed, opt 3 | 568 KB | 74 k CU |
  | **chosen: s / z** | **470 KB** (478 KB with test deck) | **86 k CU** |
  | z everywhere | 453 KB | 96 k CU |

- **`pnpm deploy:devnet` (`scripts/deploy-devnet.sh`):** builds the devnet
  variant, extends program space if needed, writes a buffer with a **saved**
  keypair (re-runs resume), upgrades, and checks the on-chain bytes. The
  first run deployed in one pass.
