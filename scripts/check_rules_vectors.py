#!/usr/bin/env python3
"""Independent check of the Teen Patti rules v1 test vectors.

Re-implements docs/spec/teen-patti-rules-v1.md (sections 2-8) using only the
Python standard library and compares every value with
docs/spec/vectors/teen-patti-rules-v1.json, which the Rust crate generates.
If the two agree, the spec is complete enough to replay hands without our
Rust code. Exit status 0 = all match.
"""

import itertools
import json
import sys
from pathlib import Path

VECTORS = Path(__file__).resolve().parent.parent / "docs/spec/vectors/teen-patti-rules-v1.json"
MAX_SEATS = 6
CATEGORY = {6: "trail", 5: "pure_sequence", 4: "sequence", 3: "color", 2: "pair", 1: "high_card"}


# ---------------------------------------------------------------- ranking (§2, §8)

def rank_of(card_id):
    return card_id % 13 + 2


def suit_of(card_id):
    return card_id // 13


def key(cards):
    r = sorted((rank_of(c) for c in cards), reverse=True)
    same_suit = len({suit_of(c) for c in cards}) == 1
    if r[0] == r[1] == r[2]:
        return 6 << 24 | r[0] << 16
    if r == [14, 13, 12]:
        strength = 15
    elif r == [14, 3, 2]:
        strength = 14
    elif r[0] == r[1] + 1 and r[1] == r[2] + 1:
        strength = r[0]
    else:
        strength = None
    if strength is not None:
        return (5 if same_suit else 4) << 24 | strength << 16
    if same_suit:
        return 3 << 24 | r[0] << 16 | r[1] << 8 | r[2]
    if r[0] == r[1]:
        return 2 << 24 | r[0] << 16 | r[2] << 8
    if r[1] == r[2]:
        return 2 << 24 | r[1] << 16 | r[0] << 8
    return 1 << 24 | r[0] << 16 | r[1] << 8 | r[2]


# ---------------------------------------------------------------- game (§3-§8)

class RuleError(Exception):
    pass


