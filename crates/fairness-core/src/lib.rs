//! CF-Fairness v2 — the canonical, versioned fairness protocol for Card Flex.
//!
//! This crate is the normative implementation of `docs/spec/cf-fairness-v2.md`.
//! It has no Solana, MagicBlock, network or allocation dependencies, so the
//! on-chain program, the independent verifier and the browser (WASM) all run
//! exactly the same code. SHA-256 is injected through [`Sha256`] so the program
//! can use the Solana syscall and hosts can use a software implementation.
//!
//! Any change to an encoding, domain string or algorithm here is a protocol
//! version change: bump [`PROTOCOL_VERSION`] and regenerate the test vectors.

#![no_std]
#![forbid(unsafe_code)]

use card_types::{Card, DECK_SIZE};

/// CF-Fairness protocol version, bound into every hand context.
pub const PROTOCOL_VERSION: u16 = 2;
/// Maximum seats at a table.
pub const MAX_SEATS: usize = 6;
/// Cards dealt to each seat.
pub const CARDS_PER_SEAT: usize = 3;
/// Merkle tree leaves: 52 cards padded to the next power of two.
pub const TREE_LEAVES: usize = 64;
/// Merkle tree depth (log2 of [`TREE_LEAVES`]).
pub const TREE_DEPTH: usize = 6;

pub mod domain {
    //! Domain-separation strings. ASCII, no terminator, never reused.
    pub const ROSTER: &[u8] = b"CF_ROSTER_V2";
    pub const CTX: &[u8] = b"CF_CTX_V2";
    pub const SALT: &[u8] = b"CF_SALT_V2";
    pub const VRF_SEED: &[u8] = b"CF_VRF_SEED_V2";
    pub const SHUFFLE: &[u8] = b"CARD_FLEX_SHUFFLE_V2";
    pub const DRBG: &[u8] = b"CF_DRBG_V2";
    pub const LEAF_SALT: &[u8] = b"CF_LEAF_SALT_V2";
    pub const CARD_LEAF: &[u8] = b"CF_CARD_LEAF_V2";
    pub const EMPTY_LEAF: &[u8] = b"CF_EMPTY_LEAF_V2";
}

pub type Hash = [u8; 32];

/// SHA-256 over the concatenation of `parts`.
pub trait Sha256 {
    fn hashv(parts: &[&[u8]]) -> Hash;
}

/// Software SHA-256 (feature `sha2`), for hosts and tests.
#[cfg(feature = "sha2")]
pub struct SoftSha256;

#[cfg(feature = "sha2")]
impl Sha256 for SoftSha256 {
    fn hashv(parts: &[&[u8]]) -> Hash {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        for p in parts {
            h.update(p);
        }
        h.finalize().into()
    }
}

// ---------------------------------------------------------------- HMAC / HKDF

const BLOCK: usize = 64;

/// HMAC-SHA256 (RFC 2104) with a key of at most 64 bytes.
pub fn hmac<H: Sha256>(key: &[u8], parts: &[&[u8]]) -> Hash {
    assert!(key.len() <= BLOCK, "CF-Fairness only uses keys <= 64 bytes");
    let mut k = [0u8; BLOCK];
    k[..key.len()].copy_from_slice(key);
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    // inner = H(ipad || parts...)
    let mut inner_parts: [&[u8]; 9] = [&[]; 9];
    assert!(parts.len() <= 8, "at most 8 message parts");
    inner_parts[0] = &ipad;
    inner_parts[1..=parts.len()].copy_from_slice(parts);
    let inner = H::hashv(&inner_parts[..=parts.len()]);
    H::hashv(&[&opad, &inner])
}

/// HKDF-SHA256 (RFC 5869) producing exactly 32 bytes (one expand block).
/// `ikm` is given as parts so callers don't need to allocate.
pub fn hkdf32<H: Sha256>(salt: &[u8], ikm: &[&[u8]], info: &[u8]) -> Hash {
    let prk = hmac::<H>(salt, ikm);
    hmac::<H>(&prk, &[info, &[1u8]])
}

// ------------------------------------------------------------------ encodings

/// One seated player in seat order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seat {
    pub index: u8,
    pub wallet: [u8; 32],
}

