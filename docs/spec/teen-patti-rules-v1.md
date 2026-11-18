# Teen Patti rules v1 — specification

- **Status:** **Signed off by the PM on 2026-11-19 (CF-014).** Implemented in
  `crates/teen-patti-core` (CF-015). Rows marked ⚑ were the choices
  confirmed at sign-off; changing any of them now means `rules_version = 2`.
- **Version:** `rules_version = 1`, bound into every hand context
  (CF-Fairness v2 §2).
- **Normative code:** `crates/teen-patti-core/src/rank.rs` (ranking) and
  `game.rs` (betting, settlement). Tests are in the same crate.

Amounts are lamports. "Stake" is the current bet in **blind terms**.

## 1. Table and deal

- 52 cards, no jokers; 2–6 players; 3 cards each, dealt in dealing order
  (CF-Fairness v2 §8).
- **Dealing order** starts with the seat left of the button. The first
  player in dealing order acts first. A new table's button is on the last
  seat (the first hand deals from seat 0); after every hand `next_hand` moves
  it to the seat that was dealt first (CF-024).
- **Boot:** fixed per table, collected from every dealt seat when the hand
  starts. A seat whose stack is below the boot is not dealt in.

## 2. Hand ranking

| # | Category | Rule |
| --- | --- | --- |
| 6 | Trail | three of a kind; AAA highest, 222 lowest |
| 5 | Pure sequence | sequence, all one suit |
| 4 | Sequence | three consecutive ranks |
| 3 | Color | all one suit, not a sequence |
| 2 | Pair | two of a kind |
| 1 | High card | anything else |

- **Sequence order ⚑:** A-K-Q highest, **A-2-3 second**, then K-Q-J down to
  4-3-2. No wrap-around: K-A-2 is not a sequence.
- **Tiebreaks:** color and high card compare highest card first, then the
  next; pair compares the pair rank, then the kicker; trail and sequences
  compare by their rank.
- **No suit ranking:** equal ranks are an exact tie.
- **Check:** over all 22,100 hands, the counts are 16,440 high card, 3,744
  pair, 1,096 color, 720 sequence, 48 pure sequence and 52 trail
  (unit-tested).

## 3. Betting

| Rule | v1 |
| --- | --- |
| Blind bet | 1× or 2× stake; the new stake = the amount bet |
| Seen bet | 2× or 4× stake; the new stake = half the amount bet |
| See | Any time while active; doesn't use the turn |
| Blind turn limit ⚑ | 4 blind bets, then the player must See before betting again |
| Chaal limit ⚑ | One bet ≤ 128 × boot |
| Pot limit ⚑ | When the pot reaches 1,024 × boot after a bet, all active players show; the best hand wins (ties split) |
| No all-in ⚑ | A bet larger than the stack is refused; the player must pack |
| Pack | Leaves the hand; if one player remains, they win without showing |
| Timeout ⚑ | 25 s per turn (`TURN_SECS`, PER unix clock); after it anyone may call `timeout_turn`: Pack for the player to act, reject for a pending Side Show target. Every action except See restarts the timer (CF-023) |
| Turn order | Next active seat in dealing order |

## 4. Show and Side Show

