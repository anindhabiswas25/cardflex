"use client";

// Card Flex landing page, rebuilt from the licensed card-game design (video reference).
//
// Layout: a 1280x960 design stage scaled to the window height (or width on
// narrow screens). The left group (logo, text, blob) keeps design
// coordinates from the left edge; the right group (nav, cards, Next) keeps
// design coordinates from the right edge, so wide windows widen the gap
// between them, like the design. The page never scrolls: wheel, keys and
// swipes step through the slides instead.
//
// Artwork lives in public/landing/. The card characters are the supplied
// full-resolution art (1122x1402, transparent outside the card + character),
// scaled so each card matches the design's card position. The hero fan and
// the last slide's peek card are drawn as cards here, with the supplied
// character cutouts (hero-*.webp) inside.

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GH_ICON, MenuButton, MenuPanel, REPO, WalletMenu, X_ICON } from "./SiteNav";
import { toView, viewH, viewW } from "@/lib/viewport";

const W = 1280;
const H = 960;

type Slide = {
  title: [string, string];
  body: string;
  bg: string;
  /** Card character art: a transparent image with the card + character. */
  art: { src: string; w: number; h: number; l: number; t: number; r: number };
  /** Card's outer top-left corner and right edge in design coordinates. */
  card: { l: number; t: number; r: number };
};

const HERO_BG = "#140f0e";
// Logo ink per page: gold on the dark pages, a deep tone of each card on the light slides.
const LOGO_TINT: (string | null)[] = [null, "#4b1d9e", "#1a2d78", "#5a1c08", null];

const SLIDES: Slide[] = [
  {
    title: ["The", "Queen"],
    body: "She deals in secrets. Broom in hand and her cat at her side, the Queen knows a hidden hand is the strongest one, and at Card Flex only you ever see yours.",
    bg: "#92cceb",
    // art.l/t/r = the card's left, top and right edge inside the image (px)
    art: { src: "/landing/cat-witch.webp", w: 1122, h: 1402, l: 219, t: 232, r: 990 },
    card: { l: 626, t: 359, r: 1057 },
  },
  {
    title: ["The", "Jack"],
    body: "He never waits for the tide. Sword at his belt and a pot of sweets in hand, the Jack plays fast and bold. Moves land in a moment, with no wallet pop-ups in between.",
    bg: "#d85a5e",
    art: { src: "/landing/kid-skull.webp", w: 1122, h: 1402, l: 184, t: 194, r: 942 },
    card: { l: 626, t: 346, r: 1055 },
  },
  {
    title: ["The", "King"],
    body: "He has ruled for a thousand years and believes only what he can check. When a hand ends, anyone can replay its shuffle and see the deal was fair.",
    bg: "#fe8a46",
    art: { src: "/landing/lone-mummy.webp", w: 1122, h: 1402, l: 176, t: 144, r: 957 },
    card: { l: 612, t: 346, r: 1055 },
  },
];

const PEEK = { l: 1153, t: 574 };
// Where the witch card sits in the hero fan (top-left corner, tilt, scale).
const HERO_WITCH = { l: 925, t: 571, rot: -14.4, scale: 300 / 431 };

/** A character card in the hero fan, measured from the design (top-left corner, width, tilt). */
type FanCard = {
  name: string;
  src: string;
  x: number;
  y: number;
  w: number;
  rot: number;
  rim: string;
  /** Character placement inside the card, as fractions of the card width. */
  art: { left: number; top: number; width: number };
  dim?: boolean;
};

const CARD_RATIO = 1.48; // height / width of every card

const FAN: FanCard[] = [
  { name: "Vampire", src: "/landing/hero-vampire.webp", x: 545, y: 342, w: 160, rot: -17, rim: "#1fc275", art: { left: 0.02, top: 0.1, width: 0.95 }, dim: true },
  { name: "Cauldron", src: "/landing/hero-cauldron.webp", x: 737, y: 334, w: 160, rot: -16.8, rim: "#e6eef2", art: { left: 0.07, top: 0.06, width: 0.86 }, dim: true },
  { name: "Pirate", src: "/landing/hero-pirate.webp", x: 930, y: 341, w: 160, rot: -16.8, rim: "#1a6ef0", art: { left: 0.08, top: 0.07, width: 0.84 }, dim: true },
  { name: "King", src: "/landing/hero-mummy.webp", x: 604, y: 580, w: 295, rot: -10.1, rim: "#fa6064", art: { left: 0.04, top: 0.05, width: 0.92 } },
  { name: "Queen", src: "/landing/hero-witch.webp", x: 925, y: 571, w: 300, rot: -14.4, rim: "#c42aff", art: { left: 0.01, top: 0.04, width: 0.98 } },
];

/** The last slide's peek: the vampire on a full-size card. */
const PEEK_VAMPIRE: FanCard = {
  name: "Vampire", src: "/landing/hero-vampire.webp", x: 1153, y: 574, w: 431, rot: 0, rim: "#1fc275",
  art: { left: 0.04, top: 0.07, width: 0.92 },
};

// Final page: the dealer at the table. Page 4, after the three slides.
const FINAL = 4;
const TABLE_BG = "#120128";

const bgOf = (i: number) => (i === 0 ? HERO_BG : i === FINAL ? TABLE_BG : SLIDES[i - 1].bg);

type Role = "main" | "peek" | "exit" | "from-peek" | "from-hero" | "peek-in";
type Trans = { kind: "explore" | "next" | "final" | "home" | "jump"; from: number; to: number };
const DUR = { explore: 950, next: 820, final: 900, home: 380, jump: 650 } as const;

// Portrait (phone) design canvas: 720 wide, as tall as the screen allows.
const PW = 720;
// Progress rail on the right edge: one stop per page, plus the footer.
const RAIL = ["Home", "Queen", "Jack", "King", "Take a Seat", "More"];
const RAIL_GAP = 56;
const SEEN_KEY = "cardflex-landing-seen";

type Box = { s: number; w: number; h: number; y: number; portrait: boolean; pk: number; fk: number };

// Left-side text and buttons: 15% bigger, up to 30% on wide screens (more free width).
const textScale = (b: Box | null) => (!b ? 1.15 : b.portrait ? 1.1 : Math.min(1.3, Math.max(1.15, 1 + (b.w - W) / 900)));