/// `roster_hash = SHA256("CF_ROSTER_V2" || n:u8 || (seat:u8 || wallet:32)*)`,
/// seats in the order given (dealing order).
pub fn roster_hash<H: Sha256>(seats: &[Seat]) -> Hash {
    assert!(!seats.is_empty() && seats.len() <= MAX_SEATS);
    let n = [seats.len() as u8];
    let mut buf = [0u8; MAX_SEATS * 33];
    for (i, s) in seats.iter().enumerate() {
        buf[i * 33] = s.index;
        buf[i * 33 + 1..i * 33 + 33].copy_from_slice(&s.wallet);
    }
    H::hashv(&[domain::ROSTER, &n, &buf[..seats.len() * 33]])
}

/// Everything that identifies one hand.
#[derive(Clone, Copy, Debug)]
pub struct HandContext {
    pub program_id: [u8; 32],
    pub table: [u8; 32],
    pub hand_no: u64,
    pub roster_hash: Hash,
    pub rules_version: u16,
}

/// `hand_ctx = SHA256("CF_CTX_V2" || program_id || table || hand_no:u64le ||
/// roster_hash || rules_version:u16le || protocol_version:u16le)`.
pub fn hand_ctx<H: Sha256>(c: &HandContext) -> Hash {
    H::hashv(&[
        domain::CTX,
        &c.program_id,
        &c.table,
        &c.hand_no.to_le_bytes(),
        &c.roster_hash,
        &c.rules_version.to_le_bytes(),
        &PROTOCOL_VERSION.to_le_bytes(),
    ])
}

/// `c_i = SHA256("CF_SALT_V2" || hand_ctx || seat:u8 || salt:32)`.
pub fn salt_commitment<H: Sha256>(hand_ctx: &Hash, seat: u8, salt: &[u8; 32]) -> Hash {
    H::hashv(&[domain::SALT, hand_ctx, &[seat], salt])
}

/// `caller_seed = SHA256("CF_VRF_SEED_V2" || hand_ctx || c_0 || ... || c_n)`,
/// commitments in dealing order. Passed to the VRF request.
pub fn vrf_caller_seed<H: Sha256>(hand_ctx: &Hash, commitments: &[Hash]) -> Hash {
    assert!(!commitments.is_empty() && commitments.len() <= MAX_SEATS);
    let mut parts: [&[u8]; 2 + MAX_SEATS] = [&[]; 2 + MAX_SEATS];
    parts[0] = domain::VRF_SEED;
    parts[1] = hand_ctx;
    for (i, c) in commitments.iter().enumerate() {
        parts[2 + i] = c;
    }
    H::hashv(&parts[..2 + commitments.len()])
}

/// `seed = HKDF-SHA256(salt = hand_ctx, ikm = vrf_output || salt_0 || ... ||
/// salt_n, info = "CARD_FLEX_SHUFFLE_V2", L = 32)`, salts in dealing order.
pub fn shuffle_seed<H: Sha256>(hand_ctx: &Hash, vrf_output: &[u8; 32], salts: &[[u8; 32]]) -> Hash {
    assert!(!salts.is_empty() && salts.len() <= MAX_SEATS);
    let mut ikm: [&[u8]; 1 + MAX_SEATS] = [&[]; 1 + MAX_SEATS];
    ikm[0] = vrf_output;
    for (i, s) in salts.iter().enumerate() {
        ikm[1 + i] = s;
    }
    hkdf32::<H>(hand_ctx, &ikm[..1 + salts.len()], domain::SHUFFLE)
}

// ---------------------------------------------------------------------- DRBG

/// Deterministic stream: block `j` = `SHA256("CF_DRBG_V2" || seed || j:u64le)`,
/// read as eight little-endian `u32` words, blocks in order from `j = 0`.
pub struct Drbg<H: Sha256> {
    seed: Hash,
    block: Hash,
    counter: u64,
    word: usize,
    /// Words consumed so far (exposed for test vectors).
    pub words_used: u64,
    _h: core::marker::PhantomData<H>,
}

impl<H: Sha256> Drbg<H> {
    pub fn new(seed: Hash) -> Self {
        Self {
            seed,
            block: [0; 32],
            counter: 0,
            word: 8,
            words_used: 0,
            _h: core::marker::PhantomData,
        }
    }

