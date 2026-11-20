import { HeroLive, LobbySection } from "@/components/Lobby";
import { Logo } from "@/components/Logo";
import { PlayingCard } from "@/components/PlayingCard";
import { TopBar } from "@/components/TopBar";
import { card } from "@/lib/cards";

const FEATURES = [
  { title: "Only you see your cards", body: "Cards are dealt inside MagicBlock's private rollup on Intel TDX hardware. Your session key is the only reader of your hand. The hardware and its operator are trusted; we say so.", icon: "🂠" },
  { title: "Verify every hand", body: "Every finished hand publishes its salts, randomness and action log. Anyone can rebuild the deck and replay the betting to check the winner, payouts and rake.", icon: "✓" },
  { title: "Your money stays on Solana", body: "Buy-ins sit in a table vault on Solana. If the rollup ever stops, every player can claim back their last synced stack. No redeal, ever.", icon: "◎" },
];

export default function Home() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        {/* ---------- hero ---------- */}
        <section className="grid items-center gap-10 pt-10 md:grid-cols-[1.1fr_1fr] md:pt-16">
          <div>
            <span className="pill text-xs uppercase tracking-widest text-violet-200">
              <span className="live-dot ml-1.5" />
              Teen Patti · live on Solana devnet
            </span>
            <h1 className="mt-5 font-[family-name:var(--font-display)] text-5xl leading-[0.95] text-white drop-shadow-[0_6px_0_#3b0764] sm:text-7xl">
              Play Blind.
              <br />
              <span className="text-lime-300">Play Bold.</span>
            </h1>
            <p className="mt-3 max-w-md text-base text-violet-200 sm:text-lg">
              Teen Patti on Solana with private cards, instant moves without wallet pop-ups, and a shuffle anyone can check after every hand.
            </p>
            <HeroLive />
          </div>

          {/* Hero art: crest over a fanned pure sequence on a mini felt. */}
          <div className="relative mx-auto aspect-square w-full max-w-md">
            <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(circle,#7c3aed_0%,#4c1d95_45%,transparent_70%)] opacity-70 blur-2xl" />
            <div className="absolute inset-x-[4%] bottom-[27%] h-[38%] rounded-[50%] bg-[radial-gradient(ellipse_at_50%_35%,#6d5ce0,#2a1f7a_75%)] shadow-[inset_0_10px_30px_rgba(10,4,40,.7),0_0_0_10px_#7e22ce,0_0_0_14px_#2e1065,0_30px_60px_rgba(0,0,0,.6),0_0_70px_rgba(192,38,211,.45)]" />
            <div className="absolute bottom-[43%] left-1/2 flex -translate-x-1/2 items-end">
              {[card(14, 3), card(13, 3), card(12, 3)].map((c, k) => (
                <div key={c} className={`card-float ${k ? "-ml-10" : ""}`} style={{ animationDelay: `${k * 0.45}s`, marginBottom: k === 1 ? "1.2rem" : 0 }}>
                  <PlayingCard id={c} width="clamp(5rem, 13vw, 7rem)" rotate={(k - 1) * 13} />
                </div>
              ))}
            </div>
            {/* Soft shadow on the felt that breathes with the cards. */}
            <div className="card-shadow absolute bottom-[38%] left-1/2 h-6 w-[46%] -translate-x-1/2 rounded-[50%] bg-black/45 blur-md" />
            <span className="pill absolute bottom-[25%] left-1/2 -translate-x-1/2 whitespace-nowrap text-sm text-amber-200">★ Pure sequence · A-K-Q</span>
          </div>
        </section>

        {/* ---------- lobby ---------- */}
        <LobbySection limit={6} />

        {/* ---------- fairness ---------- */}
        <section id="fair" className="mt-20 scroll-mt-8">
          <h2 className="text-center font-[family-name:var(--font-display)] text-3xl sm:text-4xl">Fair by design, checkable by anyone</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="glass rounded-3xl p-6">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-b from-fuchsia-400 to-violet-700 text-2xl shadow-[inset_0_2px_0_rgba(255,255,255,.35),0_8px_20px_rgba(0,0,0,.35)]">{f.icon}</span>
                <h3 className="mt-4 font-[family-name:var(--font-display)] text-xl">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-violet-200">{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-16 flex flex-col items-center gap-2 text-center text-xs text-violet-300/70">
          <Logo />
          <p>Card Flex · Devnet preview · Play responsibly. 18+.</p>
        </footer>
      </main>
    </>
  );
}
