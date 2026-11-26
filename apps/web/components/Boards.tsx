"use client";

// Tables page: the three themed boards, one full screen each, sliding right to
// left (wheel, arrow keys, swipe, or the tabs at the bottom). Board 1 is the
// entry level (purple), 2 premium (green), 3 the high roller room (red).
// Everything but the art and names is read on chain (useLobby).
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, avatarIndexes } from "./Avatar";
import { ExitTracker } from "./ExitTracker";
import { useLobby } from "./Lobby";
import { Sol } from "./Sol";
import { hashIndex, short, sol } from "@/lib/format";
import { LOBBY, type Board } from "@/lib/lobby";
import { useWallet } from "@/lib/wallet";
import { toView, viewW } from "@/lib/viewport";

const BOARDS: { id: Board; level: string; tag: string; accent: string; glow: string }[] = [
  { id: "amethyst", level: "Entry", tag: "Where every legend starts.", accent: "#c98bff", glow: "168,85,247" },
  { id: "emerald", level: "Premium", tag: "Higher stakes, sharper players.", accent: "#5cf09a", glow: "47,224,122" },
  { id: "ruby", level: "High roller", tag: "The throne room. Only the bold sit here.", accent: "#ff6b6b", glow: "255,70,70" },
];

export function Boards() {
  const { tables, failed } = useLobby();
  const { wallet } = useWallet();
  const you = wallet?.publicKey.toBase58() ?? null;
  const [i, setI] = useState(0);
  const lock = useRef(0);

  const go = useCallback((n: number) => {
    const now = Date.now();
    if (now - lock.current < 700) return; // one board per gesture
    lock.current = now;
    setI((cur) => Math.max(0, Math.min(BOARDS.length - 1, n < 0 ? cur - 1 : n > 0 ? cur + 1 : cur)));
  }, []);

  // Wheel (either direction), arrow keys and horizontal swipes move between boards.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) > 20) go(d > 0 ? 1 : -1);
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.("input,textarea,[role=dialog]")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    let x0: number | null = null;
    const onStart = (e: TouchEvent) => (x0 = toView(e.touches[0].clientX, e.touches[0].clientY).x);
    const onEnd = (e: TouchEvent) => {
      if (x0 === null) return;
      const dx = toView(e.changedTouches[0].clientX, e.changedTouches[0].clientY).x - x0;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
      x0 = null;
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [go]);

  // The page itself never scrolls (desktop); boards slide instead.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    if (viewW() >= 900) el.style.overflow = "hidden";
    return () => {
      el.style.overflow = prev;
    };
  }, []);

  return (
    <div className="bd" style={{ "--i": i } as React.CSSProperties}>
      <div className="bd-track">
        {BOARDS.map((b, k) => {
          const meta = LOBBY.find((m) => m.board === b.id);
          const t = tables?.find((x) => x.config === meta?.config);
          const taken = t ? t.seated.filter(Boolean).length : 0;
          const seats = t?.seated.length ?? 6;
          const mine = !!you && !!t?.seated.includes(you);
          const full = !!t && taken >= seats;
          const avatars = avatarIndexes(t?.seated ?? [], hashIndex);
          return (
            <section
              key={b.id}
              className={`bd-slide bd-${b.id} ${k === i ? "is-on" : ""}`}
              aria-hidden={k !== i}
              style={{ "--accent": b.accent, "--glow": b.glow } as React.CSSProperties}
            >
              <img className="bd-hall" src={`/boards/${b.id}-hall.webp`} alt="" />
              <div className="bd-shade" />

              {/* the scene: dealer behind the table, coins at its feet */}
              <div className="bd-scene">
                <span className="bd-spot" />
                <img className="bd-dealer" src={`/boards/${b.id}-dealer.webp`} alt="" />
                <img className={`bd-table ${b.id === "amethyst" ? "is-blended" : "is-cut"}`} src={`/boards/${b.id}-table.webp`} alt="" />
                <img className="bd-coin bd-coin-l" src={`/boards/${b.id}-stack.webp`} alt="" />
                <img className="bd-coin bd-coin-r" src={`/boards/${b.id}-pile.webp`} alt="" />
                <FeltCards board={b.id} />
              </div>

              {/* the board's card */}
              <div className="bd-info">
                <span className="bd-eyebrow">
                  Board {String(k + 1).padStart(2, "0")} · {b.level}
                </span>
                <h1>{meta?.name ?? "Coming soon"}</h1>
                <p className="bd-tag">{b.tag}</p>

                <div className="bd-stats">
                  <div>
                    <small>Boot</small>
                    <b>{t ? <><Sol /> {sol(t.boot)}</> : "…"}</b>
                  </div>
                  <div>
                    <small>Buy-in</small>
                    <b>{t ? <><Sol /> {sol(t.minBuyIn)}–{sol(t.maxBuyIn)}</> : "…"}</b>
                  </div>
                  <div>
                    <small>Seats</small>
                    <b>{t ? `${taken}/${seats}` : "…"}</b>
                  </div>
                </div>

                {/* who's sitting: the players' characters, empty chairs after */}
                <div className="bd-seats" aria-label="Seats">
                  {(t?.seated ?? Array.from({ length: 6 }, () => null)).map((w, s) =>
                    w ? (
                      <span key={s} className={`bd-seat ${w === you ? "is-you" : ""}`} title={w === you ? "You" : short(w)}>
                        <Avatar name={w === you ? "You" : short(w)} index={avatars.get(w) ?? hashIndex(w)} size={40} />
                      </span>
                    ) : (
                      <span key={s} className="bd-seat is-empty" title="Open seat">
                        +
                      </span>
                    ),
                  )}
                  <em>
                    {!t ? (failed ? "Can't reach Solana devnet. Retrying…" : "Reading the table…") : !t.live ? "New session starting…" : mine ? "You have a seat here" : full ? "Full · watch the game" : `${seats - taken} seat${seats - taken === 1 ? "" : "s"} open`}
                  </em>
                </div>

                <div className="bd-cta">
                  {meta && (
                    <Link href={`/table/${meta.config}`} className="bd-btn">
                      <span>▶</span>
                      {mine ? "Back to your seat" : full || (t && !t.open) ? "Watch the table" : "Take a seat"}
                    </Link>
                  )}
                  {k < BOARDS.length - 1 && (
                    <button type="button" className="bd-next" onClick={() => go(1)}>
                      Next board →
                    </button>
                  )}
                </div>
              </div>
            </section>
          );
        })}
      </div>

      {/* board switcher */}
      <nav className="bd-tabs" aria-label="Boards">
        <button type="button" className="bd-arrow" aria-label="Previous board" disabled={i === 0} onClick={() => go(-1)}>
          ‹
        </button>
        {BOARDS.map((b, k) => (
          <button
            key={b.id}
            type="button"
            className={`bd-tab ${k === i ? "is-on" : ""}`}
            style={{ "--accent": b.accent } as React.CSSProperties}
            onClick={() => {
              lock.current = 0;
              setI(k);
            }}
          >
            <i />
            <span>
              <small>{String(k + 1).padStart(2, "0")}</small>
              {b.level}
            </span>
          </button>
        ))}
        <button type="button" className="bd-arrow" aria-label="Next board" disabled={i === BOARDS.length - 1} onClick={() => go(1)}>
          ›
        </button>
      </nav>
      <ExitTracker />
      <style>{CSS}</style>
    </div>
  );
}

