// Same card encoding as crates/card-types: id = suit * 13 + (rank - 2),
// suits clubs 0, diamonds 1, hearts 2, spades 3; rank 14 = ace.
export const cardRank = (id: number) => (id % 13) + 2;
export const cardSuit = (id: number) => Math.floor(id / 13);
export const card = (rank: number, suit: number) => suit * 13 + (rank - 2);

/** The card art in public/cards/ (e.g. "/cards/As.webp", "/cards/10h.webp"). */
const ART_SUIT = ["c", "d", "h", "s"];
const ART_RANK: Record<number, string> = { 11: "J", 12: "Q", 13: "K", 14: "A" };
export const cardArt = (id: number) => `/cards/${ART_RANK[cardRank(id)] ?? cardRank(id)}${ART_SUIT[cardSuit(id)]}.webp`;