| Rule | v1 |
| --- | --- |
| Show | Only with exactly 2 active players; costs the caller's normal bet (blind: stake, seen: 2 × stake) |
| Show restriction ⚑ | A blind player can't force Show on a seen player |
| Show tie ⚑ | Exact tie splits the pot (the PRD's general tie rule) |
| Side Show | A seen player with ≥ 3 active players asks the **previous active** player, who must also be seen ⚑; costs 2 × stake |
| Side Show response | The target accepts or rejects; a timeout counts as reject |
| Side Show result | On accept the lower hand packs; on a tie the **requester** packs |
| After Side Show | The turn passes to the player after the requester |
| Privacy | After an **accepted** Side Show the two players may read each other's hand: `act` records the pair, and the permissionless `side_show_view` adds each one's session key to the other's reader list (at most 2 viewers per hand per seat). Revoked by `side_show_view(grant = false)` after the hand; `start_hand` refuses while any grant is live. No other way to grant exists (CF-022) |

## 5. Settlement

- **Rake** = pot × `rake_bps` / 10,000 (integer floor), capped at `rake_cap`
  and taken from the won pot only. Both values come from the table config;
  the program caps `rake_bps` at 1,000 (10%). Collected rake accrues in
  `TableRuntime.rake_owed` (swept to the treasury in P6).
- **Split pots:** the remainder is divided equally between the tied winners.
  Odd lamports go to the first tied winner in dealing order (the first seat
  clockwise from the button).
- **Conservation:** within a hand, stacks + pot is constant. At settlement,
  stacks + rake equals the starting total exactly. Tested over 20,000
  random hands.

## 6. Buy-in and table

| Rule | v1 |
| --- | --- |
| Buy-in ⚑ | 40× to 200× boot (and at least the rent-exempt minimum, ADR 0004); enforced by `configure_table` since CF-020 |
| Top-up | None during a hand |
| Table close | Idle 10 minutes or all seats empty |

## 7. Public action log (CF-021)

Every accepted action is appended, one byte each, to the public `HandLog`
(raw tail after the struct: `actions_hand_no` u64, `action_count` u16, then
the bytes). Byte = `seat << 4 | code << 1 | flag`; codes 0 See, 1 Chaal,
2 Pack, 3 Show, 4 Side Show request, 5 Side Show response, 6 Timeout. `flag`
= 1 for a Chaal of twice the minimum bet, or an accepted Side Show. Bet
amounts are implied by the state, so the log needs no amounts. At most
1,600 actions per hand (bounded by the pot limit).

At reveal the log also gets the rules (boot, rake), starting stacks and the
result (end reason, winners, payouts, rake). `cf-verify` (record format
`cf-hand-record/2`) replays the log with `teen-patti-core` on the rebuilt
deck and must reach exactly that result.

## 8. Normative details for independent implementations

These make the rules exact enough to re-implement without our code. The
frozen vectors (`docs/spec/vectors/teen-patti-rules-v1.json`) are checked by
`cargo test -p teen-patti-core --test vectors` and independently by
`pnpm check:rules` (`scripts/check_rules_vectors.py`, standard library only).

**Cards.** id = suit × 13 + (rank − 2), suits clubs 0, diamonds 1, hearts 2,
spades 3; rank 2..14 (14 = ace).

**Comparison key** (u32; higher wins, equal = exact tie) =
`category << 24 | a << 16 | b << 8 | c`, ranks sorted high to low (r0 ≥ r1 ≥ r2):

| Category (value) | a, b, c |
| --- | --- |
| Trail (6) | r0, 0, 0 |
| Pure sequence (5) / Sequence (4) | strength, 0, 0 (A-K-Q = 15, A-2-3 = 14, else r0) |
| Color (3) | r0, r1, r2 |
| Pair (2) | pair rank, kicker, 0 |
| High card (1) | r0, r1, r2 |

**State.** Per seat: dealt, active, seen, blind_turns, stack, contributed.
Table: order (dealing order), turn (index into order), stake, pot, phase
(betting / Side Show pending (requester, target) / over). Start: each seat in
order pays the boot (setup fails, `BadSetup`, with < 2 or > 6 seats, a
repeated seat, boot 0 or a stack below the boot); stake = boot; turn = 0.
`next active after i` searches order[i+1], order[i+2], … cyclically
(including i itself last); `previous active before i` searches order[i−1], …
cyclically, excluding i.

**Applying an action by seat s** — checks in this order; the first failure
is the error and nothing changes:

1. Hand over → `HandOver`. s ≥ 6 or s not active → `NotActive`.
2. **See**: already seen → `BadAmount`; else seen = true. Done (allowed any
   time, even during a pending Side Show; turn unchanged).
3. **Side Show pending** (requester R, target T): only T may act; a
   response from T, or a Timeout by T (= reject), is accepted; anything else
   → `SideShowPending`. Reject: turn = next active after R. Accept: if
   key(R) > key(T) then T packs, else R packs (tie: R); turn = next active
   after R.
4. A Side Show response with none pending → `NoSideShowPending`.
5. s is not order[turn] → `NotYourTurn`.
6. **Chaal x**: seen: x must be 2·stake or 4·stake (`BadAmount`), new stake =
   x / 2. Blind: blind_turns ≥ 4 → `MustSee`; x must be stake or 2·stake
   (`BadAmount`), new stake = x. Then pay x: x > 128·boot → `BadAmount`;
   x > stack → `InsufficientStack`. Blind: blind_turns + 1. If pot ≥
   1,024·boot: settle `pot_limit`, winners = best key among active seats.
   Else turn = next active after s.
7. **Pack / Timeout**: s inactive. One active seat left → settle
   `last_player` with it. Else turn = next active after s.
8. **Show**: active count ≠ 2 → `CannotShow`; opponent O = next active after
   s; s blind and O seen → `CannotShow`; pay the minimum bet (blind: stake,
   seen: 2·stake; same pay checks); settle `show`, winners = best key of s, O.
9. **Side Show request**: s not seen or < 3 active → `CannotSideShow`;
   target = previous active before s; target blind → `CannotSideShow`; pay
   2·stake; phase = pending (s, target); turn unchanged.

**Settle**: rake = min(⌊pot · rake_bps / 10,000⌋, rake_cap, pot); the rest
is split equally between winners; the remainder lamports go to the first
winner in dealing order; winners' stacks are credited; pot = 0.

**Replaying a log** (§7 encoding): decode each byte against the state before
it (undecodable: high bit set, seat ≥ 6, unknown code or flag → error
`BadEncoding` at that index), apply it (error at that index), and require
the hand to be over at the end (else `NotOver`, no index).

## 9. Sign-off checklist (CF-014) — all confirmed 2026-11-19

- [x] A-2-3 is the second-highest sequence
- [x] 4 blind turns, then See
- [x] Chaal limit 128 × boot; pot limit 1,024 × boot (forced show)
- [x] No all-in
- [x] Blind can't force Show on seen; Show tie splits the pot
- [x] Side Show target = the previous active player, who must be seen;
      requester packs on a tie
- [x] 25 s turn timer; timeout = pack
- [x] Buy-in 40–200 × boot
- [x] Rake rate and cap per table (values to be set by the business)