export function CardFlexLanding() {
  const [idx, setIdx] = useState(0); // 0 = hero, 1..3 = slides, 4 = final (table)
  const [footer, setFooter] = useState(false); // footer panel slid up over the final page
  const [trans, setTrans] = useState<Trans | null>(null);
  const [heroEnter, setHeroEnter] = useState(false); // replay hero entrance after "home"
  const [box, setBox] = useState<Box | null>(null);
  const [arrive, setArrive] = useState(false); // fade the page in after a rail jump
  const [hint, setHint] = useState(false); // "scroll to explore" on the first visit only
  const timers = useRef<number[]>([]);
  const busy = useRef(false);
  const touchY = useRef<number | null>(null);
  const [menu, setMenu] = useState(false); // ☰ panel
  const [walletOpen, setWalletOpen] = useState(false); // wallet dropdown
  const paused = useRef(false); // an overlay is open: wheel / keys / swipe don't change pages
  paused.current = menu || walletOpen;

  // Fit the stage. Landscape: all of 1280x960 fits, stage as wide as the window.
  // Portrait phones: a 720-wide canvas as tall as the screen; the art group is
  // scaled (pk / fk) and anchored to the bottom, the text sits at the top.
  useLayoutEffect(() => {
    const fit = () => {
      const vw = viewW();
      const vh = viewH();
      if (vw / vh < 0.75) {
        const s = vw / PW;
        const h = vh / s;
        const pk = Math.min(0.97, Math.max(0.55, (h - 560) / 680));
        const fk = Math.min(0.86, Math.max(0.5, (h - 540) / 760));
        setBox({ s, w: PW, h, y: 0, portrait: true, pk, fk });
      } else {
        const s = Math.min(vw / W, vh / H);
        setBox({ s, w: vw / s, h: H, y: vh - H * s, portrait: false, pk: 1, fk: 1 });
      }
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // No scrolling anywhere while the landing page is mounted.
  useEffect(() => {
    const els = [document.documentElement, document.body];
    const prev = els.map((e) => [e.style.overflow, e.style.overscrollBehavior] as const);
    els.forEach((e) => {
      e.style.overflow = "hidden";
      e.style.overscrollBehavior = "none";
    });
    return () =>
      els.forEach((e, i) => {
        e.style.overflow = prev[i][0];
        e.style.overscrollBehavior = prev[i][1];
      });
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // 3D hover: only the card under the mouse tilts toward the cursor (with a light sheen).
  const tiltEl = useRef<HTMLElement | null>(null);
  const resetTilt = (el: HTMLElement | null) => {
    if (!el) return;
    el.classList.remove("is-tilting");
    for (const v of ["--tx", "--ty", "--gx", "--gy"]) el.style.removeProperty(v);
  };
  const onTiltMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as HTMLElement).closest<HTMLElement>(".hc-tilt");
    if (el !== tiltEl.current) {
      resetTilt(tiltEl.current);
      tiltEl.current = el;
    }
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    el.classList.add("is-tilting");
    el.style.setProperty("--ty", `${((x - 0.5) * 9).toFixed(2)}deg`);
    el.style.setProperty("--tx", `${((0.5 - y) * 7).toFixed(2)}deg`);
    el.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
    el.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
  }, []);
  const onTiltLeave = useCallback(() => {
    resetTilt(tiltEl.current);
    tiltEl.current = null;
  }, []);

  // Scroll hint only until the visitor has moved once (remembered per browser).
  useEffect(() => {
    try {
      setHint(!window.localStorage.getItem(SEEN_KEY));
    } catch {
      setHint(true);
    }
  }, []);
  const markSeen = useCallback(() => {
    setHint(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* storage blocked: the hint just shows again next time */
    }
  }, []);

  // Preload the card art so the first transition never shows an empty card.
  useEffect(() => {
    const extra = ["logo", "card-back", "final-table", "final-lady", "chip-flat", "chip-stack", "chip-pile"].map((n) => `/landing/${n}.webp`);
    for (const src of [...SLIDES.map((s) => s.art.src), ...FAN.map((c) => c.src), ...extra]) {
      const img = new Image();
      img.src = src;
    }
  }, []);

  const run = useCallback((t: Trans) => {
    if (busy.current) return;
    busy.current = true;
    setHeroEnter(false);
    setTrans(t);
    timers.current.push(
      window.setTimeout(() => {
        setIdx(t.to);
        setTrans(null);
        if (t.kind === "home") setHeroEnter(true);
        if (t.kind === "jump") {
          setArrive(true);
          timers.current.push(window.setTimeout(() => setArrive(false), 520));
        }
        busy.current = false;
      }, DUR[t.kind]),
    );
  }, []);

  // hero -> 01 -> 02 -> 03 -> table -> footer panel -> hero
  const forward = useCallback(() => {
    if (busy.current) return;
    markSeen();
    if (idx === 0) run({ kind: "explore", from: 0, to: 1 });
    else if (idx < 3) run({ kind: "next", from: idx, to: idx + 1 });
    else if (idx === 3) run({ kind: "final", from: 3, to: FINAL });
    else if (!footer) setFooter(true);
    else {
      setFooter(false);
      run({ kind: "home", from: FINAL, to: 0 });
    }
  }, [idx, footer, run, markSeen]);
  const goHome = useCallback(() => {
    setFooter(false);
    if (idx !== 0) run({ kind: "home", from: idx, to: 0 });
  }, [idx, run]);
  // Esc / up: close the footer first, otherwise back to the hero.
  const back = useCallback(() => (footer ? setFooter(false) : goHome()), [footer, goHome]);
  // Rail: jump to any page (5 = the footer).
  const goTo = useCallback(
    (i: number) => {
      if (busy.current) return;
      markSeen();
      if (i === 5) {
        if (idx === FINAL) setFooter(true);
        else {
          run({ kind: "jump", from: idx, to: FINAL });
          timers.current.push(window.setTimeout(() => setFooter(true), DUR.jump + 450));
        }
        return;
      }
      setFooter(false);
      if (i === idx) return;
      if (i === 0) goHome();
      else if (i === idx + 1) forward();
      else run({ kind: "jump", from: idx, to: i });
    },
    [idx, run, goHome, forward, markSeen],
  );

  // Wheel / keys / swipe step forward instead of scrolling.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (!paused.current && e.deltaY > 18) forward();
    };
    const onKey = (e: KeyboardEvent) => {
      if (paused.current) {
        if (e.key === "Escape") {
          setMenu(false);
          setWalletOpen(false);
        }
        return;
      }
      if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        forward();
      } else if (["ArrowUp", "PageUp", "Home", "Escape"].includes(e.key)) {
        e.preventDefault();
        back();
      }
    };
    const onTouchStart = (e: TouchEvent) => {
      touchY.current = toView(e.touches[0].clientX, e.touches[0].clientY).y;
    };
    const onTouchMove = (e: TouchEvent) => e.preventDefault();
    const onTouchEnd = (e: TouchEvent) => {
      if (!paused.current && touchY.current !== null && touchY.current - toView(e.changedTouches[0].clientX, e.changedTouches[0].clientY).y > 40) forward();
      touchY.current = null;
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [forward, back]);

  const sw = box?.w ?? W;
  const sh = box?.h ?? H;
  const dx = sw - W; // offset of the right group
  const railTop = sh / 2 - (RAIL_GAP * 5) / 2;

  // ---- what is on screen -------------------------------------------------
  const showHero = idx === 0 || trans?.kind === "explore";
  // The slide shown (or being arrived at), and the one leaving on Next.
  const cur = trans && trans.kind !== "home" && trans.kind !== "jump" ? trans.to : idx;
  const leaving = trans?.kind === "next" ? trans.from : 0;
  // Slide 03 stays under the purple wipe while the table page arrives.
  const slideIdx = trans?.kind === "final" ? 3 : cur;
  const showSlides = slideIdx >= 1 && slideIdx <= 3;
  const showFinal = cur === FINAL;

  const roles = new Map<number, Role>();
  if (showSlides) {
    if (leaving) roles.set(leaving, "exit");
    if (trans?.kind === "explore") roles.set(1, "from-hero");
    else if (trans?.kind === "next") roles.set(slideIdx, "from-peek");
    else roles.set(slideIdx, "main");
    if (slideIdx < 3) roles.set(slideIdx + 1, trans?.kind === "next" || trans?.kind === "explore" ? "peek-in" : "peek");
  }
  const vampire: Role | null = slideIdx === 3 ? (trans?.kind === "next" ? "peek-in" : "peek") : null;
  const pair = trans?.kind === "next" ? [trans.from, trans.to] : [slideIdx];
  const footerMode = footer ? "open" : idx === FINAL && !trans ? "peek" : "hidden";
  const railOn = footer ? 5 : trans ? trans.to : idx;
  const logoTint = LOGO_TINT[trans ? trans.to : idx] ?? null;

  return (
    <div
      className={`hc-root ${arrive ? "hc-arrive" : ""}`}
      style={{ background: bgOf(trans?.kind === "home" ? trans.from : idx) }}
    >
      <div
        className={`hc-stage ${box?.portrait ? "hc-portrait" : ""}`}
        onPointerMove={onTiltMove}
        onPointerLeave={onTiltLeave}
        style={
          box
            ? ({
                width: sw,
                height: sh,
                transform: `translate(0, ${box.y}px) scale(${box.s})`,
                "--pk": box.pk,
                "--fk": box.fk,
                "--sh": `${sh}px`,
                "--k": textScale(box),
                "--gap": box?.portrait ? 0 : dx,
              } as React.CSSProperties)
            : { visibility: "hidden" }
        }
      >
        {/* Frame sits behind the cards (like the design); a copy rides above the colour wipe. */}
        <div className="hc-frame" />

        {/* ---------- hero (under the wipe) ---------- */}
        {showHero && (
          <div className={`hc-hero ${heroEnter ? "hc-hero-enter" : ""} ${trans?.kind === "explore" ? "hc-hero-leave" : ""}`}>
            <div className="hc-blob" />
            <div className="hc-right">
              <Cloud />
              <div className="hc-hero-art">
                {FAN.map((c) => (
                  <FanCardView key={c.name} card={c} tilt />
                ))}
              </div>
            </div>
            <div className="hc-text hc-hero-text">
              <h1>
                <small>FORTUNE FAVOURS</small>
                THE BOLD
              </h1>
              <p>
                Meet the cast, then take a seat. Fast three-card hands on Solana where your cards stay private and every
                shuffle can be checked.
              </p>
              <button type="button" className="hc-explore" onClick={forward}>
                <span className="hc-explore-dot">↓</span>
                Explore
              </button>
              {hint && (
                <div className="hc-hint" aria-hidden>
                  <span className="hc-mouse">
                    <i />
                  </span>
                  Scroll to explore
                </div>
              )}
            </div>
          </div>
        )}

        {/* ---------- colour wipe ---------- */}
        {trans?.kind === "explore" && (
          <div className="hc-wipe hc-wipe-explore" style={{ left: -40, top: -2, background: bgOf(1) }} />
        )}
        {trans?.kind === "next" && (
          <div className="hc-wipe hc-wipe-next" style={{ left: dx + 800, top: 720, background: bgOf(trans.to) }} />
        )}
        {trans?.kind === "home" && <div className="hc-fade" style={{ background: HERO_BG }} />}
        {trans && <div className="hc-frame hc-frame-top" />}

        {/* ---------- slides (over the wipe) ---------- */}
        {showSlides && (
          <div className={`hc-slides ${trans?.kind === "home" ? "hc-slides-leave" : ""}`}>
            <div className="hc-right">
              {[...roles.entries()].map(([i, role]) => (
                <Card key={i} slide={SLIDES[i - 1]} role={role} />
              ))}
              {vampire && (
                <div key="vampire" className={`hc-vampire hc-role-${vampire}`}>
                  <FanCardView card={PEEK_VAMPIRE} />
                </div>
              )}
            </div>

            <div className={`hc-text hc-slide-text ${trans?.kind === "explore" ? "hc-rise" : ""}`}>
              {pair.map((i) => (
                <div
                  key={i}
                  className={`hc-copy ${trans?.kind === "next" ? (i === trans.from ? "hc-copy-out" : "hc-copy-in") : ""}`}
                >
                  <h2>
                    {SLIDES[i - 1].title[0]}
                    <br />
                    {SLIDES[i - 1].title[1]}
                  </h2>
                  <p>{SLIDES[i - 1].body}</p>
                </div>
              ))}
              <div className="hc-num">
                {pair.map((i) => (
                  <span key={i} className={trans?.kind === "next" ? (i === trans.from ? "hc-num-out" : "hc-num-in") : ""}>
                    {String(i).padStart(2, "0")}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ---------- final page: dealer at the table (over the slides) ---------- */}
        {trans?.kind === "final" && (
          <>
            <div className="hc-wipe hc-wipe-final" style={{ left: dx + 1161, top: 767, background: TABLE_BG }} />
            <div className="hc-frame hc-frame-final" />
          </>
        )}
        {showFinal && <FinalScene leaving={trans?.kind === "home"} under={footer} />}

        {/* rail jump: the target page's colour grows out of the rail stop */}
        {trans?.kind === "jump" && (
          <div
            className="hc-wipe hc-wipe-jump"
            style={{ left: sw - 20, top: railTop + trans.to * RAIL_GAP, background: bgOf(trans.to) }}
          />
        )}
        {trans?.kind === "jump" && <div className="hc-frame hc-frame-jump" />}

        {/* ---------- chrome (always on top) ---------- */}
        <a
          href="#"
          className={`hc-logo ${logoTint ? "is-tinted" : ""}`}
          style={logoTint ? ({ "--tint": logoTint } as React.CSSProperties) : undefined}
          onClick={(e) => {
            e.preventDefault();
            goHome();
          }}
          aria-label="Card Flex home"
        >
          <img className="hc-logo-gold" src="/landing/logo.webp" alt="Card Flex" width={560} height={402} />
          <span className="hc-logo-ink" aria-hidden>
            <span className="hc-logo-fill" />
            <img src="/landing/logo.webp" alt="" width={560} height={402} />
          </span>
        </a>
        <div className={`hc-right hc-chrome hc-topbar ${railOn >= 1 && railOn <= 3 ? "hc-ink" : ""}`}>
          <nav className="hc-links">
            <Link href="/tables">Tables</Link>
            <Link href="/rules">Rules</Link>
            <Link href="/verify">Verify</Link>
          </nav>
          <WalletMenu open={walletOpen} setOpen={setWalletOpen} />
          <MenuButton open={menu} onClick={() => setMenu(true)} />
        </div>
        <div className="hc-right hc-chrome">
          {cur >= 1 && cur <= 3 && (!trans || trans.kind === "next") && (
            <button type="button" className="hc-next" onClick={forward}>
              Next
            </button>
          )}
          {trans?.kind === "explore" && (
            <button type="button" className="hc-next hc-next-in" onClick={forward}>
              Next
            </button>
          )}
        </div>

        <Rail active={railOn} ink={railOn >= 1 && railOn <= 3} top={railTop} onGo={goTo} />
        <Footer mode={footerMode} scale={box?.s ?? 1} onOpen={setFooter} onTop={goHome} />
      </div>

      {menu && <MenuPanel onClose={() => setMenu(false)} />}
      <style>{CSS}</style>
    </div>
  );
}

function Card({ slide, role }: { slide: Slide; role: Role }) {
  const { l, t, r } = slide.card;
  const a = slide.art;
  // Scale the art so its card is exactly as wide as the design's card.
  const k = (r - l) / (a.r - a.l);
  // Transform origin = the card's top-left corner inside the scaled image.
  const ox = a.l * k;
  const oy = a.t * k;
  // Clip to the card only (while it peeks, like the design).
  const clip = `inset(${oy}px ${(a.w - a.r) * k}px 0px ${ox}px round 40px)`;
  const peek = `translate(${PEEK.l - l}px, ${PEEK.t - t}px)`;
  const hero = `translate(${HERO_WITCH.l - l}px, ${HERO_WITCH.t - t}px) rotate(${HERO_WITCH.rot}deg) scale(${HERO_WITCH.scale})`;
  const style = {
    left: l - ox,
    top: t - oy,
    width: a.w * k,
    height: a.h * k,
    transformOrigin: `${ox}px ${oy}px`,
    "--clip": clip,
    "--peek": peek,
    "--hero": hero,
  } as React.CSSProperties;
  const named = role === "main" || role === "from-peek" || role === "from-hero";
  return (
    <img
      className={`hc-card hc-role-${role} ${role === "main" ? "hc-tilt" : ""}`}
      src={a.src}
      alt={named ? slide.title.join(" ") : ""}
      width={a.w}
      height={a.h}
      decoding="async"
      style={style}
    />
  );
}

function FanCardView({ card: c, tilt }: { card: FanCard; tilt?: boolean }) {
  const h = c.w * CARD_RATIO;
  const inset = c.w * 0.045; // rim sits this far inside the card edge
  return (
    <div
      className={`hc-fcard ${c.dim ? "hc-fcard-dim" : ""} ${tilt ? "hc-tilt" : ""}`}
      style={{ left: c.x, top: c.y, width: c.w, height: h, borderRadius: c.w * 0.12, "--rot": `${c.rot}deg` } as React.CSSProperties}
    >
      <img
        src={c.src}
        alt={c.name}
        decoding="async"
        style={{ left: c.w * c.art.left, top: c.w * c.art.top, width: c.w * c.art.width }}
      />
      <span
        className="hc-fcard-rim"
        style={{ inset, borderWidth: Math.max(2, c.w * 0.019), borderColor: c.rim, borderRadius: c.w * 0.085 }}
      />
    </div>
  );
}

// The five characters, dealt face-up onto the felt (fan around the centre).
const DEAL = FAN.map((c, i) => ({ ...c, x: -27 + (i - 2) * 30, y: -44 + Math.abs(i - 2) * 5, w: 54, rot: (i - 2) * 9, dim: false }));

function FinalScene({ leaving, under }: { leaving: boolean; under: boolean }) {
  return (
    <div className={`hc-final ${leaving ? "hc-final-leave" : ""} ${under ? "hc-final-under" : ""}`}>
      <div className="hc-right">
        <div className="hc-spot" />
        {/* the dealer stands behind the table; the far rail hides the cut at her hands */}
        <img className="hc-lady" src="/landing/final-lady.webp" alt="The Card Flex dealer" width={1060} height={1290} />
        <img className="hc-table" src="/landing/final-table.webp" alt="" width={1774} height={737} />
        <div className="hc-felt">
          <div className="hc-deal">
            {/* dealt face-down from the dealer, then flipped face-up one by one */}
            {DEAL.map((c, i) => (
              <div key={c.name} className="hc-dealt" style={{ left: c.x, top: c.y, animationDelay: `${0.62 + i * 0.09}s` }}>
                <div className="hc-turn" style={{ transform: `rotate(${c.rot}deg)` }}>
                  <div
                    className="hc-flip"
                    style={{ width: c.w, height: c.w * CARD_RATIO, animationDelay: `${1.15 + i * 0.13}s` }}
                  >
                    <div className="hc-face">
                      <FanCardView card={{ ...c, x: 0, y: 0, rot: 0 }} />
                    </div>
                    <div className="hc-cback" style={{ borderRadius: c.w * 0.1 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* the Card Flex casino chip: a stack, a pile and two loose chips on the felt */}
          <Chip src="/landing/chip-stack.webp" x={-255} y={-32} w={64} delay={1.0} />
          <Chip src="/landing/chip-pile.webp" x={145} y={-28} w={110} delay={1.1} />
          <Chip src="/landing/chip-flat.webp" x={-156} y={24} w={38} delay={1.18} rot={-6} />
          <Chip src="/landing/chip-flat.webp" x={100} y={32} w={32} delay={1.24} rot={8} />
        </div>
      </div>
      <div className="hc-text hc-final-text">
        <h2>
          Take a
          <br />
          Seat
        </h2>
        <p>
          The Queen, the Jack and the King are already seated. Pull up a chair, the dealer is waiting: fast hands,
          private cards, and every deal can be checked.
        </p>
        <Link href="/tables" className="hc-explore hc-play">
          <span className="hc-explore-dot">▶</span>
          Play now
        </Link>
      </div>
    </div>
  );
}

function Chip({ src, x, y, w, delay, rot = 0 }: { src: string; x: number; y: number; w: number; delay: number; rot?: number }) {
  return (
    <div className="hc-chip" style={{ left: x, top: y, width: w, animationDelay: `${delay}s` }}>
      <img src={src} alt="" style={{ width: w, transform: rot ? `rotate(${rot}deg)` : undefined }} />
    </div>
  );
}

const FOOTER_COLS: { title: string; links: { label: string; href: string; ext?: boolean }[] }[] = [
  { title: "Play", links: [{ label: "Tables", href: "/tables" }, { label: "Dashboard", href: "/dashboard" }, { label: "Verify a hand", href: "/verify" }] },
  { title: "Learn", links: [{ label: "Game rules", href: "/rules" }, { label: "How fairness works", href: "/rules#fair" }] },
  { title: "Project", links: [{ label: "GitHub", href: REPO, ext: true }, { label: "Apache-2.0 licence", href: `${REPO}/blob/main/LICENSE`, ext: true }] },
  // Terms and Privacy pages don't exist yet: placeholders.
  { title: "Legal", links: [{ label: "Terms", href: "#" }, { label: "Privacy", href: "#" }, { label: "Play responsibly · 18+", href: "/rules" }] },
];

function Rail({ active, ink, top, onGo }: { active: number; ink: boolean; top: number; onGo: (i: number) => void }) {
  return (
    <nav className={`hc-rail ${ink ? "hc-rail-ink" : ""}`} style={{ top }} aria-label="Pages">
      <span className="hc-rail-line" />
      <span className="hc-rail-fill" style={{ height: Math.min(active, 4) * RAIL_GAP }} />
      {RAIL.map((label, i) => (
        <button
          key={label}
          type="button"
          className={`hc-rail-dot ${i === active ? "is-on" : ""} ${i === 5 ? "is-more" : ""}`}
          style={{ top: i * RAIL_GAP }}
          onClick={() => onGo(i)}
          aria-label={label}
          aria-current={i === active ? "step" : undefined}
        >
          <em>{label}</em>
        </button>
      ))}
    </nav>
  );
}


function Footer({
  mode,
  scale,
  onOpen,
  onTop,
}: {
  mode: "hidden" | "peek" | "open";
  scale: number;
  onOpen: (open: boolean) => void;
  onTop: () => void;
}) {
  const open = mode === "open";
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ y: number; start: number; max: number; moved: boolean } | null>(null);
  // Drag the strip: the panel follows the finger/mouse, then snaps open or shut.
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (mode === "hidden" || !ref.current || (e.target as HTMLElement).closest("a")) return;
    const max = ref.current.offsetHeight - 104; // open -> peek distance
    drag.current = { y: toView(e.clientX, e.clientY).y, start: open ? 0 : max, max, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
    ref.current.style.transition = "none";
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    const dy = (toView(e.clientX, e.clientY).y - d.y) / scale;
    if (Math.abs(dy) > 4) d.moved = true;
    ref.current.style.transform = `translateY(${Math.min(d.max, Math.max(0, d.start + dy))}px)`;
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !ref.current) return;
    ref.current.style.transition = "";
    ref.current.style.transform = "";
    onOpen(d.moved ? d.start + (toView(e.clientX, e.clientY).y - d.y) / scale < d.max / 2 : !open);
  };
  const tab = open ? 0 : -1;
  return (
    <footer ref={ref} className={`hc-footer hc-fmode-${mode}`} aria-hidden={mode === "hidden"}>
      <div
        className="hc-peekbar"
        role="button"
        tabIndex={mode === "hidden" ? -1 : 0}
        aria-expanded={open}
        aria-label={open ? "Close footer" : "Open footer"}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(!open);
        }}
      >
        <span className="hc-grab" />
        <span className="hc-peek-label">
          {open ? "Close" : "More about Card Flex"} <b>{open ? "↓" : "↑"}</b>
        </span>
        <span className="hc-peek-icons">
          <a href="#" aria-label="X" tabIndex={mode === "peek" ? 0 : -1}>
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
              <path fill="currentColor" d={X_ICON} />
            </svg>
          </a>
          <a href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub" tabIndex={mode === "peek" ? 0 : -1}>
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
              <path fill="currentColor" d={GH_ICON} />
            </svg>
          </a>
        </span>
      </div>
      <div className="hc-footer-in">
        <div className="hc-footer-brand">
          <div className="hc-footer-logo">
            <img src="/landing/logo.webp" alt="Card Flex" width={560} height={402} />
          </div>
          <p>Three-card play on Solana with private cards and a shuffle anyone can check after every hand.</p>
          <div className="hc-social">
            {/* X account doesn't exist yet: placeholder link */}
            <a href="#" aria-label="X" tabIndex={tab}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path fill="currentColor" d={X_ICON} />
              </svg>
            </a>
            <a href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub" tabIndex={tab}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                <path fill="currentColor" d={GH_ICON} />
              </svg>
            </a>
          </div>
        </div>
        <nav className="hc-footer-cols">
          {FOOTER_COLS.map((col) => (
            <div key={col.title}>
              <h4>{col.title}</h4>
              {col.links.map((l) =>
                l.ext ? (
                  <a key={l.label} href={l.href} target="_blank" rel="noreferrer" tabIndex={tab}>
                    {l.label}
                  </a>
                ) : (
                  <Link key={l.label} href={l.href} tabIndex={tab}>
                    {l.label}
                  </Link>
                ),
              )}
            </div>
          ))}
        </nav>
      </div>
      <div className="hc-footer-base">
        <p>
          Devnet preview. Cards are dealt inside MagicBlock&apos;s private rollup on Intel TDX hardware; the hardware and
          its operator are trusted. Every finished hand can be verified.
        </p>
        <button type="button" className="hc-top" onClick={onTop} tabIndex={tab}>
          ↑ Back to top
        </button>
      </div>
    </footer>
  );
}

function Cloud() {
  return (
    <svg className="hc-cloud" viewBox="820 0 460 270" width={460} height={270} aria-hidden>
      <defs>
        <linearGradient id="hc-cloud-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#00434d" />
          <stop offset="1" stopColor="#003038" />
        </linearGradient>
      </defs>
      <g fill="url(#hc-cloud-g)">
        <circle cx="1225" cy="60" r="135" />
        <circle cx="1120" cy="135" r="70" />
        <circle cx="1045" cy="160" r="58" />
        <circle cx="975" cy="150" r="56" />
        <circle cx="912" cy="176" r="46" />
        <circle cx="870" cy="200" r="30" />
        <rect x="870" y="150" width="400" height="80" rx="40" />
      </g>
      <g fill="#00525c" opacity=".55">
        <circle cx="1000" cy="128" r="30" />
        <circle cx="1092" cy="104" r="34" />
        <circle cx="940" cy="150" r="22" />
      </g>
    </svg>
  );
}

const EASE = "cubic-bezier(.65,0,.25,1)";
const OUT = "cubic-bezier(.2,.8,.2,1)";

const CSS = `
.hc-root{position:fixed;inset:0;z-index:100;overflow:hidden;overscroll-behavior:none;touch-action:none;user-select:none;font-family:var(--font-outfit),system-ui,sans-serif}
.hc-stage{position:absolute;left:0;top:0;transform-origin:0 0}
.hc-stage a{color:inherit;text-decoration:none}
.hc-stage img{display:block;max-width:none;-webkit-user-drag:none}
.hc-right{position:absolute;right:0;top:0;width:${W}px;height:${H}px;pointer-events:none}
.hc-right > *{pointer-events:auto}
.hc-hero,.hc-slides{position:absolute;inset:0}

/* layers: frame 1 = hero 1 < wipe 2 = frame copy 2 < slides 3 < chrome 6 */
.hc-hero{z-index:1}
.hc-wipe,.hc-fade{z-index:2}
.hc-slides{z-index:3}

.hc-frame{position:absolute;left:38px;right:45px;top:75px;height:803px;border:8px solid #1d3743;border-radius:64px;pointer-events:none;z-index:1}
.hc-frame-top{z-index:2}
.hc-logo{position:absolute;left:156px;top:134px;z-index:6;transition:transform .25s}
.hc-logo:hover{transform:scale(1.04)}
.hc-logo img{height:96px;width:auto}
.hc-logo-gold{filter:drop-shadow(0 4px 10px rgba(0,0,0,.35));transition:opacity .45s ease}
/* tinted copy: the logo's own shading (grey) multiplied with the page's ink colour */
.hc-logo-ink{position:absolute;inset:0;isolation:isolate;opacity:0;transition:opacity .45s ease;filter:drop-shadow(0 3px 6px rgba(255,255,255,.18))}
.hc-logo-fill{position:absolute;inset:0;background:var(--tint,#4b1d9e);transition:background-color .45s ease;-webkit-mask:url(/landing/logo.webp) 0 0/auto 100% no-repeat;mask:url(/landing/logo.webp) 0 0/auto 100% no-repeat}
.hc-logo-ink img{position:absolute;left:0;top:0;mix-blend-mode:multiply;filter:grayscale(1) brightness(1.45) contrast(1.15)}
.hc-logo.is-tinted .hc-logo-gold{opacity:0}
.hc-logo.is-tinted .hc-logo-ink{opacity:1}
.hc-chrome{z-index:6}
.hc-links{position:absolute;top:162px;left:640px;height:46px;display:flex;align-items:center}
.hc-links a{font-size:14px;font-weight:500;color:#fff;width:84px;text-align:center;transition:opacity .2s,color .4s}
.hc-links a:hover{opacity:.7}
.hc-ink .hc-links a{color:#140f11}
.hc-topbar .hc-wallet{position:absolute;left:908px;top:162px;width:146px;height:46px}
.hc-wallet .hc-buy{width:100%;height:100%;padding:0}
.hc-topbar .hc-menu-btn{position:absolute;left:1064px;top:162px}
.hc-next{position:absolute;left:1113px;top:731px;width:97px;height:73px;border-radius:37px;background:#fff;border:0;font:500 14px var(--font-outfit),sans-serif;color:#140f11;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.1);transition:transform .2s}
.hc-next:hover{transform:scale(1.05)}
.hc-next-in{animation:hc-pop-in .5s ${OUT} .45s both}

/* ---------- hero ---------- */
.hc-blob{position:absolute;left:-258px;top:-220px;width:436px;height:436px;border-radius:50%;background:#92cceb}
.hc-cloud{position:absolute;left:820px;top:0}
.hc-hero-art{position:absolute;inset:0}
.hc-fcard{position:absolute;transform-origin:0 0;background:#1b2e3a;overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.35)}
.hc-fcard img{position:absolute;height:auto;max-width:none}
.hc-fcard-rim{position:absolute;border-style:solid;pointer-events:none}
/* the back row sits in shadow and fades into the background, like the design */
.hc-fcard-dim{filter:brightness(.48) saturate(.85);-webkit-mask-image:linear-gradient(to bottom,#000 48%,transparent 96%);mask-image:linear-gradient(to bottom,#000 48%,transparent 96%);box-shadow:none}
/* text moves right into the free width on wide screens (none at 1280, up to 40px) */
.hc-text{position:absolute;left:calc(163px + min(40px, var(--gap, 0) * .1px));color:#140f11}
.hc-text p{font-size:calc(15px * var(--k));line-height:1.63;font-weight:400;margin:0}
.hc-hero-text{top:calc(410px - (var(--k) - 1) * 200px);color:#fff;width:calc(420px * var(--k))}
.hc-hero-text h1{font-size:calc(74px * var(--k));line-height:1.2;font-weight:500;letter-spacing:-1px;white-space:nowrap;margin:0 0 18px}
.hc-hero-text h1 small{display:block;margin-bottom:6px;font-size:.42em;line-height:1.2;font-weight:500;letter-spacing:4px;color:#ffd76a}
.hc-hero-text p{color:rgba(255,255,255,.9);width:calc(380px * var(--k));font-size:calc(14.5px * var(--k))}
.hc-explore{margin-top:calc(22px * var(--k));width:calc(154px * var(--k));height:calc(56px * var(--k));border-radius:99px;background:#ffe800;border:0;display:flex;align-items:center;gap:calc(19px * var(--k));padding-left:calc(9px * var(--k));font:600 calc(13px * var(--k)) var(--font-outfit),sans-serif;color:#140f11;cursor:pointer;transition:transform .2s}
.hc-explore:hover{transform:translateY(-2px)}
.hc-explore-dot{width:calc(40px * var(--k));height:calc(40px * var(--k));border-radius:50%;background:#fff;display:grid;place-items:center;font-size:calc(15px * var(--k));font-weight:700}

/* first load + coming back home */
.hc-hero .hc-hero-text > *{animation:hc-up .8s ${OUT} both}
.hc-hero .hc-hero-text > p{animation-delay:.08s}
.hc-hero .hc-hero-text > button{animation-delay:.16s}
.hc-hero .hc-hero-art{animation:hc-fan .9s ${OUT} both}
.hc-hero .hc-cloud{animation:hc-fade .8s both}
.hc-hero .hc-blob{animation:hc-fade .6s both}
.hc-hero-enter .hc-blob{animation:hc-blob-home .6s ${OUT} both}
/* leaving via Explore: text lifts while the blue circle covers it */
.hc-hero-leave .hc-hero-text{animation:hc-lift .45s ${EASE} both}

/* ---------- wipes ---------- */
.hc-wipe{position:absolute;width:4200px;height:4200px;margin:-2100px 0 0 -2100px;border-radius:50%;pointer-events:none}
.hc-wipe-explore{animation:hc-wipe .48s ${EASE} .05s both}
.hc-wipe-next{animation:hc-wipe .5s ${EASE} .12s both}
.hc-fade{position:absolute;inset:-200px;animation:hc-fade .32s ease-in both}
.hc-slides-leave{animation:hc-slides-out .32s ease-in both}

/* ---------- slide text ---------- */
.hc-slide-text{top:calc(300px - (var(--k) - 1) * 120px);width:calc(360px * var(--k));height:calc(520px * var(--k))}
.hc-copy{position:absolute;left:0;top:0;width:calc(360px * var(--k))}
.hc-slide-text h2{font-size:calc(67px * var(--k));line-height:1.1;font-weight:500;letter-spacing:-.5px;margin:0 0 26px}
.hc-copy-out{animation:hc-copy-out .3s ease-in .12s both}
.hc-copy-in{animation:hc-copy-in .45s ${OUT} .22s both}
.hc-num{position:absolute;left:0;top:calc(333px * var(--k));width:calc(134px * min(var(--k), 1.15));height:calc(134px * min(var(--k), 1.15));border-radius:50%;background:#fff;color:#140f11;font-size:calc(46px * min(var(--k), 1.15));font-weight:600}
.hc-num span{position:absolute;inset:0;display:grid;place-items:center}
.hc-num-out{animation:hc-num-out .28s ease-in .12s both}
.hc-num-in{animation:hc-num-in .4s ${OUT} .25s both}
.hc-rise h2,.hc-rise p,.hc-rise .hc-num{animation:hc-rise .62s ${OUT} both}
.hc-rise h2{animation-delay:.3s}
.hc-rise p{animation-delay:.36s}
.hc-rise .hc-num{animation-delay:.4s}

/* ---------- cards ---------- */
.hc-card{position:absolute}
.hc-role-peek{transform:var(--peek);clip-path:var(--clip)}
.hc-role-exit{z-index:0;animation:hc-exit .8s ${EASE} both}
.hc-role-from-peek{z-index:2;animation:hc-from-peek .8s ${EASE} both}
.hc-role-from-hero{z-index:2;animation:hc-from-hero .9s ${EASE} both}
.hc-card.hc-role-peek-in{animation:hc-peek-in .6s ${OUT} .3s both}
.hc-vampire{position:absolute;inset:0}
.hc-vampire .hc-fcard::after{content:"";position:absolute;inset:0;background:linear-gradient(to bottom,transparent 35%,rgba(10,14,20,.6) 75%);pointer-events:none}
.hc-vampire.hc-role-peek-in{animation:hc-slide-in .6s ${OUT} .3s both}

@keyframes hc-wipe{from{transform:scale(0)}to{transform:scale(1)}}
@keyframes hc-fade{from{opacity:0}to{opacity:1}}
@keyframes hc-up{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:none}}
@keyframes hc-lift{to{transform:translateY(-34px);opacity:.6}}
@keyframes hc-fan{from{opacity:0;transform:translateY(60px) scale(1.06)}to{opacity:1;transform:none}}
@keyframes hc-blob-home{from{transform:translate(620px,40px) scale(3.4);opacity:.55}to{transform:none;opacity:1}}
@keyframes hc-slides-out{to{opacity:0;transform:scale(1.03)}}
@keyframes hc-rise{from{opacity:0;transform:translateY(230px)}to{opacity:1;transform:none}}
@keyframes hc-copy-out{to{opacity:0}}
@keyframes hc-copy-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes hc-num-out{to{opacity:0;transform:scale(.6)}}
@keyframes hc-num-in{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes hc-pop-in{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}
@keyframes hc-exit{
  0%{transform:none;opacity:1}
  65%{transform:translate(30px,230px) scale(.55);opacity:1}
  100%{transform:translate(40px,520px) scale(.5);opacity:0}
}
@keyframes hc-from-peek{
  0%{transform:var(--peek);clip-path:var(--clip)}
  30%{clip-path:var(--clip)}
  45%{clip-path:inset(0px 0px 0px 0px round 0px)}
  100%{transform:none;clip-path:inset(0px 0px 0px 0px round 0px)}
}
@keyframes hc-from-hero{
  0%{transform:var(--hero);clip-path:var(--clip)}
  40%{clip-path:var(--clip)}
  55%{clip-path:inset(0px 0px 0px 0px round 0px)}
  100%{transform:none;clip-path:inset(0px 0px 0px 0px round 0px)}
}
@keyframes hc-peek-in{from{transform:var(--peek) translateX(260px);clip-path:var(--clip)}to{transform:var(--peek);clip-path:var(--clip)}}
@keyframes hc-slide-in{from{transform:translateX(200px)}to{transform:none}}
/* ---------- final page ---------- */
.hc-wipe-final{z-index:4;animation:hc-wipe .5s ${EASE} .05s both}
.hc-frame-final{z-index:4}
.hc-final{position:absolute;inset:0;z-index:4;transform-origin:50% 25%;transition:filter .6s ease,transform .65s cubic-bezier(.22,1,.36,1)}
.hc-final-under{filter:brightness(.42) saturate(.85);transform:scale(.965)}
.hc-final-leave{animation:hc-slides-out .32s ease-in both}
.hc-spot{position:absolute;left:520px;top:120px;width:640px;height:560px;border-radius:50%;background:radial-gradient(closest-side,rgba(190,70,255,.38),rgba(120,30,220,.12) 60%,transparent);animation:hc-fade .9s ease-out .35s both}
.hc-lady{position:absolute;left:676px;top:212px;width:329px;height:auto;animation:hc-lady .9s ${OUT} .5s both}
.hc-table{position:absolute;left:430px;top:595px;width:820px;height:auto;-webkit-mask-image:radial-gradient(ellipse 52% 60% at 50% 42%,#000 78%,transparent 100%);mask-image:radial-gradient(ellipse 52% 60% at 50% 42%,#000 78%,transparent 100%);animation:hc-table .85s ${OUT} .3s both}
.hc-felt{position:absolute;left:840px;top:684px;width:0;height:0;animation:hc-table .85s ${OUT} .3s both}
.hc-deal{position:absolute;left:0;top:0;transform:perspective(700px) rotateX(52deg);transform-style:preserve-3d}
.hc-dealt{position:absolute;animation:hc-deal .55s ${OUT} both;transform-style:preserve-3d}
.hc-turn,.hc-flip{transform-style:preserve-3d}
.hc-flip{position:relative;animation:hc-flip .6s ${OUT} both}
.hc-face,.hc-cback{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden}
.hc-face .hc-fcard{box-shadow:0 6px 10px rgba(0,0,0,.45)}
.hc-cback{transform:rotateY(180deg);background:#2a0d40 url(/landing/card-back.webp) center/100% 100% no-repeat;box-shadow:0 6px 10px rgba(0,0,0,.45)}
@keyframes hc-flip{from{transform:rotateY(180deg)}to{transform:rotateY(0deg)}}
.hc-chip{position:absolute;animation:hc-chip-drop .6s ${OUT} both}
@keyframes hc-chip-drop{0%{opacity:0;transform:translateY(-46px)}55%{opacity:1;transform:translateY(3px)}75%{transform:translateY(-5px)}100%{opacity:1;transform:none}}
.hc-chip img{display:block;height:auto;filter:drop-shadow(0 5px 6px rgba(0,0,0,.4))}

.hc-final-text{top:calc(300px - (var(--k) - 1) * 120px);width:calc(380px * var(--k));color:#fff}
.hc-final-text h2{font-size:calc(67px * var(--k));line-height:1.1;font-weight:500;letter-spacing:-.5px;margin:0 0 26px}
.hc-final-text p{color:rgba(255,255,255,.86);width:calc(350px * var(--k))}
.hc-final-text > *{animation:hc-rise .62s ${OUT} both}
.hc-final-text h2{animation-delay:.4s}
.hc-final-text p{animation-delay:.46s}
.hc-play{margin-top:calc(34px * var(--k));width:calc(166px * var(--k));animation-delay:.52s !important;text-decoration:none}
.hc-stage a.hc-play{color:#140f11}
.hc-play .hc-explore-dot{font-size:calc(12px * var(--k));padding-left:2px}
@keyframes hc-table{from{opacity:0;transform:translateY(140px)}to{opacity:1;transform:none}}
@keyframes hc-lady{from{opacity:0;transform:translateY(70px) scale(.96)}to{opacity:1;transform:none}}
@keyframes hc-deal{from{opacity:0;transform:translate(0,-320px) rotate(-25deg) scale(.7)}to{opacity:1;transform:none}}

/* ---------- footer panel (slides up over the final page; never scrolls) ---------- */
.hc-footer{position:absolute;left:0;right:0;bottom:-40px;height:510px;z-index:7;transition:transform .7s cubic-bezier(.22,1.15,.36,1);
  background:linear-gradient(180deg,#1f0a40 0%,#12052a 55%,#0b0118 100%);border-top:2px solid rgba(214,58,249,.55);border-radius:48px 48px 0 0;
  box-shadow:0 -24px 70px rgba(150,40,255,.35);color:#e9ddff}
.hc-fmode-hidden{transform:translateY(100%)}
.hc-fmode-peek{transform:translateY(calc(100% - 104px))}
.hc-fmode-peek:hover{transform:translateY(calc(100% - 120px))}
.hc-fmode-open{transform:none}
.hc-peekbar{position:relative;height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 170px 0 163px;cursor:grab;touch-action:none;user-select:none}
.hc-peekbar:active{cursor:grabbing}
.hc-grab{position:absolute;left:50%;top:9px;width:64px;height:5px;margin-left:-32px;border-radius:3px;background:rgba(233,221,255,.4)}
.hc-peek-label{font-size:14px;font-weight:600;letter-spacing:.4px;color:#fff}
.hc-peek-label b{color:#ffe800;margin-left:6px;display:inline-block;animation:hc-nudge 1.8s ease-in-out infinite}
.hc-fmode-open .hc-peek-label b{animation:none}
.hc-peek-icons{display:flex;gap:10px;transition:opacity .3s}
.hc-fmode-open .hc-peek-icons{opacity:0;pointer-events:none}
.hc-peek-icons a{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(214,58,249,.35);color:#fff;transition:background .2s}
.hc-peek-icons a:hover{background:rgba(214,58,249,.35)}
@keyframes hc-nudge{0%,100%{transform:none}50%{transform:translateY(-3px)}}
.hc-footer-in{display:flex;gap:56px;padding:20px 170px 0 163px}
.hc-footer-brand{width:360px;flex:none}
.hc-footer-logo img{height:84px;width:auto;margin-left:-4px;filter:drop-shadow(0 6px 14px rgba(0,0,0,.45))}
.hc-footer-brand p{margin:14px 0 0;font-size:14.5px;line-height:23px;color:rgba(233,221,255,.75)}
.hc-social{display:flex;gap:12px;margin-top:20px}
.hc-social a{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(214,58,249,.35);font-size:17px;color:#fff;transition:background .2s}
.hc-social a:hover{background:rgba(214,58,249,.35)}
.hc-footer-cols{flex:1;display:grid;grid-template-columns:repeat(4,auto);justify-content:space-between;gap:28px}
.hc-footer-cols h4{margin:6px 0 18px;font-size:13px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#ffe800}
.hc-footer-cols a{display:block;margin:0 0 13px;font-size:15px;color:rgba(233,221,255,.85);transition:color .2s}
.hc-footer-cols a:hover{color:#fff}
.hc-footer-base{position:absolute;left:163px;right:170px;top:350px;display:flex;align-items:center;justify-content:space-between;gap:40px;padding-top:22px;border-top:1px solid rgba(214,58,249,.25)}
.hc-footer-base p{margin:0;font-size:12.5px;line-height:19px;color:rgba(233,221,255,.6);max-width:640px}
.hc-top{flex:none;height:46px;padding:0 22px;border-radius:23px;border:0;background:#ffe800;color:#140f11;font:600 13px var(--font-outfit),sans-serif;cursor:pointer;transition:transform .2s}
.hc-top:hover{transform:translateY(-2px)}

/* ---------- rail jump + arrival ---------- */
.hc-frame-jump{z-index:5}
.hc-wipe-jump{z-index:5;animation:hc-wipe .55s ${EASE} both}
.hc-arrive .hc-slides,.hc-arrive .hc-final{animation:hc-fade .45s ease-out both}

/* ---------- progress rail ---------- */
.hc-rail{position:absolute;right:10px;width:20px;height:${RAIL_GAP * 5}px;z-index:8}
.hc-rail-line,.hc-rail-fill{position:absolute;left:9px;top:0;width:2px;border-radius:1px}
.hc-rail-line{height:${RAIL_GAP * 4}px;background:rgba(255,255,255,.2)}
.hc-rail-fill{background:linear-gradient(#ffe800,#d63af9);transition:height .6s ${EASE}}
.hc-rail-dot{position:absolute;left:0;width:20px;height:20px;margin-top:-10px;border:0;padding:0;background:none;cursor:pointer}
.hc-rail-dot::before{content:"";position:absolute;left:5px;top:5px;width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.4);transition:all .35s ${OUT}}
.hc-rail-dot:hover::before{transform:scale(1.3)}
.hc-rail-dot.is-on::before{left:1px;top:1px;width:18px;height:18px;background:radial-gradient(circle,#ffe800 0 34%,#7b2ff2 38% 100%);box-shadow:0 0 0 2px rgba(255,232,0,.65),0 0 16px rgba(214,58,249,.85)}
.hc-rail-dot.is-more::before{left:7px;top:7px;width:6px;height:6px}
.hc-rail-dot.is-more.is-on::before{left:3px;top:3px;width:14px;height:14px}
.hc-rail-dot em{position:absolute;right:30px;top:50%;transform:translate(6px,-50%);white-space:nowrap;font-style:normal;font-size:12px;font-weight:600;color:#fff;background:rgba(20,10,40,.85);padding:5px 10px;border-radius:9px;opacity:0;pointer-events:none;transition:all .25s}
.hc-rail-dot:hover em,.hc-rail-dot:focus-visible em{opacity:1;transform:translate(0,-50%)}
.hc-rail-ink .hc-rail-line{background:rgba(29,55,67,.3)}
.hc-rail-ink .hc-rail-dot::before{background:rgba(29,55,67,.5)}
.hc-rail-ink .hc-rail-dot.is-on::before{background:radial-gradient(circle,#ffe800 0 34%,#1d3743 38% 100%)}

/* ---------- scroll hint (first visit) ---------- */
.hc-hint{display:flex;align-items:center;gap:12px;margin-top:40px;font-size:11.5px;font-weight:600;letter-spacing:1.8px;text-transform:uppercase;color:rgba(255,255,255,.62)}
.hc-hero .hc-hero-text > .hc-hint{animation-delay:.5s}
.hc-mouse{position:relative;width:22px;height:34px;border:2px solid rgba(255,255,255,.62);border-radius:12px}
.hc-mouse i{position:absolute;left:50%;top:6px;width:4px;height:7px;margin-left:-2px;border-radius:2px;background:#ffe800;animation:hc-wheel 1.6s ease-in-out infinite}
@keyframes hc-wheel{0%{opacity:0;transform:translateY(-2px)}30%{opacity:1}80%{opacity:0;transform:translateY(9px)}100%{opacity:0}}

/* ---------- card hover: a slight lift (cards only) ---------- */
.hc-fcard{transform:rotate(var(--rot,0deg)) perspective(1200px) rotateX(var(--tx,0deg)) rotateY(var(--ty,0deg))}
.hc-fcard,.hc-card.hc-role-main,.hc-turn{transition:transform .5s cubic-bezier(.2,.8,.2,1),translate .4s cubic-bezier(.2,.8,.2,1),filter .35s ease,box-shadow .35s ease}
.hc-tilt.is-tilting{transition:transform .25s ease-out,translate .4s cubic-bezier(.2,.8,.2,1),filter .35s ease,box-shadow .35s ease}
.hc-card.hc-role-main{transform-origin:50% 50% !important;transform:perspective(1600px) rotateX(var(--tx,0deg)) rotateY(var(--ty,0deg))}
/* light sheen that follows the cursor across the card */
.hc-fcard.hc-tilt::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;opacity:0;transition:opacity .35s;
  background:radial-gradient(circle at var(--gx,50%) var(--gy,30%),rgba(255,255,255,.14),rgba(255,255,255,0) 55%)}
.hc-fcard.hc-tilt.is-tilting::after{opacity:1}
.hc-hero .hc-fcard:hover{translate:0 -6px;z-index:2;box-shadow:0 24px 44px rgba(0,0,0,.5)}
.hc-hero .hc-fcard-dim:hover{filter:brightness(.7) saturate(.9)}
.hc-card.hc-role-main:hover{translate:0 -5px;filter:drop-shadow(0 20px 26px rgba(0,0,0,.3))}
.hc-dealt:hover .hc-turn{translate:0 -6px}

/* ---------- portrait phones: text on top, art anchored to the bottom ---------- */
.hc-portrait .hc-frame{left:18px;right:18px;top:56px;height:calc(var(--sh) - 110px);border-width:6px;border-radius:44px}
.hc-portrait .hc-logo{left:50px;top:70px}
.hc-portrait .hc-logo img{height:96px}
.hc-portrait .hc-blob{scale:.4}
.hc-portrait .hc-links,.hc-portrait .hc-cloud{display:none}
.hc-portrait .hc-right.hc-topbar{left:0;right:0;top:0;bottom:auto;width:auto;height:0;transform:none}
.hc-portrait .hc-wallet{left:auto;right:136px;top:94px;width:170px;height:56px}
.hc-portrait .hc-buy{font-size:16px;border-radius:16px}
.hc-portrait .hc-menu-btn{left:auto;right:64px;top:94px;width:56px;height:56px;border-radius:16px}
.hc-portrait .hc-pop{width:300px;zoom:1.4}
.hc-portrait .hc-right{left:0;right:auto;top:auto;bottom:0;transform-origin:0 100%;transform:translateX(calc(-540px * var(--pk))) scale(var(--pk))}
.hc-portrait .hc-final .hc-right{transform:translateX(calc(-420px * var(--fk))) scale(var(--fk))}
.hc-portrait .hc-text{left:56px}
.hc-portrait .hc-hero-text,.hc-portrait .hc-slide-text,.hc-portrait .hc-final-text{top:186px}
.hc-portrait .hc-slide-text,.hc-portrait .hc-copy{width:608px}
.hc-portrait .hc-num{left:auto;right:0;top:4px;width:112px;height:112px;font-size:40px}
.hc-portrait .hc-rail{right:-2px}
.hc-portrait .hc-footer{height:auto}
.hc-portrait .hc-peekbar{padding:0 40px}
.hc-portrait .hc-footer-in{flex-direction:column;gap:34px;padding:20px 56px 0}
.hc-portrait .hc-footer-cols{grid-template-columns:repeat(2,auto);justify-content:start;gap:26px 80px}
.hc-portrait .hc-footer-base{position:static;margin:34px 56px 0;flex-direction:column;align-items:flex-start;gap:18px;padding-bottom:76px}

@media (prefers-reduced-motion: reduce){.hc-stage *{animation-duration:1ms !important;animation-delay:0s !important;transition:none !important}}
`;
