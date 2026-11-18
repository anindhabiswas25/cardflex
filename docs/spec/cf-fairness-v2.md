# CF-Fairness v2 — byte-level specification

- **Status:** Frozen (CF-008, 2026-11-18). Changing anything here is a new
  protocol version.
- **Normative implementation:** `crates/fairness-core` (no_std Rust)
- **Test vectors:** `docs/spec/vectors/cf-fairness-v2.json` (3 cases)
- **Independent implementation:** `scripts/check_fairness_vectors.py`
  (Python standard library only), run in CI against the vectors
- **Design rationale:** PRD v1.2 §13, ADR 0003

## 1. Conventions

- `||` is byte concatenation. Strings are ASCII, with no length prefix and
  no terminator.
- Integers are little-endian and fixed width: `u8`, `u16le`, `u64le`.
- `SHA256(x)` is FIPS 180-4 SHA-256. `HMAC` is RFC 2104 with SHA-256.
  `HKDF` is RFC 5869 with SHA-256.
- Public keys are their 32 raw bytes.
- **Dealing order:** the list of seated players starting from the seat the
  rules say receives the first card (PRD §11.1). Every per-seat list below
  (seats, salts, commitments) is in dealing order.
- **Cards:** one byte, `card_id = suit × 13 + (rank − 2)`. Suits are clubs
  0, diamonds 1, hearts 2, spades 3; rank is 2..14 with ace = 14
  (`crates/card-types`). The canonical deck is ids `0, 1, …, 51`.

## 2. Hand identity

```
roster_hash = SHA256("CF_ROSTER_V2" || n:u8 || (seat_index:u8 || wallet:32) × n)
hand_ctx    = SHA256("CF_CTX_V2" || program_id:32 || table:32 || hand_no:u64le
                     || roster_hash:32 || rules_version:u16le || protocol_version:u16le)
```

`table` is the `TableConfig` address. `protocol_version` is `2`. `n` is
between 1 and 6.

## 3. Salts and the VRF request

Each seated client draws `salt_i`, 32 bytes from a CSPRNG, and submits it
privately.

```
c_i         = SHA256("CF_SALT_V2" || hand_ctx || seat_index_i:u8 || salt_i:32)
caller_seed = SHA256("CF_VRF_SEED_V2" || hand_ctx || c_0 || … || c_(n−1))
```

`caller_seed` is the `caller_seed` of the MagicBlock VRF request.

## 4. Shuffle seed

```
seed = HKDF-SHA256(salt = hand_ctx,
                   IKM  = vrf_output:32 || salt_0 || … || salt_(n−1),
                   info = "CARD_FLEX_SHUFFLE_V2",
                   L    = 32)
```

That is, `PRK = HMAC(hand_ctx, IKM)` and `seed = HMAC(PRK, info || 0x01)`.

## 5. Deterministic stream

```
block_j = SHA256("CF_DRBG_V2" || seed || j:u64le),   j = 0, 1, 2, …
```

Each block is read as eight `u32le` words, in order. The stream is the words
of `block_0`, then `block_1`, and so on.

**Uniform integer in `[0, n)`** (rejection sampling): take the next word
`x`. If `x < 2^32 − (2^32 mod n)`, return `x mod n`; otherwise take the next
word and repeat. Never use plain `x mod n`.

## 6. Shuffle

Start with the canonical deck `D = [0, 1, …, 51]`. For `i = 51` down to `1`:
`j = uniform(i + 1)`, then swap `D[i]` and `D[j]`. The result is the deck,
read by position `0..51`.

## 7. Commitment

```
leaf_salt_i = SHA256("CF_LEAF_SALT_V2" || seed || i:u8)                     i = 0..51
leaf_i      = SHA256(0x00 || "CF_CARD_LEAF_V2" || hand_ctx || i:u8 || D[i]:u8 || leaf_salt_i)
leaf_i      = SHA256(0x00 || "CF_EMPTY_LEAF_V2" || i:u8)                     i = 52..63
parent      = SHA256(0x01 || left || right)
```

The tree has 64 leaves in position order and is built bottom-up, pairing
`(0,1), (2,3), …` at each level, 6 levels in all. `merkle_root` is the top.

**Proof for position `p`:** 6 sibling hashes, leaf level first. To verify,
set `h = leaf_p`. At each level, if the index bit is 0,
`h = parent(h, sibling)`; otherwise `h = parent(sibling, h)`. Then halve the
index. The card is valid if `h == merkle_root`.

## 8. Deal

With `n` seats in dealing order, the `k`-th seat (0-based) receives deck
positions `k`, `k + n` and `k + 2n`.

## 9. Reveal and verification

After a hand, the hand log publishes `program_id`, `table`, `hand_no`,
`rules_version`, the roster (seat indices and wallets in dealing order),
every `salt_i`, `vrf_output`, and the VRF request/callback signatures.

A verifier recomputes `roster_hash`, `hand_ctx`, every `c_i`,
`caller_seed`, `seed`, the deck, the tree and the deal, then compares them
with the committed `merkle_root`, the committed `c_i`, the VRF request's
`caller_seed` and the cards shown at showdown. Any mismatch makes the hand
INVALID.

## 10. Test vectors

`docs/spec/vectors/cf-fairness-v2.json` has three cases: six contiguous
seats, two non-adjacent seats, and three seats with `hand_no = 2^64 − 1`.
Each lists every intermediate value: roster hash, hand context,
commitments, caller seed, seed, the first 16 stream words, words used by
the shuffle, the deck, an empty leaf, the root, proofs for positions 0, 17
and 51, and the deal.

```bash
cargo test -p fairness-core            # Rust: vectors must not drift
python3 scripts/check_fairness_vectors.py   # Python: independent re-derivation
```

HMAC and HKDF are additionally checked against RFC 4231 case 2 and RFC 5869
case 1.
