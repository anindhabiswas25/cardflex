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
  player in dealing order acts first. (Moving the button each hand comes in
  P5. P2 fixed it at seat 0.)
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
| Timeout ⚑ | Acts as Pack for the player to act (25 s per turn; the crank arrives in P5) |
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
| Privacy | During Side Show the two players may read each other's hand (CF-007 `set_hand_readers`, owner consent); P5 drives this from these rules |

## 5. Settlement

- **Rake** = pot × `rake_bps` / 10,000 (integer floor), capped at `rake_cap`
  and taken from the won pot only. Both values come from the table config;
  the program enforces a maximum (P6).
- **Split pots:** the remainder is divided equally between the tied winners.
  Odd lamports go to the first tied winner in dealing order (the first seat
  clockwise from the button).
- **Conservation:** within a hand, stacks + pot is constant. At settlement,
  stacks + rake equals the starting total exactly. Tested over 20,000
  random hands.

## 6. Buy-in and table (enforced in P6, listed here for sign-off)

| Rule | v1 |
| --- | --- |
| Buy-in ⚑ | 40× to 200× boot (and at least the rent-exempt minimum, ADR 0004) |
| Top-up | None during a hand |
| Table close | Idle 10 minutes or all seats empty |

## 7. Sign-off checklist (CF-014) — all confirmed 2026-11-19

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
