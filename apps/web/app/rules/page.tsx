import { PlayingCard } from "@/components/PlayingCard";
import { TopBar } from "@/components/TopBar";
import { card } from "@/lib/cards";

// Summary of docs/spec/teen-patti-rules-v1.md (signed off 2026-11-19).
const RANKS = [
  { name: "Trail", note: "Three of a kind. AAA highest, 222 lowest.", cards: [card(14, 0), card(14, 2), card(14, 3)] },
  { name: "Pure sequence", note: "Three in a row, same suit.", cards: [card(14, 3), card(13, 3), card(12, 3)] },
  { name: "Sequence", note: "Three in a row. A-K-Q highest, A-2-3 second.", cards: [card(14, 1), card(2, 0), card(3, 3)] },
  { name: "Color", note: "Same suit, not in a row.", cards: [card(13, 2), card(9, 2), card(4, 2)] },
  { name: "Pair", note: "Two of a kind; the pair, then the third card.", cards: [card(10, 0), card(10, 1), card(7, 3)] },
  { name: "High card", note: "Anything else; highest card first.", cards: [card(14, 0), card(10, 2), card(6, 1)] },
];

const PLAY = [
  ["Boot", "Everyone puts in the boot when the hand is dealt."],
  ["Blind or Seen", "Play blind without looking, or See your cards any time. Blind bets 1× or 2× the stake; Seen bets 2× or 4×. After 4 blind bets you must See."],
  ["Chaal", "Your bet. One bet is at most 128 boots. There is no all-in: if you can't cover the bet, you pack."],
  ["Pack", "Fold and leave the hand. The last player left wins the pot without showing."],
  ["Show", "With exactly two players left, pay the normal bet to compare hands. A blind player can't force a Show on a Seen player. Exact ties split the pot."],
  ["Side Show", "A Seen player asks the previous Seen player to compare privately. If they accept, the lower hand packs (the asker packs on a tie). Only the two of them see each other's cards."],
  ["Pot limit", "When the pot reaches 1,024 boots, every player left shows and the best hand wins."],
  ["Timer", "25 seconds per turn. Running out counts as Pack (or refusing a Side Show)."],
];

export default function Rules() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="font-[family-name:var(--font-display)] text-4xl sm:text-5xl">Rules</h1>
        <p className="text-violet-300">Teen Patti, rules version 1. The program enforces exactly these rules; anyone can replay a hand to check.</p>

        <section className="mt-8">
          <h2 className="font-[family-name:var(--font-display)] text-2xl">Hand rankings</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {RANKS.map((r, i) => (
              <div key={r.name} className="glass flex items-center gap-4 rounded-3xl p-4">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-b from-amber-300 to-amber-600 font-black text-amber-950">{i + 1}</span>
                <div className="flex shrink-0">
                  {r.cards.map((c, k) => (
                    <PlayingCard key={k} id={c} width="2.6rem" rotate={(k - 1) * 10} className={k ? "-ml-4" : ""} />
                  ))}
                </div>
                <div>
                  <p className="font-[family-name:var(--font-display)] text-lg">{r.name}</p>
                  <p className="text-sm text-violet-200">{r.note}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-violet-300">No suit ranking: equal hands are an exact tie and split the pot (odd lamports to the first winner after the dealer).</p>
        </section>

        <section className="mt-10">
          <h2 className="font-[family-name:var(--font-display)] text-2xl">How a hand plays</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {PLAY.map(([t, d]) => (
              <div key={t} className="glass rounded-3xl p-5">
                <p className="font-[family-name:var(--font-display)] text-xl text-lime-300">{t}</p>
                <p className="mt-1 text-sm leading-relaxed text-violet-100">{d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="glass mt-10 rounded-3xl p-6">
          <h2 className="font-[family-name:var(--font-display)] text-2xl">Money</h2>
          <p className="mt-2 text-sm leading-relaxed text-violet-100">Buy in for 40 to 200 boots. Rake is taken only from won pots, at the table&apos;s rate and cap. Leave any time: you finish the current hand, then cash out your stack to the wallet you bought in with. If the table&apos;s private rollup ever stops, everyone can claim back their last synced stack.</p>
        </section>
      </main>
    </>
  );
}
