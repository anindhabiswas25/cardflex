//! Hand ranking, rules v1 (docs/spec/teen-patti-rules-v1.md §2).
//!
//! Every 3-card hand maps to a [`HandRank`] whose integer key orders hands
//! completely: a higher key wins, equal keys tie. There is no suit ranking.

use card_types::Card;

/// Hand categories, highest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Category {
    HighCard = 1,
    Pair = 2,
    Color = 3,
    Sequence = 4,
    PureSequence = 5,
    Trail = 6,
}

/// Total order over 3-card hands. `key` = category in the top byte, then
/// three tiebreak bytes compared most significant first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HandRank {
    pub key: u32,
}

impl HandRank {
    pub fn category(self) -> Category {
        match self.key >> 24 {
            6 => Category::Trail,
            5 => Category::PureSequence,
            4 => Category::Sequence,
            3 => Category::Color,
            2 => Category::Pair,
            _ => Category::HighCard,
        }
    }
}

const fn key(cat: Category, a: u8, b: u8, c: u8) -> u32 {
    ((cat as u32) << 24) | ((a as u32) << 16) | ((b as u32) << 8) | c as u32
}

/// Sequence strength (rules v1 §2.2): A-K-Q highest, A-2-3 second, then
/// K-Q-J down to 4-3-2. `None` if the ranks are not a sequence. Ranks are
/// sorted descending. There is no wrap-around (K-A-2 is not a sequence).
fn sequence_strength(r: [u8; 3]) -> Option<u8> {
    match r {
        [14, 13, 12] => Some(15),                         // A-K-Q
        [14, 3, 2] => Some(14),                           // A-2-3
        [h, m, l] if h == m + 1 && m == l + 1 => Some(h), // K-Q-J = 13 … 4-3-2 = 4
        _ => None,
    }
}

/// Ranks one hand.
pub fn evaluate(cards: [Card; 3]) -> HandRank {
    let mut r = cards.map(|c| c.rank().value());
    r.sort_unstable_by(|a, b| b.cmp(a));
    let same_suit = cards[0].suit() == cards[1].suit() && cards[1].suit() == cards[2].suit();

    if r[0] == r[1] && r[1] == r[2] {
        return HandRank {
            key: key(Category::Trail, r[0], 0, 0),
        };
    }
    if let Some(s) = sequence_strength(r) {
        let cat = if same_suit {
            Category::PureSequence
        } else {
            Category::Sequence
        };
        return HandRank {
            key: key(cat, s, 0, 0),
        };
    }
    if same_suit {
        return HandRank {
            key: key(Category::Color, r[0], r[1], r[2]),
        };
    }
    if r[0] == r[1] {
        return HandRank {
            key: key(Category::Pair, r[0], r[2], 0),
        };
    }
    if r[1] == r[2] {
        return HandRank {
            key: key(Category::Pair, r[1], r[0], 0),
        };
    }
    HandRank {
        key: key(Category::HighCard, r[0], r[1], r[2]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_types::{Rank, Suit};

    fn c(rank: u8, suit: Suit) -> Card {
        Card::new(suit, Rank::new(rank).unwrap())
    }
    use Suit::{Clubs as C, Diamonds as D, Hearts as H, Spades as S};

    #[test]
    fn category_order() {
        let trail = evaluate([c(2, C), c(2, D), c(2, H)]);
        let pure = evaluate([c(14, S), c(13, S), c(12, S)]);
        let seq = evaluate([c(14, S), c(13, H), c(12, S)]);
        let color = evaluate([c(14, S), c(13, S), c(10, S)]);
        let pair = evaluate([c(14, S), c(14, H), c(13, S)]);
        let high = evaluate([c(14, S), c(13, H), c(11, S)]);
        assert!(trail > pure && pure > seq && seq > color && color > pair && pair > high);
        assert_eq!(trail.category(), Category::Trail);
        assert_eq!(high.category(), Category::HighCard);
    }

    #[test]
    fn sequence_order_akq_then_a23_then_kqj() {
        let akq = evaluate([c(14, S), c(13, H), c(12, D)]);
        let a23 = evaluate([c(14, S), c(2, H), c(3, D)]);
        let kqj = evaluate([c(13, S), c(12, H), c(11, D)]);
        let low = evaluate([c(4, S), c(3, H), c(2, D)]);
        assert!(akq > a23 && a23 > kqj && kqj > low);
        assert_eq!(a23.category(), Category::Sequence);
        // No wrap-around.
        assert_eq!(
            evaluate([c(13, S), c(14, H), c(2, D)]).category(),
            Category::HighCard
        );
    }

    #[test]
    fn ties_and_tiebreaks() {
        // No suit ranking: identical ranks tie.
        assert_eq!(
            evaluate([c(14, S), c(13, H), c(11, S)]),
            evaluate([c(14, D), c(13, C), c(11, H)])
        );
        // Pair: pair rank first, then kicker.
        assert!(evaluate([c(9, S), c(9, H), c(2, D)]) > evaluate([c(8, S), c(8, H), c(14, D)]));
        assert!(evaluate([c(9, S), c(9, H), c(5, D)]) > evaluate([c(9, C), c(9, D), c(4, S)]));
        // High card / color: compare highest down.
        assert!(evaluate([c(14, S), c(10, H), c(2, D)]) > evaluate([c(14, D), c(9, C), c(8, H)]));
        assert!(evaluate([c(13, S), c(11, S), c(9, S)]) > evaluate([c(13, D), c(11, D), c(8, D)]));
    }

    #[test]
    fn category_counts_match_teen_patti_combinatorics() {
        // Over all C(52,3) = 22,100 hands.
        let mut counts = [0usize; 7];
        for a in 0..52u8 {
            for b in a + 1..52 {
                for d in b + 1..52 {
                    let h = [a, b, d].map(|i| Card::from_id(i).unwrap());
                    counts[evaluate(h).category() as usize] += 1;
                }
            }
        }
        // High, Pair, Color, Sequence, Pure sequence, Trail.
        assert_eq!(&counts[1..], &[16_440, 3_744, 1_096, 720, 48, 52]);
    }
}
