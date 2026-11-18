#!/usr/bin/env python3
"""Independent check of the CF-Fairness v2 test vectors.

Re-implements docs/spec/cf-fairness-v2.md using only Python's standard library
(hashlib, hmac) and compares every value with
docs/spec/vectors/cf-fairness-v2.json, which the Rust crate generates. If the
two implementations agree, the spec is complete enough to verify hands without
our Rust code. Exit status 0 = all match.
"""

import hashlib
import hmac
import json
import struct
import sys
from pathlib import Path

PROTOCOL_VERSION = 2
VECTORS = Path(__file__).resolve().parent.parent / "docs/spec/vectors/cf-fairness-v2.json"


def sha256(*parts: bytes) -> bytes:
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hkdf32(salt: bytes, ikm: bytes, info: bytes) -> bytes:
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()


def roster_hash(seats, wallets):
    body = b"".join(bytes([s]) + w for s, w in zip(seats, wallets))
    return sha256(b"CF_ROSTER_V2", bytes([len(seats)]), body)


def hand_ctx(program_id, table, hand_no, roster, rules_version):
    return sha256(
        b"CF_CTX_V2", program_id, table, struct.pack("<Q", hand_no), roster,
        struct.pack("<H", rules_version), struct.pack("<H", PROTOCOL_VERSION),
    )


class Drbg:
    def __init__(self, seed: bytes):
        self.seed, self.counter, self.words, self.used = seed, 0, [], 0

    def next_u32(self) -> int:
        if not self.words:
            block = sha256(b"CF_DRBG_V2", self.seed, struct.pack("<Q", self.counter))
            self.counter += 1
            self.words = list(struct.unpack("<8I", block))
        self.used += 1
        return self.words.pop(0)

    def below(self, n: int) -> int:
        limit = 2**32 - (2**32 % n)  # accept x < limit
        while True:
            x = self.next_u32()
            if x < limit:
                return x % n


def shuffle(seed: bytes):
    deck = list(range(52))
    rng = Drbg(seed)
    for i in range(51, 0, -1):
        j = rng.below(i + 1)
        deck[i], deck[j] = deck[j], deck[i]
    return deck, rng.used


def leaf_salt(seed, i):
    return sha256(b"CF_LEAF_SALT_V2", seed, bytes([i]))


def card_leaf(ctx, i, card, salt):
    return sha256(b"\x00", b"CF_CARD_LEAF_V2", ctx, bytes([i]), bytes([card]), salt)


def empty_leaf(i):
    return sha256(b"\x00", b"CF_EMPTY_LEAF_V2", bytes([i]))


def parent(left, right):
    return sha256(b"\x01", left, right)


def tree(ctx, seed, deck):
    leaves = [card_leaf(ctx, i, deck[i], leaf_salt(seed, i)) for i in range(52)]
    leaves += [empty_leaf(i) for i in range(52, 64)]
    levels = [leaves]
    while len(levels[-1]) > 1:
        lv = levels[-1]
        levels.append([parent(lv[k], lv[k + 1]) for k in range(0, len(lv), 2)])
    return levels


def proof(levels, pos):
    out, idx = [], pos
    for lv in levels[:-1]:
        out.append(lv[idx ^ 1])
        idx //= 2
    return out


def verify_card(root, ctx, pos, card, salt, siblings):
    h, idx = card_leaf(ctx, pos, card, salt), pos
    for sib in siblings:
        h = parent(h, sib) if idx % 2 == 0 else parent(sib, h)
        idx //= 2
    return h == root


def main() -> int:
    data = json.loads(VECTORS.read_text())
    assert data["protocol_version"] == PROTOCOL_VERSION
    failures = 0

    def eq(case, field, got, want):
        nonlocal failures
        if got != want:
            failures += 1
            print(f"MISMATCH {case} {field}:\n  python {got}\n  rust   {want}")

    for case in data["cases"]:
        name, i, o = case["name"], case["input"], case["output"]
        b = bytes.fromhex
        wallets = [b(w) for w in i["wallets"]]
        salts = [b(s) for s in i["salts"]]
        roster = roster_hash(i["seats"], wallets)
        ctx = hand_ctx(b(i["program_id"]), b(i["table"]), int(i["hand_no"]), roster, i["rules_version"])
        commits = [sha256(b"CF_SALT_V2", ctx, bytes([s]), salt) for s, salt in zip(i["seats"], salts)]
        caller_seed = sha256(b"CF_VRF_SEED_V2", ctx, *commits)
        seed = hkdf32(ctx, b(i["vrf_output"]) + b"".join(salts), b"CARD_FLEX_SHUFFLE_V2")
        rng = Drbg(seed)
        words = [rng.next_u32() for _ in range(16)]
        deck, used = shuffle(seed)
        levels = tree(ctx, seed, deck)
        root = levels[-1][0]

        eq(name, "roster_hash", roster.hex(), o["roster_hash"])
        eq(name, "hand_ctx", ctx.hex(), o["hand_ctx"])
        eq(name, "salt_commitments", [c.hex() for c in commits], o["salt_commitments"])
        eq(name, "vrf_caller_seed", caller_seed.hex(), o["vrf_caller_seed"])
        eq(name, "shuffle_seed", seed.hex(), o["shuffle_seed"])
        eq(name, "drbg_first_16_words", words, o["drbg_first_16_words"])
        eq(name, "drbg_words_used_by_shuffle", used, o["drbg_words_used_by_shuffle"])
        eq(name, "deck", deck, o["deck"])
        eq(name, "empty_leaf_52", empty_leaf(52).hex(), o["empty_leaf_52"])
        eq(name, "merkle_root", root.hex(), o["merkle_root"])
        assert sorted(deck) == list(range(52)), f"{name}: deck is not a permutation"
        for p in o["proofs"]:
            pos = p["position"]
            sibs = proof(levels, pos)
            eq(name, f"proof[{pos}].leaf_salt", leaf_salt(seed, pos).hex(), p["leaf_salt"])
            eq(name, f"proof[{pos}].leaf", levels[0][pos].hex(), p["leaf"])
            eq(name, f"proof[{pos}].siblings", [s.hex() for s in sibs], p["siblings"])
            if not verify_card(root, ctx, pos, deck[pos], leaf_salt(seed, pos), [b(s) for s in p["siblings"]]):
                failures += 1
                print(f"MISMATCH {name} proof[{pos}] does not verify")
        n = len(i["seats"])
        for k, d in enumerate(o["deal"]):
            positions = [k, k + n, k + 2 * n]
            eq(name, f"deal[{k}].positions", positions, d["positions"])
            eq(name, f"deal[{k}].cards", [deck[p] for p in positions], d["cards"])
        print(f"{name}: {'ok' if failures == 0 else 'MISMATCH'}")

    print("all vectors match" if failures == 0 else f"{failures} mismatches")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
