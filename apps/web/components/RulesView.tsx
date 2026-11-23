"use client";

// Rules page in the landing page's style. Content = rules v1
// (docs/spec/teen-patti-rules-v1.md), cut to the fewest words; the card art
// (public/cards/) does the explaining.
import Link from "next/link";
import { useEffect, useRef } from "react";
import { card, cardArt as src } from "@/lib/cards";
import { Sol } from "./Sol";

const RANKS = [
  { name: "Trail", tip: "Three of a kind", cards: [card(14, 0), card(14, 2), card(14, 3)] },
  { name: "Pure Sequence", tip: "A run, one suit", cards: [card(12, 3), card(13, 3), card(14, 3)] },
  { name: "Sequence", tip: "A run, any suits", cards: [card(14, 1), card(2, 0), card(3, 3)] },
  { name: "Color", tip: "One suit", cards: [card(4, 2), card(9, 2), card(13, 2)] },
  { name: "Pair", tip: "Two of a kind", cards: [card(10, 0), card(10, 1), card(7, 3)] },
  { name: "High Card", tip: "Highest card wins", cards: [card(6, 1), card(10, 2), card(14, 0)] },
];

const STEPS = [
  { t: "Boot", d: "Everyone antes in.", icon: <Sol size="22px" /> },
  { t: "Deal", d: "Three cards each, face down.", icon: "back" },
  { t: "Blind or Seen", d: "Blind bets 1–2×. Seen bets 2–4×.", icon: "◐" },
  { t: "Chaal or Pack", d: "Bet to stay in, or fold.", icon: "⇅" },
  { t: "Show", d: "Two left? Flip and compare.", icon: "♠" },
];

const QUICK = [
  ["25s", "per turn"],
  ["4", "blind bets, then See"],
  ["128", "boots max bet"],
  ["1,024", "boots pot limit: all show"],
  ["40–200", "boots buy-in"],
  ["Tie", "splits the pot"],
];

const FAIR = [
  { t: "Only you see your cards", d: "Dealt inside a TEE. The hardware and its operator are trusted.", icon: "♥" },
  { t: "Every hand checkable", d: "Replay the deck and the bets after the hand.", icon: "✓" },
  { t: "Money stays on Solana", d: "In the table vault. Claim it back if the rollup stops.", icon: <Sol size="20px" /> },
];

function Fan({ ids, size = "md" }: { ids: number[]; size?: "sm" | "md" | "lg" }) {
  return (
    <div className={`rp-fan rp-fan-${size}`}>
      {ids.map((id, i) => (
        <img key={i} src={src(id)} alt="" width={300} height={440} style={{ "--i": i - (ids.length - 1) / 2 } as React.CSSProperties} />
      ))}
    </div>
  );
}

