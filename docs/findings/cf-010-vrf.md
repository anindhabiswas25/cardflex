# CF-010 findings — MagicBlock VRF inside Devnet PER

- **Date:** 2026-11-18
- **Result:** the VRF request and protected callback work **inside the TEE
  PER using the ephemeral queue**. 12/12 checks in 2 of 2 runs from
  `dev-machine-1`.
- **Code:** `request_shuffle` and `vrf_deal` in `programs/card-flex/src/lib.rs`;
  `packages/probes/src/handflow.mjs` (`pnpm handflow -- --region <label>
  [--queue ephemeral|base]`); shared setup in `packages/probes/src/table.mjs`.
- **Raw data:** `docs/probes/*p2-handflow*.json`

## Design

- **`request_shuffle`** (anyone may pay) is allowed only in `SALTS_DONE`.
  - The program computes
    `caller_seed = vrf_caller_seed(hand_ctx, c_0..c_n)` (spec §3), stores
    it publicly in `TableRuntime` and moves to `VRF_PENDING`.
  - It accepts only MagicBlock's queue addresses.
  - Callback accounts: `TableRuntime`, `DealerState`, then the salt
    accounts in dealing order.
- **`vrf_deal`** (callback) uses `#[vrf_callback]`, which requires the
  **scoped** VRF identity PDA (`PDA(["identity", our program], VRF
  program)`) to sign. SDK 0.17.3 deprecates the global identity this
  project's research had named.
  - It is accepted only in `VRF_PENDING`.
  - It reads the salts (checking PDA, owner, tag and hand number), derives
    `seed = HKDF(hand_ctx, vrf_output || salts)` (spec §4), writes the VRF
    output and seed into the private `DealerState`, and moves to `SEEDED`.

## Results

| Check | Run 1 | Run 2 |
| --- | --- | --- |
| Request before `SALTS_DONE` | rejected | rejected |
| Unknown queue | rejected | rejected |
| Fake callback (stranger) before, during and after fulfilment | rejected | rejected |
| Fake callback signed by the table authority | rejected | rejected |
| On-chain `vrf_caller_seed` vs independent JS spec implementation | equal | equal |
| Second request while pending / after fulfilment | rejected | rejected |
| Request is permissionless (a stranger paid for it) | works | works |
| Callback arrives, phase `SEEDED` | **2.08 s** after request | **2.04 s** |
| Request confirmation | 319 ms | 231 ms |
| `DealerState` (seed) readable by authority | no | no |

**Base queue (`--queue base`):** the request fails inside PER with
`InstructionError Custom(1)`, because that queue lives on the Solana base
layer. The transaction rolls back, so the hand stays in `SALTS_DONE` and can
retry with the ephemeral queue. **Use the ephemeral queue; the base queue is
not an option for PER tables.**

## What it means

- Open question 1 ("does the ephemeral VRF queue work inside PER?") is
  answered: **yes**.
- Randomness costs about **2 s per hand** on Devnet today. That is far below
  the 1–5 s estimated for the base queue, but above the PRD's "< 1 s next
  hand" target. Mitigation (already in the plan): request the next hand's
  VRF during the showdown animation, so players don't wait for it.
- The VRF output travels in the callback's instruction data. The callback
  also writes `DealerState`, which has no human member, so per the CF-009
  rule the transaction is redacted. The VRF output alone doesn't reveal the
  deck anyway (spec §4 needs every salt). It is published at reveal.
- Still open: what happens if the oracle never answers. P3/P5 add a
  timeout (cancel the hand and return the boots; never reroll silently).