    pub fn next_u32(&mut self) -> u32 {
        if self.word == 8 {
            self.block = H::hashv(&[domain::DRBG, &self.seed, &self.counter.to_le_bytes()]);
            self.counter += 1;
            self.word = 0;
        }
        let w = u32::from_le_bytes(
            self.block[self.word * 4..self.word * 4 + 4]
                .try_into()
                .unwrap(),
        );
        self.word += 1;
        self.words_used += 1;
        w
    }

    /// Uniform integer in `0..n` by rejection sampling: draw `x`; accept when
    /// `x < 2^32 - (2^32 mod n)`, returning `x mod n`; otherwise draw again.
    pub fn below(&mut self, n: u32) -> u32 {
        assert!(n > 0);
        let zone = u32::MAX - ((u32::MAX % n) + 1) % n; // last accepted value
        loop {
            let x = self.next_u32();
            if x <= zone {
                return x % n;
            }
        }
    }
}

/// Fisher-Yates over the canonical deck (ids 0..=51): for `i` from 51 down to
/// 1, `j = below(i + 1)`, swap `deck[i]` and `deck[j]`.
pub fn shuffle<H: Sha256>(seed: &Hash) -> ([Card; DECK_SIZE], u64) {
    let mut deck = card_types::ordered_deck();
    let mut rng = Drbg::<H>::new(*seed);
    for i in (1..DECK_SIZE).rev() {
        let j = rng.below(i as u32 + 1) as usize;
        deck.swap(i, j);
    }
    (deck, rng.words_used)
}

// -------------------------------------------------------------------- Merkle

/// `leaf_salt_i = SHA256("CF_LEAF_SALT_V2" || seed || i:u8)`.
pub fn leaf_salt<H: Sha256>(seed: &Hash, position: u8) -> Hash {
    H::hashv(&[domain::LEAF_SALT, seed, &[position]])
}

/// `leaf_i = SHA256(0x00 || "CF_CARD_LEAF_V2" || hand_ctx || i:u8 || card:u8 || leaf_salt_i)`.
pub fn card_leaf<H: Sha256>(hand_ctx: &Hash, position: u8, card: Card, leaf_salt: &Hash) -> Hash {
    H::hashv(&[
        &[0x00],
        domain::CARD_LEAF,
        hand_ctx,
        &[position],
        &[card.id()],
        leaf_salt,
    ])
}

/// Padding leaves 52..=63: `SHA256(0x00 || "CF_EMPTY_LEAF_V2" || i:u8)`.
pub fn empty_leaf<H: Sha256>(position: u8) -> Hash {
    H::hashv(&[&[0x00], domain::EMPTY_LEAF, &[position]])
}

/// `parent = SHA256(0x01 || left || right)`.
pub fn parent<H: Sha256>(left: &Hash, right: &Hash) -> Hash {
    H::hashv(&[&[0x01], left, right])
}

/// All 64 leaves for a dealt deck.
pub fn leaves<H: Sha256>(
    hand_ctx: &Hash,
    seed: &Hash,
    deck: &[Card; DECK_SIZE],
) -> [Hash; TREE_LEAVES] {
    let mut out = [[0u8; 32]; TREE_LEAVES];
    for (i, leaf) in out.iter_mut().enumerate() {
        *leaf = if i < DECK_SIZE {
            card_leaf::<H>(hand_ctx, i as u8, deck[i], &leaf_salt::<H>(seed, i as u8))
        } else {
            empty_leaf::<H>(i as u8)
        };
    }
    out
}

/// Merkle root over the 64 leaves (left-to-right, pairwise).
pub fn merkle_root<H: Sha256>(leaves: &[Hash; TREE_LEAVES]) -> Hash {
    let mut level = *leaves;
    let mut width = TREE_LEAVES;
    while width > 1 {
        for i in 0..width / 2 {
            level[i] = parent::<H>(&level[2 * i], &level[2 * i + 1]);
        }
        width /= 2;
    }
    level[0]
}

