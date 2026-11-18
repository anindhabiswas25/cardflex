# ADR 0003 — CF-Fairness v2 encoding choices

- **Status:** Accepted
- **Date:** 2026-11-18
- **Ticket:** CF-008
- **Spec:** `docs/spec/cf-fairness-v2.md`

## Decisions

1. **The deterministic stream is a SHA-256 counter construction, not
   ChaCha20.**
   `block_j = SHA256("CF_DRBG_V2" || seed || j)`.
   - The PRD named ChaCha20 but also said not to switch PRNGs "merely
     because an example uses one". The reason here is concrete.
   - Inside a Solana program, SHA-256 is a cheap syscall, while ChaCha20
     would run as software instructions.
   - SHA-256 is available in every language's standard library, so the
     independent verifier and outside auditors need no extra crypto
     dependency.
   - With a 32-byte uniform seed, SHA-256 in counter mode is a standard PRF
     construction.
   - The cost is about 7 hash calls per shuffle (51 words; the vectors show
     51 words used).
2. **Leaf salts use domain-separated SHA-256 of the seed**
   (`SHA256("CF_LEAF_SALT_V2" || seed || i)`), not one HKDF call per leaf.
   The seed is already uniform, so the outputs are equally unpredictable
   and it costs half the hashes.
3. **`caller_seed` gets its own domain string** (`CF_VRF_SEED_V2`). The PRD
   formula had none.
4. **The empty leaf doesn't include `hand_ctx`.** Padding carries no secret
   and is identical in every hand. Card leaves do bind `hand_ctx`.
5. **SHA-256 is injected** (`trait Sha256`), so the program uses
   `sol_sha256` and hosts use the `sha2` crate. The algorithm code is
   shared and never forked.
6. **A second implementation is mandatory.**
   `scripts/check_fairness_vectors.py` (Python standard library only) must
   reproduce every vector in CI. A spec change that only the Rust code
   understands fails the build.

## Consequences

- CF-011 still measures real compute units on-chain. The estimate is about
  180 SHA-256 calls per deal (52 leaf salts, 64 leaves, 63 parents,
  7 stream blocks, about 4 for HKDF).
- If ChaCha20 is ever needed, it becomes CF-Fairness v3 with new vectors.
  v2 stays verifiable forever.