// Three cards face down on each board's felt: hover (or tap) one to flip it.
const FELT_CARDS = {
  amethyst: [
    { face: "/cards/Qh.webp", label: "Queen of Hearts", rot: -10 },
    { face: "/cards/Ks.webp", label: "King of Spades", rot: 0 },
    { face: "/cards/Jd.webp", label: "Jack of Diamonds", rot: 10 },
  ],
  emerald: [
    { face: "/cards/Qc.webp", label: "Queen of Clubs", rot: -10 },
    { face: "/cards/Kd.webp", label: "King of Diamonds", rot: 0 },
    { face: "/cards/Js.webp", label: "Jack of Spades", rot: 10 },
  ],
  ruby: [
    { face: "/cards/Qs.webp", label: "Queen of Spades", rot: -10 },
    { face: "/cards/Kh.webp", label: "King of Hearts", rot: 0 },
    { face: "/cards/Jc.webp", label: "Jack of Clubs", rot: 10 },
  ],
};

function FeltCards({ board }: { board: Board }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="bd-felt-cards">
      {FELT_CARDS[board].map((c, k) => (
        <button
          key={c.face}
          type="button"
          className={`bd-fc ${open === k ? "is-open" : ""}`}
          style={{ "--r": `${c.rot}deg`, "--d": `${0.7 + k * 0.12}s` } as React.CSSProperties}
          aria-label={`Flip card: ${c.label}`}
          onClick={() => setOpen(open === k ? null : k)}
        >
          <span className="bd-fc-in">
            <img className="bd-fc-back" src={`/cards/back-${board}.webp`} alt="" />
            <img className="bd-fc-face" src={c.face} alt={c.label} />
          </span>
        </button>
      ))}
    </div>
  );
}