class Hand:
    def __init__(self, boot: int, rake_bps: int, rake_cap: int, stacks: dict, order: list, keys: dict):
        if not 2 <= len(order) <= MAX_SEATS or len(set(order)) != len(order) or boot == 0:
            raise RuleError("BadSetup")
        if any(s >= MAX_SEATS or stacks[s] < boot for s in order):
            raise RuleError("BadSetup")
        self.boot: int = boot
        self.rake_bps: int = rake_bps
        self.rake_cap: int = rake_cap
        self.order, self.keys = list(order), keys
        self.seat = {s: {"active": True, "seen": False, "blind": 0, "stack": stacks[s] - boot} for s in order}
        self.pot: int = boot * len(order)
        self.stake: int = boot
        self.turn = 0
        self.pending = None  # (requester, target)
        self.over = None  # (reason, winners, payouts, rake)

    # helpers
    def active(self, s):
        return s in self.seat and self.seat[s]["active"]

    def active_count(self):
        return sum(1 for s in self.order if self.seat[s]["active"])

    def next_active_after(self, i):
        n = len(self.order)
        for d in range(1, n + 1):
            j = (i + d) % n
            if self.seat[self.order[j]]["active"]:
                return j
        return i

    def prev_active_before(self, i):
        n = len(self.order)
        for d in range(1, n):
            j = (i - d) % n
            if self.seat[self.order[j]]["active"]:
                return j
        return i

    def min_bet(self, s):
        return 2 * self.stake if self.seat[s]["seen"] else self.stake

    def pay(self, s, x):
        if x > 128 * self.boot:
            raise RuleError("BadAmount")
        if x > self.seat[s]["stack"]:
            raise RuleError("InsufficientStack")
        self.seat[s]["stack"] -= x
        self.pot += x

    def best(self, seats):
        top = max(self.keys[s] for s in seats)
        return [s for s in seats if self.keys[s] == top]

    def settle(self, reason, winners):
        rake = min(self.pot * self.rake_bps // 10_000, self.rake_cap, self.pot)
        dist = self.pot - rake
        share, rem = divmod(dist, len(winners))
        payouts = {s: 0 for s in self.order}
        for s in self.order:  # remainder to the first winner in dealing order
            if s in winners:
                payouts[s] = share + rem
                rem = 0
        for s, p in payouts.items():
            self.seat[s]["stack"] += p
        self.pot = 0
        self.over = (reason, sorted(winners), [payouts[s] for s in self.order], rake)

    # §8 step by step
    def apply(self, s, action, arg=None):
        if self.over:
            raise RuleError("HandOver")
        if s >= MAX_SEATS or not self.active(s):
            raise RuleError("NotActive")
        st = self.seat[s]
        if action == "see":
            if st["seen"]:
                raise RuleError("BadAmount")
            st["seen"] = True
            return
        if self.pending:
            req, tgt = self.pending
            if s == tgt and action == "respond":
                accept = arg
            elif s == tgt and action == "timeout":
                accept = False
            else:
                raise RuleError("SideShowPending")
            self.pending = None
            req_idx = self.order.index(req)
            if accept:
                packed = tgt if self.keys[req] > self.keys[tgt] else req
                self.seat[packed]["active"] = False
            self.turn = self.next_active_after(req_idx)
            return
        if action == "respond":
            raise RuleError("NoSideShowPending")
        idx = self.turn
        if self.order[idx] != s:
            raise RuleError("NotYourTurn")
        if action == "chaal":
            x = int(arg or 0)
            if st["seen"]:
                if x not in (2 * self.stake, 4 * self.stake):
                    raise RuleError("BadAmount")
                new_stake = x // 2
            else:
                if st["blind"] >= 4:
                    raise RuleError("MustSee")
                if x not in (self.stake, 2 * self.stake):
                    raise RuleError("BadAmount")
                new_stake = x
            self.pay(s, x)
            if not st["seen"]:
                st["blind"] += 1
            self.stake = new_stake
            if self.pot >= 1_024 * self.boot:
                self.settle("pot_limit", self.best([p for p in self.order if self.seat[p]["active"]]))
            else:
                self.turn = self.next_active_after(idx)
        elif action in ("pack", "timeout"):
            st["active"] = False
            if self.active_count() == 1:
                self.settle("last_player", [p for p in self.order if self.seat[p]["active"]])
            else:
                self.turn = self.next_active_after(idx)
        elif action == "show":
            if self.active_count() != 2:
                raise RuleError("CannotShow")
            opp = self.order[self.next_active_after(idx)]
            if not st["seen"] and self.seat[opp]["seen"]:
                raise RuleError("CannotShow")
            self.pay(s, self.min_bet(s))
            self.settle("show", self.best([s, opp]))
        elif action == "request":
            if not st["seen"] or self.active_count() < 3:
                raise RuleError("CannotSideShow")
            tgt = self.order[self.prev_active_before(idx)]
            if not self.seat[tgt]["seen"]:
                raise RuleError("CannotSideShow")
            self.pay(s, 2 * self.stake)
            self.pending = (s, tgt)

    def decode(self, b):
        """§7: seat << 4 | code << 1 | flag, against the state before it."""
        seat, code, flag = b >> 4, (b >> 1) & 7, b & 1
        if b & 0x80 or seat >= MAX_SEATS:
            return None
        if code == 1:
            base = 2 * self.stake if (seat in self.seat and self.seat[seat]["seen"]) else self.stake
            return seat, "chaal", base << flag
        if code == 5:
            return seat, "respond", flag == 1
        names = {0: "see", 2: "pack", 3: "show", 4: "request", 6: "timeout"}
        if code in names and flag == 0:
            return seat, names[code], None
        return None


def replay(case):
    order = case["order"]
    stacks = {s: 0 for s in range(MAX_SEATS)}
    keys = {}
    for k, s in enumerate(order):
        stacks[s] = int(case["stacks"][k])
        keys[s] = key(case["hands"][k])
    try:
        h = Hand(int(case["boot"]), case["rake_bps"], int(case["rake_cap"]), stacks, order, keys)
    except RuleError as e:
        return {"error": str(e), "error_index": None}
    log = bytes.fromhex(case["actions"])
    for i, b in enumerate(log):
        d = h.decode(b)
        if d is None:
            return {"error": "BadEncoding", "error_index": i}
        try:
            h.apply(*d)
        except RuleError as e:
            return {"error": str(e), "error_index": i}
    if not h.over:
        return {"error": "NotOver", "error_index": None}
    reason, winners, payouts, rake = h.over
    return {
        "end_reason": reason,
        "winners": winners,
        "payouts": [str(p) for p in payouts],
        "rake": str(rake),
        "final_stacks": [str(h.seat[s]["stack"]) for s in order],
    }


def main():
    v = json.loads(VECTORS.read_text())
    failures = 0
    assert v["rules_version"] == 1

    counts = {name: 0 for name in CATEGORY.values()}
    for hand in itertools.combinations(range(52), 3):
        counts[CATEGORY[key(hand) >> 24]] += 1
    if counts != v["category_counts"]:
        print(f"category counts differ: {counts} vs {v['category_counts']}")
        failures += 1

    for c in v["ranking"]:
        k = key(c["cards"])
        if k != c["key"] or CATEGORY[k >> 24] != c["category"]:
            print(f"ranking {c['name']}: got {k} ({CATEGORY[k >> 24]}), vector {c['key']} ({c['category']})")
            failures += 1

    for c in v["games"]:
        got = replay(c)
        want = dict(c["expect"])
        if "winners" in want:
            want["winners"] = sorted(want["winners"])
        if got != want:
            print(f"{c['name']}:\n  got    {got}\n  vector {want}")
            failures += 1

    total = 1 + len(v["ranking"]) + len(v["games"])
    if failures:
        print(f"{failures} of {total} vector groups differ")
        return 1
    print(f"all rules vectors match ({len(v['ranking'])} hands ranked, {len(v['games'])} games replayed, category counts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