export function RulesView() {
  const root = useRef<HTMLDivElement>(null);
  // Sections rise in as they scroll into view.
  useEffect(() => {
    const els = root.current?.querySelectorAll(".rp-reveal") ?? [];
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("is-in"), io.unobserve(e.target))),
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <div className="rp" ref={root}>
      {/* ---------- hero ---------- */}
      <section className="rp-hero">
        <div className="rp-hero-text">
          <span className="rp-eyebrow">How to play</span>
          <h1>
            <small>THREE CARDS.</small>
            BEST HAND WINS.
          </h1>
          <p>Bet, bluff, outlast the table.</p>
          <div className="rp-hero-cta">
            <Link href="/tables" className="rp-btn">
              <span>▶</span>Play now
            </Link>
            <a href="#ranks" className="rp-link">
              Hand rankings ↓
            </a>
          </div>
        </div>
        <div className="rp-hero-art">
          <span className="rp-glow" />
          <Fan ids={[card(12, 1), card(14, 3), card(13, 2)]} size="lg" />
        </div>
      </section>

      {/* ---------- hand rankings ---------- */}
      <section id="ranks" className="rp-sec">
        <header className="rp-head rp-reveal">
          <span className="rp-eyebrow">Hand rankings</span>
          <h2>Best to worst</h2>
        </header>
        <div className="rp-ranks">
          {RANKS.map((r, i) => (
            <div key={r.name} className="rp-rank rp-reveal" style={{ transitionDelay: `${i * 0.06}s` }}>
              <span className="rp-no">{String(i + 1).padStart(2, "0")}</span>
              <Fan ids={r.cards} />
              <div className="rp-rank-txt">
                <h3>{r.name}</h3>
                <p>{r.tip}</p>
              </div>
              {i === 0 && <span className="rp-tag">Best</span>}
            </div>
          ))}
        </div>
        <p className="rp-note rp-reveal">
          <b>A‑K‑Q</b> top run · <b>A‑2‑3</b> second · no suit beats another
        </p>
      </section>

      {/* ---------- a hand, step by step ---------- */}
      <section className="rp-sec">
        <header className="rp-head rp-reveal">
          <span className="rp-eyebrow">A hand</span>
          <h2>Five moves</h2>
        </header>
        <ol className="rp-steps">
          {STEPS.map((s, i) => (
            <li key={s.t} className="rp-step rp-reveal" style={{ transitionDelay: `${i * 0.07}s` }}>
              <span className="rp-step-ico">
                {s.icon === "back" ? (
                  <span className="rp-backs">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  s.icon
                )}
              </span>
              <em>{String(i + 1).padStart(2, "0")}</em>
              <h3>{s.t}</h3>
              <p>{s.d}</p>
            </li>
          ))}
        </ol>

        <div className="rp-side rp-reveal">
          <div className="rp-side-text">
            <h3>Side Show</h3>
            <p>Seen? Ask the last Seen player to compare in private. Lower hand packs.</p>
          </div>
          <div className="rp-vs">
            <div className="rp-hand is-out">
              <Fan ids={[card(12, 3), card(12, 1), card(7, 0)]} size="sm" />
              <span>Pair · packs</span>
            </div>
            <b>VS</b>
            <div className="rp-hand is-win">
              <Fan ids={[card(4, 2), card(9, 2), card(13, 2)]} size="sm" />
              <span>Color · stays</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- quick numbers ---------- */}
      <section className="rp-sec">
        <div className="rp-quick">
          {QUICK.map(([n, l], i) => (
            <div key={l} className="rp-q rp-reveal" style={{ transitionDelay: `${i * 0.05}s` }}>
              <b>{n}</b>
              <span>{l}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- fairness ---------- */}
      <section id="fair" className="rp-sec">
        <header className="rp-head rp-reveal">
          <span className="rp-eyebrow">How it’s fair</span>
          <h2>Private cards. Open shuffle.</h2>
        </header>
        <div className="rp-fair">
          {FAIR.map((f, i) => (
            <div key={f.t} className="rp-fair-card rp-reveal" style={{ transitionDelay: `${i * 0.07}s` }}>
              <span>{f.icon}</span>
              <h3>{f.t}</h3>
              <p>{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- call to action ---------- */}
      <section className="rp-cta rp-reveal">
        <Fan ids={[card(12, 2), card(13, 0), card(11, 1)]} />
        <h2>
          <small>FORTUNE FAVOURS</small>
          THE BOLD
        </h2>
        <Link href="/tables" className="rp-btn">
          <span>▶</span>Take a seat
        </Link>
      </section>

      <style>{CSS}</style>
    </div>
  );
}

const OUT = "cubic-bezier(.2,.8,.2,1)";
const CSS = `
.rp{position:relative;z-index:1;margin:0 auto;width:100%;max-width:72rem;padding:0 16px 80px;font-family:var(--font-outfit),system-ui,sans-serif;color:#fff}
@media (min-width:640px){.rp{padding:0 24px 96px}}
/* the landing page's dark stage behind everything (covers the app's scene) */
.rp::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(60% 45% at 80% 10%,rgba(190,70,255,.22),transparent 70%),radial-gradient(50% 40% at 0% 60%,rgba(255,190,60,.08),transparent 70%),linear-gradient(#140f0e,#120128 70%)}
.rp-eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:11.5px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#ffd76a}
.rp-eyebrow::before{content:"";width:28px;height:1px;background:linear-gradient(90deg,transparent,#ffd76a)}
.rp h1,.rp h2,.rp h3,.rp p{margin:0}

/* hero: a framed stage like the landing page */
.rp-hero{position:relative;display:grid;align-items:center;gap:24px;margin-top:22px;padding:44px 28px;border:6px solid #1d3743;border-radius:44px;overflow:hidden}
@media (min-width:900px){.rp-hero{grid-template-columns:1fr 1fr;padding:56px 64px;border-width:8px;border-radius:64px;min-height:520px}}
.rp-hero h1{margin-top:16px;font-size:clamp(44px,5.6vw,70px);line-height:1;font-weight:500;letter-spacing:-1px}
.rp-hero h1 small,.rp-cta h2 small{display:block;margin-bottom:8px;font-size:.42em;letter-spacing:4px;color:#ffd76a;font-weight:500}
.rp-hero p{margin-top:18px;font-size:17px;color:rgba(255,255,255,.75)}
.rp-hero-cta{display:flex;align-items:center;gap:22px;margin-top:30px;flex-wrap:wrap}
.rp-btn{display:inline-flex;align-items:center;gap:16px;height:58px;padding:0 26px 0 9px;border-radius:99px;background:#ffe800;color:#140f11 !important;font-size:15px;font-weight:600;transition:transform .2s}
.rp-btn:hover{transform:translateY(-2px)}
.rp-btn span{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#fff;font-size:12px;padding-left:2px}
.rp-link{font-size:14px;font-weight:500;color:rgba(255,255,255,.7) !important}
.rp-link:hover{color:#fff !important}
.rp-hero-art{position:relative;display:grid;place-items:center;min-height:300px}
@media (min-width:900px){.rp-hero-art{padding-left:48px}}
.rp-glow{position:absolute;width:420px;height:320px;border-radius:50%;background:radial-gradient(closest-side,rgba(196,42,255,.45),rgba(120,30,220,.12) 60%,transparent)}

/* card fans */
.rp-fan{position:relative;display:flex;justify-content:center;height:var(--h);--w:96px;--h:141px}
.rp-fan img{width:var(--w);height:var(--h);margin:0 calc(var(--w) * -.2);transform:rotate(calc(var(--i) * 9deg)) translateY(calc(var(--i) * var(--i) * 4px));transform-origin:50% 90%;filter:drop-shadow(0 10px 16px rgba(0,0,0,.5));transition:transform .45s ${OUT}}
.rp-rank:hover .rp-fan img,.rp-cta:hover .rp-fan img{transform:rotate(calc(var(--i) * 15deg)) translate(calc(var(--i) * 14px),calc(var(--i) * var(--i) * 6px - 6px))}
.rp-fan-lg{--w:clamp(104px,17vw,200px);--h:calc(var(--w) * 1.4667)}
.rp-fan-lg img{margin:0 calc(var(--w) * -.3);transform:rotate(calc(var(--i) * 9deg)) translateY(calc(var(--i) * var(--i) * var(--w) * .042));animation:rp-deal .9s ${OUT} backwards;animation-delay:calc((var(--i) + 1) * .12s)}
/* same hover as the "Fortune favours the bold" fan, scaled to the bigger cards */
.rp-hero-art:hover .rp-fan-lg img{transform:rotate(calc(var(--i) * 15deg)) translate(calc(var(--i) * var(--w) * .146),calc(var(--i) * var(--i) * var(--w) * .0625 - var(--w) * .0625))}
@keyframes rp-deal{from{opacity:0;transform:translateY(80px) rotate(0)}}

/* sections */
.rp-sec{margin-top:96px;scroll-margin-top:24px}
.rp-head{display:grid;gap:10px;margin-bottom:34px}
.rp-head h2{font-size:clamp(34px,4.4vw,52px);line-height:1.05;font-weight:500;letter-spacing:-.5px}

/* rankings */
.rp-ranks{display:grid;gap:16px}
@media (min-width:760px){.rp-ranks{grid-template-columns:1fr 1fr}}
@media (min-width:1080px){.rp-ranks{grid-template-columns:1fr 1fr 1fr}}
.rp-rank{position:relative;display:grid;justify-items:center;gap:20px;padding:52px 20px 24px;border-radius:28px;text-align:center;border:1px solid rgba(255,214,102,.16);background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));transition:border-color .3s,transform .3s ${OUT},opacity .7s ${OUT}}
.rp-rank:hover{border-color:rgba(255,214,102,.5);transform:translateY(-4px)}
.rp-rank:first-child{background:radial-gradient(120% 80% at 50% 0%,rgba(255,196,60,.18),transparent 70%),linear-gradient(160deg,rgba(255,255,255,.07),rgba(255,255,255,.02));border-color:rgba(255,214,102,.4)}
.rp-no{position:absolute;left:20px;top:16px;font-size:34px;font-weight:600;line-height:1;color:transparent;-webkit-text-stroke:1.2px rgba(255,214,102,.65)}
.rp-tag{position:absolute;right:18px;top:18px;padding:5px 11px;border-radius:99px;background:#ffe800;color:#140f11;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase}
.rp-rank h3{font-size:22px;font-weight:600}
.rp-rank p{margin-top:4px;font-size:14px;color:rgba(233,221,255,.62)}
.rp-note{margin-top:20px;text-align:center;font-size:14px;color:rgba(233,221,255,.6)}
.rp-note b{color:#ffd76a;font-weight:600}

/* steps */
.rp-steps{display:grid;gap:14px;margin:0;padding:0;list-style:none;counter-reset:s}
@media (min-width:760px){.rp-steps{grid-template-columns:repeat(5,1fr)}}
.rp-step{position:relative;padding:22px 18px 20px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035);transition:opacity .7s ${OUT},transform .7s ${OUT},border-color .3s}
.rp-step:hover{border-color:rgba(255,214,102,.4)}
.rp-step-ico{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;font-size:22px;color:#ffd76a;border:1.5px solid transparent;background:linear-gradient(160deg,#341257,#1b0733) padding-box,linear-gradient(160deg,#ffe9a3,#c98a12 55%,#6b3d06) border-box}
.rp-backs{position:relative;width:34px;height:30px}
.rp-backs i{position:absolute;top:2px;left:50%;width:17px;height:25px;margin-left:-8.5px;border-radius:3px;background:#2a0d40 url(/landing/card-back.webp) center/cover;box-shadow:0 2px 4px rgba(0,0,0,.5)}
.rp-backs i:nth-child(1){transform:translateX(-9px) rotate(-14deg)}
.rp-backs i:nth-child(3){transform:translateX(9px) rotate(14deg)}
.rp-step em{position:absolute;right:18px;top:18px;font-style:normal;font-size:13px;font-weight:600;color:rgba(255,214,102,.55)}
.rp-step h3{margin-top:16px;font-size:18px;font-weight:600}
.rp-step p{margin-top:6px;font-size:14px;line-height:1.45;color:rgba(233,221,255,.62)}
@media (min-width:760px){.rp-step:not(:last-child)::after{content:"";position:absolute;right:-12px;top:48px;width:10px;height:1px;background:rgba(255,214,102,.45)}}
.rp-side{display:grid;align-items:center;gap:26px;margin-top:16px;padding:30px;border-radius:24px;border:1px solid rgba(196,42,255,.35);background:linear-gradient(90deg,rgba(196,42,255,.14),rgba(196,42,255,.03))}
@media (min-width:860px){.rp-side{grid-template-columns:1fr auto;padding:34px 64px 34px 44px}}
.rp-side h3{font-size:22px;font-weight:600}
.rp-side p{margin-top:6px;max-width:340px;font-size:14.5px;line-height:1.5;color:rgba(233,221,255,.7)}
.rp-vs{display:flex;align-items:center;justify-content:center;gap:clamp(22px,4vw,48px)}
.rp-vs > b{font-size:20px;font-weight:600;letter-spacing:2px;color:#ffd76a}
.rp-hand{display:grid;justify-items:center;gap:16px;padding:14px 12px 0}
.rp-hand span{font-size:12.5px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
.rp-hand.is-out span{color:rgba(233,221,255,.5)}
.rp-hand.is-win span{color:#2fe07a}
.rp-hand.is-out .rp-fan{filter:saturate(.7) brightness(.8)}
.rp-fan-sm{--w:clamp(54px,11vw,74px);--h:calc(var(--w) * 1.4667)}
/* a gentle spread that stays inside the hand's own space */
.rp-hand:hover .rp-fan img{transform:rotate(calc(var(--i) * 13deg)) translate(calc(var(--i) * var(--w) * .1),calc(var(--i) * var(--i) * var(--w) * .05 - var(--w) * .04))}

/* quick numbers */
.rp-quick{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
@media (min-width:760px){.rp-quick{grid-template-columns:repeat(6,1fr)}}
.rp-q{display:grid;gap:6px;padding:20px 16px;border-radius:22px;text-align:center;border:1px solid rgba(255,214,102,.18);background:rgba(255,214,102,.04);transition:opacity .7s ${OUT},transform .7s ${OUT}}
.rp-q b{font-size:28px;font-weight:600;color:#ffe800;line-height:1}
.rp-q span{font-size:12.5px;line-height:1.35;color:rgba(233,221,255,.65)}

/* fairness */
.rp-fair{display:grid;gap:14px}
@media (min-width:760px){.rp-fair{grid-template-columns:repeat(3,1fr)}}
.rp-fair-card{padding:26px 24px;border-radius:26px;border:1px solid rgba(255,255,255,.08);background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));transition:opacity .7s ${OUT},transform .7s ${OUT}}
.rp-fair-card > span{display:grid;place-items:center;width:48px;height:48px;border-radius:15px;font-size:20px;color:#ffd76a;border:1.5px solid transparent;background:linear-gradient(160deg,#341257,#1b0733) padding-box,linear-gradient(160deg,#ffe9a3,#c98a12 55%,#6b3d06) border-box}
.rp-fair-card h3{margin-top:16px;font-size:19px;font-weight:600}
.rp-fair-card p{margin-top:6px;font-size:14px;line-height:1.5;color:rgba(233,221,255,.62)}

/* call to action */
.rp-cta{display:grid;justify-items:center;gap:22px;margin-top:110px;padding:56px 24px;border-radius:44px;text-align:center;border:6px solid #1d3743;background:radial-gradient(60% 70% at 50% 0%,rgba(196,42,255,.25),transparent 70%)}
.rp-cta h2{font-size:clamp(40px,5.4vw,66px);line-height:1;font-weight:500}

/* scroll reveal */
.rp-reveal{opacity:0;transform:translateY(26px);transition:opacity .7s ${OUT},transform .7s ${OUT}}
.rp-reveal.is-in{opacity:1;transform:none}
.rp-rank.rp-reveal.is-in:hover{transform:translateY(-4px)}
@media (prefers-reduced-motion:reduce){.rp *{animation:none !important;transition:none !important}.rp-reveal{opacity:1;transform:none}}
`;
