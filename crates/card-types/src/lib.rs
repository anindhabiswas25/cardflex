//! Canonical card encoding for Card Flex.
//!
//! A card is one byte, `id = suit * 13 + (rank - 2)`, so ids run 0..=51.
//! This encoding is part of the fairness protocol: the shuffle, the Merkle
//! leaves and the verifier all use it, so it must never change without a new
//! protocol version.

#![no_std]
#![forbid(unsafe_code)]

/// Number of cards in a standard deck with no jokers.
pub const DECK_SIZE: usize = 52;

/// Card suit. Suits have no ranking in Teen Patti; the order only fixes ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Suit {
    Clubs = 0,
    Diamonds = 1,
    Hearts = 2,
    Spades = 3,
}

impl Suit {
    pub const ALL: [Suit; 4] = [Suit::Clubs, Suit::Diamonds, Suit::Hearts, Suit::Spades];
}

/// Card rank, valued 2..=14 (Ace high). Ace-low sequences are a rules-engine
/// concern, not an encoding concern.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Rank(u8);

impl Rank {
    pub const TWO: Rank = Rank(2);
    pub const ACE: Rank = Rank(14);

    /// Returns `None` unless `value` is in 2..=14.
    pub const fn new(value: u8) -> Option<Rank> {
        if value >= 2 && value <= 14 {
            Some(Rank(value))
        } else {
            None
        }
    }

    pub const fn value(self) -> u8 {
        self.0
    }
}

/// A playing card, stored as its canonical id.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Card(u8);

/// Error for a byte that is not a valid card id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidCardId(pub u8);

impl Card {
    pub const fn new(suit: Suit, rank: Rank) -> Card {
        Card(suit as u8 * 13 + (rank.0 - 2))
    }

    pub const fn from_id(id: u8) -> Result<Card, InvalidCardId> {
        if (id as usize) < DECK_SIZE {
            Ok(Card(id))
        } else {
            Err(InvalidCardId(id))
        }
    }

    pub const fn id(self) -> u8 {
        self.0
    }

    pub const fn suit(self) -> Suit {
        Suit::ALL[(self.0 / 13) as usize]
    }

    pub const fn rank(self) -> Rank {
        Rank(self.0 % 13 + 2)
    }
}

/// The unshuffled deck in canonical id order (0..=51).
pub const fn ordered_deck() -> [Card; DECK_SIZE] {
    let mut deck = [Card(0); DECK_SIZE];
    let mut i = 0;
    while i < DECK_SIZE {
        deck[i] = Card(i as u8);
        i += 1;
    }
    deck
}

/// True when `cards` holds exactly the 52 distinct valid cards.
pub fn is_complete_deck(cards: &[Card]) -> bool {
    if cards.len() != DECK_SIZE {
        return false;
    }
    let mut seen = 0u64;
    for card in cards {
        let bit = 1u64 << card.0;
        if card.0 as usize >= DECK_SIZE || seen & bit != 0 {
            return false;
        }
        seen |= bit;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_round_trips_for_every_card() {
        for suit in Suit::ALL {
            for v in 2..=14 {
                let card = Card::new(suit, Rank::new(v).unwrap());
                assert_eq!(card.suit(), suit);
                assert_eq!(card.rank().value(), v);
                assert_eq!(Card::from_id(card.id()), Ok(card));
            }
        }
    }

    #[test]
    fn encoding_is_frozen() {
        // Test vectors: changing any of these is a protocol version change.
        assert_eq!(Card::new(Suit::Clubs, Rank::TWO).id(), 0);
        assert_eq!(Card::new(Suit::Clubs, Rank::ACE).id(), 12);
        assert_eq!(Card::new(Suit::Diamonds, Rank::TWO).id(), 13);
        assert_eq!(Card::new(Suit::Spades, Rank::ACE).id(), 51);
    }

    #[test]
    fn rejects_invalid_values() {
        assert_eq!(Card::from_id(52), Err(InvalidCardId(52)));
        assert_eq!(Rank::new(1), None);
        assert_eq!(Rank::new(15), None);
    }

    #[test]
    fn ordered_deck_is_complete() {
        assert!(is_complete_deck(&ordered_deck()));
    }

    #[test]
    fn detects_duplicates_and_wrong_length() {
        let mut deck = ordered_deck();
        deck[51] = deck[0];
        assert!(!is_complete_deck(&deck));
        assert!(!is_complete_deck(&ordered_deck()[..51]));
    }
}