/// Sibling hashes from leaf to root for `position`.
pub fn merkle_proof<H: Sha256>(
    leaves: &[Hash; TREE_LEAVES],
    position: usize,
) -> [Hash; TREE_DEPTH] {
    assert!(position < TREE_LEAVES);
    let mut level = *leaves;
    let mut width = TREE_LEAVES;
    let mut idx = position;
    let mut proof = [[0u8; 32]; TREE_DEPTH];
    for p in proof.iter_mut() {
        *p = level[idx ^ 1];
        for i in 0..width / 2 {
            level[i] = parent::<H>(&level[2 * i], &level[2 * i + 1]);
        }
        width /= 2;
        idx /= 2;
    }
    proof
}

/// Checks one card against a committed root. At each level the running hash
/// is the left child when the index bit is 0, the right child when it is 1.
pub fn verify_card<H: Sha256>(
    root: &Hash,
    hand_ctx: &Hash,
    position: u8,
    card: Card,
    leaf_salt: &Hash,
    proof: &[Hash; TREE_DEPTH],
) -> bool {
    if position as usize >= DECK_SIZE {
        return false;
    }
    let mut h = card_leaf::<H>(hand_ctx, position, card, leaf_salt);
    let mut idx = position as usize;
    for sib in proof {
        h = if idx & 1 == 0 {
            parent::<H>(&h, sib)
        } else {
            parent::<H>(sib, &h)
        };
        idx /= 2;
    }
    &h == root
}

/// In-place variant of [`leaves`] for constrained stacks (the on-chain
/// program passes a heap buffer). Same output.
pub fn fill_leaves<H: Sha256>(
    hand_ctx: &Hash,
    seed: &Hash,
    deck: &[Card; DECK_SIZE],
    out: &mut [Hash],
) {
    assert!(out.len() == TREE_LEAVES);
    for (i, leaf) in out.iter_mut().enumerate() {
        *leaf = if i < DECK_SIZE {
            card_leaf::<H>(hand_ctx, i as u8, deck[i], &leaf_salt::<H>(seed, i as u8))
        } else {
            empty_leaf::<H>(i as u8)
        };
    }
}

/// Builds the tree in place over `level` (64 leaves, destroyed), returning
/// the root and writing the proof of each `positions[k]` into `proofs[k]`.
/// One pass, 63 parent hashes total, no extra buffers. Same results as
/// [`merkle_root`] and [`merkle_proof`].
pub fn root_and_proofs_in_place<H: Sha256>(
    level: &mut [Hash],
    positions: &[usize],
    proofs: &mut [[Hash; TREE_DEPTH]],
) -> Hash {
    assert!(level.len() == TREE_LEAVES && positions.len() == proofs.len());
    let mut width = TREE_LEAVES;
    for depth in 0..TREE_DEPTH {
        for (k, &p) in positions.iter().enumerate() {
            proofs[k][depth] = level[(p >> depth) ^ 1];
        }
        for i in 0..width / 2 {
            level[i] = parent::<H>(&level[2 * i], &level[2 * i + 1]);
        }
        width /= 2;
    }
    level[0]
}

// ---------------------------------------------------------------------- deal

/// Deck positions for the `k`-th seat in dealing order among `n` seats:
/// `k, k + n, k + 2n`.
pub fn deal_positions(k: usize, n: usize) -> [usize; CARDS_PER_SEAT] {
    assert!(k < n && n <= MAX_SEATS);
    [k, k + n, k + 2 * n]
}

#[cfg(test)]
mod tests {
    use super::*;

    type H = SoftSha256;