const OUT = "cubic-bezier(.22,1,.36,1)";
const CSS = `
.bd{position:fixed;inset:0;z-index:0;overflow:hidden;font-family:var(--font-outfit),system-ui,sans-serif;color:#fff;background:#0b0418}
.bd-track{display:flex;height:100%;width:calc(${BOARDS.length * 100} * var(--vw));transform:translateX(calc(var(--i) * -100 * var(--vw)));transition:transform 1s ${OUT}}
.bd-slide{position:relative;flex:none;width:calc(100 * var(--vw));height:100%;overflow:hidden}
.bd-hall{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scale(1.08);transition:transform 1.4s ${OUT}}
.bd-slide.is-on .bd-hall{transform:scale(1)}
.bd-shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,2,14,.85) 0%,rgba(6,2,14,.55) 34%,rgba(6,2,14,0) 62%),linear-gradient(0deg,rgba(6,2,14,.45),rgba(6,2,14,0) 26%),linear-gradient(180deg,rgba(6,2,14,.55),rgba(6,2,14,0) 22%)}

/* scene */
.bd-scene{--sw:min(calc(58 * var(--vw)),980px);position:absolute;right:calc(2 * var(--vw));bottom:calc(9 * var(--vh));width:var(--sw);height:min(calc(74 * var(--vh)),720px)}
.bd-spot{position:absolute;left:50%;top:6%;width:70%;height:70%;transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(var(--glow),.35),rgba(var(--glow),.08) 60%,transparent)}
.bd-dealer{position:absolute;left:50%;bottom:30%;height:66%;width:auto;transform:translateX(-50%);filter:drop-shadow(0 20px 40px rgba(0,0,0,.5))}
/* Amethyst: the whole table image, its dark backdrop faded into the dark hall.
   Emerald / Ruby: cut-out tables, placed solid. */
.bd-table{position:absolute;height:auto}
.bd-table.is-blended{left:0;right:0;bottom:0;width:100%;-webkit-mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%);mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 72%,transparent 100%)}
/* the table image's backdrop above the rim must not cover the dealer: clear the top,
   then fade the sides (Emerald's rim reaches further out, so its side fade starts later) */
.bd-table.is-blended{-webkit-mask-image:linear-gradient(180deg,transparent 15%,#000 21%),radial-gradient(ellipse 50% 52% at 50% 50%,#000 74%,transparent 100%);-webkit-mask-composite:source-in;mask-image:linear-gradient(180deg,transparent 15%,#000 21%),radial-gradient(ellipse 50% 52% at 50% 50%,#000 74%,transparent 100%);mask-composite:intersect}
.bd-table.is-cut{left:7%;width:86%;bottom:calc(var(--sw) * .066);filter:drop-shadow(0 26px 30px rgba(0,0,0,.55))}
/* chips resting on the felt, sized to the table */
.bd-coin{position:absolute;bottom:calc(var(--sw) * .262);height:auto;filter:drop-shadow(0 8px 10px rgba(0,0,0,.5))}
.bd-coin-l{left:25%;width:7.5%}
.bd-coin-r{right:23%;width:11%;bottom:calc(var(--sw) * .258)}
/* three face-down cards in the middle of the felt; hover lifts and flips one */
.bd-felt-cards{position:absolute;left:50%;bottom:calc(var(--sw) * .245);transform:translateX(-50%);display:flex;gap:calc(var(--sw) * .012);perspective:900px;z-index:3}
.bd-fc{--w:calc(var(--sw) * .062);width:var(--w);height:calc(var(--w) * 1.4667);padding:0;border:0;background:none;cursor:pointer;transform:rotate(var(--r)) rotateX(38deg);transform-origin:50% 100%;transition:transform .55s ${OUT};opacity:0;animation:bd-deal .6s ${OUT} var(--d) forwards}
@keyframes bd-deal{from{opacity:0;translate:0 -40px}to{opacity:1;translate:0 0}}
.bd-fc-in{position:relative;display:block;width:100%;height:100%;transform-style:preserve-3d;transition:transform .7s ${OUT}}
.bd-fc img{position:absolute;inset:0;width:100%;height:100%;border-radius:8%;backface-visibility:hidden;-webkit-backface-visibility:hidden;box-shadow:0 6px 12px rgba(0,0,0,.5)}
.bd-fc-face{transform:rotateY(180deg)}
.bd-fc:hover,.bd-fc.is-open,.bd-fc:focus-visible{transform:rotate(calc(var(--r) * .4)) rotateX(8deg) translateY(-26%) scale(1.35);z-index:2;outline:none}
.bd-fc:hover .bd-fc-in,.bd-fc.is-open .bd-fc-in,.bd-fc:focus-visible .bd-fc-in{transform:rotateY(180deg)}
.bd-fc:hover img,.bd-fc.is-open img{box-shadow:0 14px 26px rgba(0,0,0,.55),0 0 22px rgba(var(--glow),.55)}

/* entrance when a board slides in */
.bd-slide .bd-dealer,.bd-slide .bd-table,.bd-slide .bd-coin,.bd-slide .bd-info > *{opacity:0;transition:opacity .7s ease,translate .9s ${OUT}}
.bd-slide .bd-dealer{translate:0 40px}
.bd-slide .bd-table{translate:0 60px}
.bd-slide .bd-coin{translate:0 50px}
.bd-slide .bd-info > *{translate:-30px 0}
.bd-slide.is-on .bd-dealer,.bd-slide.is-on .bd-table,.bd-slide.is-on .bd-coin,.bd-slide.is-on .bd-info > *{opacity:1;translate:0 0}
.bd-slide.is-on .bd-table{transition-delay:.25s}
.bd-slide.is-on .bd-dealer{transition-delay:.4s}
.bd-slide.is-on .bd-coin{transition-delay:.55s}
.bd-slide.is-on .bd-info > :nth-child(1){transition-delay:.2s}
.bd-slide.is-on .bd-info > :nth-child(2){transition-delay:.28s}
.bd-slide.is-on .bd-info > :nth-child(3){transition-delay:.36s}
.bd-slide.is-on .bd-info > :nth-child(4){transition-delay:.44s}
.bd-slide.is-on .bd-info > :nth-child(5){transition-delay:.52s}
.bd-slide.is-on .bd-info > :nth-child(6){transition-delay:.6s}

/* info */
.bd-info{position:absolute;left:max(24px,calc((calc(100 * var(--vw)) - 72rem) / 2 + 24px));top:50%;transform:translateY(-46%);width:min(440px,calc(40 * var(--vw)));z-index:2}
.bd-eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:12px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--accent)}
.bd-eyebrow::before{content:"";width:30px;height:1px;background:linear-gradient(90deg,transparent,var(--accent))}
.bd-info h1{margin:14px 0 0;font-size:clamp(40px,min(calc(5 * var(--vw)),calc(8 * var(--vh))),72px);line-height:1;font-weight:600;letter-spacing:-1px;text-shadow:0 6px 30px rgba(0,0,0,.6)}
.bd-tag{margin:14px 0 0;font-size:16px;color:rgba(255,255,255,.75)}
.bd-stats{display:grid;grid-template-columns:repeat(3,auto);justify-content:start;gap:10px;margin-top:26px}
.bd-stats > div{display:grid;gap:3px;padding:12px 16px;border-radius:18px;border:1px solid rgba(255,255,255,.12);background:rgba(10,4,24,.55);backdrop-filter:blur(8px)}
.bd-stats small{font-size:10.5px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(233,221,255,.55)}
.bd-stats b{display:flex;align-items:center;gap:6px;font-size:17px;font-weight:600;white-space:nowrap}
.bd-seats{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:18px}
.bd-seat{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;padding:2px;background:linear-gradient(160deg,rgba(var(--glow),.9),rgba(var(--glow),.25));box-shadow:0 4px 14px rgba(0,0,0,.4)}
.bd-seat.is-you{background:linear-gradient(160deg,#ffe86a,#f5c400)}
.bd-seat.is-empty{background:rgba(255,255,255,.05);border:1.5px dashed rgba(255,255,255,.25);color:rgba(255,255,255,.45);font-size:18px;box-shadow:none}
.bd-seats em{margin-left:8px;font-style:normal;font-size:13px;color:rgba(233,221,255,.7)}
.bd-cta{display:flex;flex-wrap:wrap;align-items:center;gap:20px;margin-top:28px}
.bd-btn{position:relative;display:inline-flex;align-items:center;gap:14px;height:58px;padding:0 28px 0 9px;border-radius:99px;overflow:hidden;color:#1d1200 !important;font-size:16px;font-weight:600;
  background:linear-gradient(180deg,#fff27a,#ffe100 45%,#f0b400);box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 -2px 0 rgba(150,90,0,.35),0 10px 30px rgba(245,190,0,.35);transition:transform .25s ${OUT}}
.bd-btn:hover{transform:translateY(-2px)}
.bd-btn span{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#1d1200;color:#ffe100;font-size:12px;padding-left:2px}
.bd-btn::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg);transition:left .7s ${OUT}}
.bd-btn:hover::after{left:120%}
.bd-next{border:0;background:none;color:rgba(255,255,255,.75);font:500 14px var(--font-outfit),sans-serif;cursor:pointer}
.bd-next:hover{color:#fff}

/* switcher */
.bd-tabs{position:fixed;left:50%;bottom:22px;z-index:5;display:flex;align-items:center;gap:8px;padding:8px;border-radius:99px;transform:translateX(-50%);background:rgba(8,3,20,.6);border:1px solid rgba(255,255,255,.1);backdrop-filter:blur(10px)}
.bd-tab{display:flex;align-items:center;gap:10px;height:42px;padding:0 16px 0 10px;border:0;border-radius:99px;background:none;color:rgba(255,255,255,.6);font:500 13.5px var(--font-outfit),sans-serif;cursor:pointer;transition:background .3s,color .3s}
.bd-tab i{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px var(--accent);opacity:.5;transition:opacity .3s}
.bd-tab span{display:flex;align-items:baseline;gap:6px}
.bd-tab small{font-size:11px;opacity:.6}
.bd-tab.is-on{background:rgba(255,255,255,.1);color:#fff}
.bd-tab.is-on i{opacity:1}
.bd-arrow{width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,214,102,.35);background:rgba(255,214,102,.06);color:#ffd76a;font:600 20px/1 var(--font-outfit),sans-serif;cursor:pointer}
.bd-arrow:disabled{opacity:.3;cursor:default}

/* phones: scene on top, card below; the slide scrolls if needed */
@media (max-width:899px){
  .bd-slide{overflow-y:auto}
  .bd-scene{--sw:calc(94 * var(--vw));position:relative;right:auto;bottom:auto;width:calc(94 * var(--vw));height:calc(56 * var(--vw));margin:96px auto 0}
  .bd-info{position:relative;left:auto;top:auto;transform:none;width:auto;padding:18px 20px 120px}
  .bd-shade{background:linear-gradient(0deg,rgba(6,2,14,.92) 30%,rgba(6,2,14,.3) 70%,rgba(6,2,14,.5))}
  .bd-stats{grid-template-columns:repeat(3,1fr)}
  .bd-stats b{font-size:14px}
  .bd-tab span{display:none}
  .bd-tab{padding:0 12px}
}
/* phones in landscape (html[data-land], lib/viewport.ts): the card on the left, the table on the right, sized to the height */
html[data-land] .bd-slide{overflow:hidden}
html[data-land] .bd-shade{background:linear-gradient(90deg,rgba(6,2,14,.88) 0%,rgba(6,2,14,.6) 38%,rgba(6,2,14,0) 66%),linear-gradient(0deg,rgba(6,2,14,.5),rgba(6,2,14,0) 26%)}
html[data-land] .bd-scene{--sw:min(calc(54 * var(--vw)),calc((calc(100 * var(--dvh)) - 112px) / .6));position:absolute;right:calc(2 * var(--vw));bottom:58px;width:var(--sw);height:calc(var(--sw) * .6);margin:0}
html[data-land] .bd-info{position:absolute;left:20px;top:calc(50% - 4px);transform:translateY(-50%);width:min(380px,calc(42 * var(--vw)));padding:0}
html[data-land] .bd-eyebrow{font-size:10px;letter-spacing:2.4px}
html[data-land] .bd-info h1{margin-top:6px;font-size:30px}
html[data-land] .bd-tag{margin-top:6px;font-size:13px}
html[data-land] .bd-stats{margin-top:12px;gap:6px}
html[data-land] .bd-stats > div{padding:6px 10px;border-radius:12px}
html[data-land] .bd-stats small{font-size:9px;letter-spacing:1.4px}
html[data-land] .bd-stats b{font-size:13px}
html[data-land] .bd-seats{margin-top:10px;gap:4px}
html[data-land] .bd-seat{width:30px;height:30px;font-size:14px}
html[data-land] .bd-seats em{font-size:11.5px}
html[data-land] .bd-cta{margin-top:12px;gap:14px}
html[data-land] .bd-btn{height:42px;padding:0 20px 0 6px;gap:10px;font-size:14px}
html[data-land] .bd-btn span{width:30px;height:30px}
html[data-land] .bd-tabs{bottom:8px;padding:5px;gap:6px}
html[data-land] .bd-tab{height:34px}
html[data-land] .bd-arrow{width:34px;height:34px;font-size:17px}
@media (prefers-reduced-motion:reduce){.bd *{transition:none !important}}
`;
