// Same card encoding as crates/card-types: id = suit * 13 + (rank - 2),
// suits clubs 0, diamonds 1, hearts 2, spades 3; rank 14 = ace.
export const SUIT_GLYPH = ["♣", "♦", "♥", "♠"];
export const RANK_LABEL: Record<number, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};
export const cardRank = (id: number) => (id % 13) + 2;
export const cardSuit = (id: number) => Math.floor(id / 13);
export const card = (rank: number, suit: number) => suit * 13 + (rank - 2);