    #[test]
    fn hmac_matches_rfc4231_case_2() {
        // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
        let mac = hmac::<H>(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        assert_eq!(
            hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn hkdf_matches_rfc5869_case_1_first_32_bytes() {
        let ikm = [0x0bu8; 22];
        let salt: [u8; 13] = core::array::from_fn(|i| i as u8);
        let info: [u8; 10] = core::array::from_fn(|i| 0xf0 + i as u8);
        let okm = hkdf32::<H>(&salt, &[&ikm], &info);
        assert_eq!(
            hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
        );
    }

    #[test]
    fn below_is_in_range_and_rejects_the_biased_tail() {
        let mut r = Drbg::<H>::new([7; 32]);
        for n in 1..=52u32 {
            for _ in 0..200 {
                assert!(r.below(n) < n);
            }
        }
        // n = 3: 2^32 mod 3 = 1, so exactly the top value u32::MAX is rejected.
        let zone = u32::MAX - ((u32::MAX % 3) + 1) % 3;
        assert_eq!(zone, u32::MAX - 1);
        // n = 2^31: nothing rejected below u32::MAX.
        let n = 1u32 << 31;
        assert_eq!(u32::MAX - ((u32::MAX % n) + 1) % n, u32::MAX);
    }

    #[test]
    fn shuffle_is_a_permutation_and_deterministic() {
        for s in 0..50u8 {
            let (d1, _) = shuffle::<H>(&[s; 32]);
            let (d2, _) = shuffle::<H>(&[s; 32]);
            assert!(card_types::is_complete_deck(&d1));
            assert_eq!(d1, d2);
        }
        assert_ne!(shuffle::<H>(&[1; 32]).0, shuffle::<H>(&[2; 32]).0);
    }

    #[test]
    fn every_position_proof_verifies_and_tampering_fails() {
        let ctx = [9u8; 32];
        let seed = [3u8; 32];
        let (deck, _) = shuffle::<H>(&seed);
        let lv = leaves::<H>(&ctx, &seed, &deck);
        let root = merkle_root::<H>(&lv);
        for (p, &card) in deck.iter().enumerate() {
            let proof = merkle_proof::<H>(&lv, p);
            let salt = leaf_salt::<H>(&seed, p as u8);
            assert!(verify_card::<H>(&root, &ctx, p as u8, card, &salt, &proof));
            let other = Card::from_id((card.id() + 1) % 52).unwrap();
            assert!(!verify_card::<H>(
                &root, &ctx, p as u8, other, &salt, &proof
            ));
            assert!(!verify_card::<H>(
                &root, &[8; 32], p as u8, card, &salt, &proof
            ));
            let wrong_pos = ((p + 1) % 52) as u8;
            assert!(!verify_card::<H>(
                &root, &ctx, wrong_pos, card, &salt, &proof
            ));
            let mut bad = proof;
            bad[3][0] ^= 1;
            assert!(!verify_card::<H>(&root, &ctx, p as u8, card, &salt, &bad));
        }
        assert!(!verify_card::<H>(
            &root,
            &ctx,
            52,
            deck[0],
            &[0; 32],
            &[[0; 32]; TREE_DEPTH]
        ));
    }

    #[test]
    fn in_place_tree_matches_reference() {
        let ctx = [4u8; 32];
        let seed = [6u8; 32];
        let (deck, _) = shuffle::<H>(&seed);
        let reference = leaves::<H>(&ctx, &seed, &deck);
        let mut level = [[0u8; 32]; TREE_LEAVES];
        fill_leaves::<H>(&ctx, &seed, &deck, &mut level);
        assert_eq!(level, reference);
        let positions = [0usize, 5, 17, 33, 51];
        let mut proofs = [[[0u8; 32]; TREE_DEPTH]; 5];
        let root = root_and_proofs_in_place::<H>(&mut level, &positions, &mut proofs);
        assert_eq!(root, merkle_root::<H>(&reference));
        for (k, &p) in positions.iter().enumerate() {
            assert_eq!(proofs[k], merkle_proof::<H>(&reference, p));
        }
    }

    #[test]
    fn deal_map_matches_prd() {
        assert_eq!(deal_positions(0, 6), [0, 6, 12]);
        assert_eq!(deal_positions(5, 6), [5, 11, 17]);
        assert_eq!(deal_positions(1, 2), [1, 3, 5]);
    }

    fn hex(b: &[u8]) -> heapless_hex::Hex<'_> {
        heapless_hex::Hex(b)
    }

    mod heapless_hex {
        pub struct Hex<'a>(pub &'a [u8]);
        impl PartialEq<&str> for Hex<'_> {
            fn eq(&self, other: &&str) -> bool {
                other.len() == self.0.len() * 2
                    && self
                        .0
                        .iter()
                        .enumerate()
                        .all(|(i, b)| u8::from_str_radix(&other[i * 2..i * 2 + 2], 16) == Ok(*b))
            }
        }
        impl core::fmt::Debug for Hex<'_> {
            fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
                for b in self.0 {
                    write!(f, "{b:02x}")?;
                }
                Ok(())
            }
        }
    }
}
