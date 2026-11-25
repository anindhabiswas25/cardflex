// A themed board's table page (Amethyst first): the board's hall, dealer and
// table fill one screen; seats sit around the rim, your cards rest on the front
// rim, and your actions are split either side of your character. All game logic
// comes from useTable via TableView; only the look is new.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PHASE, rules } from "@card-flex/client-sdk";
import { Avatar } from "./Avatar";
import { ExitSummary } from "./ExitSummary";
import { Sol } from "./Sol";
import { Panel, StatusBadge, phaseText, type T } from "./TableView";
import { cardArt, strengthPct } from "@/lib/cards";
import { DEAL_LEAD_MS, DEAL_STEP_MS } from "@/lib/sound";
import { CATEGORY_LABEL, END_REASON, hashIndex, short, sol } from "@/lib/format";
import type { Board } from "@/lib/lobby";
import type { useTee } from "@/lib/tee";
import type { SeatView } from "@/lib/useTable";

// Seat spots in % of the scene (spot 0 = you, drawn in your own area below).
const SPOTS = [
  { x: 50, y: 90 },
  { x: 16, y: 79 },
  { x: 2, y: 69 },
  { x: 10, y: 40 },
  { x: 90, y: 40 },
  { x: 98, y: 69 },
  { x: 84, y: 79 },
];
// Bets on the felt, toward each spot.
const BETS = [
  { x: 78, y: 56 }, // you: beside the pot, clear of your cards
  { x: 34, y: 62 },
  { x: 14, y: 60 },
  { x: 24, y: 46 },
  { x: 76, y: 46 },
  { x: 86, y: 60 },
  { x: 66, y: 62 },
];
// The deck in front of the dealer, where every card flies from (in % of the scene).
const DECK = { x: 50, y: 44 };
// Your own seat (drawn below the scene) for chips flying to you.
const ME_SPOT = { x: 50, y: 112 };
/** CSS offsets from a spot back to the deck / pot, in scene units (--sw wide, .735 --sw tall). */
const from = (spot: { x: number; y: number }, to = DECK) =>
  ({ "--from-x": `calc(var(--sw) * ${((to.x - spot.x) / 100).toFixed(3)})`, "--from-y": `calc(var(--sw) * ${(((to.y - spot.y) * 0.735) / 100).toFixed(3)})` }) as React.CSSProperties;
const POT = { x: 50, y: 53 };
const IN_PLAY: number[] = [PHASE.DEALT, PHASE.HAND_COMPLETE, PHASE.REVEALED];
const LAYOUT: Record<number, number[]> = { 2: [0, 4], 3: [0, 3, 4], 4: [0, 2, 4, 5], 5: [0, 2, 3, 4, 5], 6: [0, 1, 2, 3, 4, 5] };

type Props = {
  board: Board;
  t: T;
  name: string;
  tableId: string;
  tee: ReturnType<typeof useTee>;
  n: number;
  anchor: number;
  avatars: Map<string, number>;
  pot: bigint;
  potKey: number;
  me: SeatView | null;
  showMeBottom: boolean;
  myTurn: boolean;
  progress: number;
  openSeats: number[];
  canJoin: boolean;
  pickSeat: number | null;
  setPickSeat: (s: number | null) => void;
  wallet: boolean;
  balance: bigint | null;
};

export function BoardTable(p: Props) {
  const { board, t, name, tableId, tee, n, anchor, avatars, pot, potKey, me, showMeBottom, myTurn, progress } = p;
  const rt = t.rt;
  const spotOf = (seat: number) => LAYOUT[n]?.[(seat - anchor + n) % n] ?? 0;
  const back = `/cards/back-${board}.webp`;
  const busy = !!t.busy;
  const l = t.legal;
  const g = rt?.game;
  const respond = !!g && g.phase === 1 && g.ss_target === t.mySeat && rt?.phase === PHASE.DEALT;
  const handActive = rt?.phase === PHASE.DEALT && !!me?.dealt && me.status !== "packed";
  const base = g ? (me?.status === "seen" ? 2n * g.stake : g.stake) : 0n;
  const one = l?.chaal ?? base;
  const two = l?.chaalDouble ?? 2n * base;
  const seatedLike = t.mode === "seated" || t.mode === "leaving";
  // Cards appear at the real deal (not while salts/VRF run) and fly in round the table.
  const cardsOut = !!rt && IN_PLAY.includes(rt.phase);
  const dealOrder = rt ? rt.dealing_order.slice(0, rt.dealing_count) : [];
  const dealDelay = (seat: number, k: number) => DEAL_LEAD_MS + (k * Math.max(1, dealOrder.length) + Math.max(0, dealOrder.indexOf(seat))) * DEAL_STEP_MS;
  const handKey = String(rt?.hand_no ?? "");
  const resultHere = !!t.result && !!rt && (t.result.handNo === rt.hand_no || rt.phase === PHASE.IDLE);
  const winners = resultHere ? t.result!.winners : [];
  const iWon = t.mySeat !== null && winners.includes(t.mySeat);
  // CF-078: while you hold a seat, other pages are off limits: links and the
  // Back button ask you to leave the table first (new tabs still open).
  const locked = t.mode === "seated" || t.mode === "leaving" || t.mode === "joining";
  const [navBlocked, setNavBlocked] = useState(false);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  useEffect(() => {
    if (!locked) return;
    const here = location.pathname;
    const onClick = (e: MouseEvent) => {
      if (!lockedRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === here) return;
      e.preventDefault();
      e.stopPropagation();
      setNavBlocked(true);
    };
    // Back button: keep an extra history entry and put it back when popped.
    history.pushState({ cfLock: true }, "", location.href);
    const onPop = () => {
      if (!lockedRef.current) return;
      history.pushState({ cfLock: true }, "", location.href);
      setNavBlocked(true);
    };
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPop);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPop);
    };
  }, [locked]);
  useEffect(() => { if (!locked) setNavBlocked(false); }, [locked]);

  // CF-076: top-up (add chips without leaving).
  const [topOpen, setTopOpen] = useState(false);
  const [topAmt, setTopAmt] = useState(0n);
  const inHandNow = !!rt && rt.phase !== PHASE.IDLE;
  const busted = !!me && !!rt && rt.boot > 0n && me.stack + t.topUpPending < rt.boot * 2n;
  const range = t.topUpRange;
  // Default: back up to the table's minimum buy-in (40 boots), within the allowed range.
  const defaultTopUp = range ? (() => { const want = (range.min * 40n > (me?.stack ?? 0n) ? range.min * 40n - (me?.stack ?? 0n) : range.min); const r = want - (want % range.min); return r < range.min ? range.min : r > range.max ? range.max - (range.max % range.min) : r; })() : 0n;
  // Spectators with a free seat: the buy-in is a popup over the board. It opens
  // CF-078: everyone arrives as a spectator; tapping an empty seat (+) opens
  // the seat card for that seat. Seated players play from the next hand.
  const spectatorJoin = t.mode === "spectator" && p.canJoin;
  const [joinOpen, setJoinOpen] = useState(false);
  useEffect(() => {
    if (!joinOpen) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setJoinOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [joinOpen]);
  const r = tee.result;

  return (
    <div className={`tb tb-${board} ${!seatedLike && !spectatorJoin ? "has-panel" : ""}`}>
      <img className="tb-hall" src={`/boards/${board}-hall.webp`} alt="" />
      <div className="tb-shade" />

      {/* top strip */}
      <div className="tb-strip">
        <Link href="/tables" className="tb-pill">
          ← Boards
        </Link>
        <span className="tb-pill tb-name">{name}</span>
        <span className="tb-pill">
          Boot <Sol /> {sol(rt?.boot || (t.snap ? t.snap.cfg.min_buy_in / 40n : 0n))}
        </span>
        <button
          className={`tb-pill ${r === null ? "" : r.ok ? "is-ok" : "is-bad"}`}
          onClick={() => r && !r.ok && tee.retry()}
          title={r === null ? "Checking the TEE attestation…" : r.ok ? `Intel TDX quote verified · TCB ${r.tcbStatus} · measurements pinned` : `Attestation failed: ${r.reasons.join("; ")} (click to retry)`}
          data-testid="tee-badge"
        >
          {r === null ? "◌ checking TEE" : r.ok ? "🛡 TEE verified" : "⚠ TEE unverified"}
        </button>
        {t.seated && <span className="tb-pill is-ok">● seated</span>}
      </div>

      {/* ---------- the scene ---------- */}
      <section className="tb-scene" aria-label={`Table ${name}`}>
        <span className="tb-spot" />
        <img className="tb-dealer" src={`/boards/${board}-dealer.webp`} alt="The dealer" />
        <img className={`tb-table ${board === "amethyst" ? "is-blended" : "is-cut"}`} src={`/boards/${board}-table.webp`} alt="" />

        {/* pot, or what the table is doing */}
        <div className="tb-pot">
          {t.gameLive && rt ? (
            <>
              <span key={potKey} className="tb-pot-amt pot-pop" aria-live="polite" data-testid="pot">
                <img src={`/boards/${board}-pile.webp`} alt="" />
                <Sol size="1em" /> {sol(pot)}
              </span>
              <small>
                Pot · Stake {sol(rt.game.stake)} · Boot {sol(rt.boot)}
              </small>
            </>
          ) : (
            <span className="tb-phase">{phaseText(t)}</span>
          )}
        </div>

        {/* bets on the felt */}
        {t.seats.map((s) =>
          s.bet > 0n && s.status !== "packed" && rt ? (
            <div key={`bet-${s.seat}`} className="tb-bet" style={{ left: `${BETS[spotOf(s.seat)].x}%`, top: `${BETS[spotOf(s.seat)].y}%` }}>
              <img src={`/boards/${board}-stack.webp`} alt="" />
              <span>{sol(s.bet)}</span>
            </div>
          ) : null,
        )}

        {/* other seats (yours is drawn in your area) */}
        {t.seats.map((s) =>
          s.seat === t.mySeat && showMeBottom ? null : (
            <Seat
              key={s.seat}
              s={s}
              spot={SPOTS[spotOf(s.seat)]}
              avatar={s.wallet ? avatars.get(s.wallet) : undefined}
              turn={t.toAct === s.seat}
              progress={progress}
              back={back}
              cardsOut={cardsOut}
              handKey={handKey}
              dealDelay={(k: number) => dealDelay(s.seat, k)}
              selectable={p.canJoin && s.status === "empty"}
              selected={p.pickSeat === s.seat}
              onPick={() => {
                p.setPickSeat(s.seat);
                setJoinOpen(true);
              }}
            />
          ),
        )}

        {/* your cards, resting on the front rim */}
        {showMeBottom && me && me.dealt && (cardsOut || !!me.cards) && (() => {
          const faces = [0, 1, 2].map((k) =>
            (me.status === "seen" || t.result?.shown[me.seat] || (t.result && t.result.handNo === rt?.hand_no)) && t.myCards ? t.myCards[k] : undefined,
          );
          const seen = faces.every((f) => f !== undefined) ? (faces as number[]) : null;
          const pct = seen ? strengthPct(seen) : 0;
          return (
            <div className="tb-mycards" data-testid="my-cards">
              {faces.map((face, k) => (
                <span
                  key={`${handKey}-${k}`}
                  className={`tb-card tb-deal ${face !== undefined ? "is-face" : ""} ${me.status === "packed" ? "is-packed" : ""}`}
                  style={{ "--k": k - 1, animationDelay: `${dealDelay(me.seat, k)}ms`, ...from({ x: 50, y: 72 }) } as React.CSSProperties}
                >
                  <img src={face !== undefined ? cardArt(face) : back} alt={face !== undefined ? "your card" : "hidden card"} />
                </span>
              ))}
              {seen && (
                <div className="tb-meter" data-testid="strength" style={{ "--p": pct / 100 } as React.CSSProperties}>
                  <b>{CATEGORY_LABEL[rules.categoryOf(seen)] ?? ""}</b>
                  <span className="tb-meter-bar" aria-label={`Hand strength ${pct} of 100`}>
                    <i />
                  </span>
                  <small>beats {pct}% of hands</small>
                </div>
              )}
            </div>
          );
        })()}

        {/* the pot's chips fly to the winner(s) */}
        {resultHere &&
          winners.map((w) => {
            const to = w === t.mySeat && showMeBottom ? ME_SPOT : SPOTS[spotOf(w)];
            return [0, 1, 2, 3, 4, 5, 6].map((i) => (
              <img
                key={`fly-${t.result!.handNo}-${w}-${i}`}
                className="tb-fly"
                src={`/boards/${board}-stack.webp`}
                alt=""
                style={{ left: `${to.x}%`, top: `${to.y}%`, animationDelay: `${300 + i * 70}ms`, ...from(to, POT) } as React.CSSProperties}
              />
            ));
          })}

        {/* finished hand */}
        {t.result && rt && (rt.phase === PHASE.HAND_COMPLETE || rt.phase === PHASE.REVEALED || rt.phase === PHASE.IDLE) && (
          <div className={`tb-result ${iWon ? "is-mine" : ""}`} data-testid="result" key={`res-${String(t.result.handNo)}`}>
            {iWon && (
              <span className="tb-burst" aria-hidden>
                {Array.from({ length: 16 }, (_, i) => (
                  <i key={i} style={{ "--a": `${i * 22.5}deg`, animationDelay: `${(i % 4) * 40}ms` } as React.CSSProperties} />
                ))}
              </span>
            )}
            <b>
              {t.result.winners.map((w) => (w === t.mySeat ? "You" : `Seat ${w + 1}`)).join(" & ")} won <Sol /> {sol(t.result.winners.reduce((a, w) => a + (t.result!.payouts[w] ?? 0n), 0n))}
            </b>
            <span>
              {END_REASON[t.result.reason] ?? ""} · rake <Sol /> {sol(t.result.rake)}
              {t.result.verified === true && <em className="is-ok"> · verified ✓</em>}
              {t.result.verified === false && <em className="is-bad"> · verification FAILED</em>}
            </span>
            <Link href={`/verify/${t.config?.toBase58()}/${String(t.result.handNo)}`} target={locked ? "_blank" : undefined}>
              Verify hand {locked ? "↗" : "→"}
            </Link>
          </div>
        )}
      </section>

      {/* ---------- you ---------- */}
      {showMeBottom && me && (
        <section className="tb-me">
          <div className="tb-me-row">
            <div className="tb-side tb-left">
              {seatedLike && handActive && !respond && (
                <div className="tb-acts" data-testid="actions">
                  <button className="tb-act" disabled={!l?.see || busy} onClick={t.actions.see}>
                    See cards
                  </button>
                  <button className="tb-act" disabled={!myTurn || !l?.sideShow || busy} onClick={t.actions.sideShow}>
                    Side Show
                  </button>
                  <button className="tb-act is-pack" disabled={!myTurn || !l?.pack || busy} onClick={t.actions.pack}>
                    Pack
                  </button>
                </div>
              )}
              {seatedLike && respond && (
                <button className="tb-act is-pack" disabled={busy} onClick={() => t.actions.respond(false)}>
                  Refuse
                </button>
              )}
              <span className="tb-chip" data-testid="my-stack">
                <Sol /> STACK {sol(me.stack)}
              </span>
            </div>

            <div className="tb-me-av">
              <div className={`tb-ring ${myTurn ? "is-turn" : ""} ${me.status === "packed" ? "is-packed" : ""} ${iWon ? "is-winner" : ""}`} style={{ "--t": progress } as React.CSSProperties}>
                {iWon && <span className="tb-win-tag">Winner</span>}
                <Avatar name="You" index={avatars.get(me.wallet ?? "") ?? hashIndex(me.wallet ?? "")} size={84} />
                <StatusBadge status={me.status} />
              </div>
            </div>

            <div className="tb-side tb-right">
              <span className="tb-chip">
                <Sol />{" "}
                {t.gameLive && rt && rt.game.phase !== 2 ? (
                  <>
                    {me.status === "seen" ? "CHAAL" : "BLIND"} {sol(t.legal?.chaal ?? (me.status === "seen" ? 2n * rt.game.stake : rt.game.stake))}
                  </>
                ) : (
                  <>BOOT {sol(rt?.boot ?? 0n)}</>
                )}
              </span>
              {seatedLike && handActive && !respond && (
                <div className="tb-acts">
                  <button className="tb-act is-chaal" disabled={!myTurn || !l?.chaal || busy} onClick={() => t.actions.chaal(false)} data-testid="chaal">
                    {me.status === "seen" ? "Chaal" : "Blind"} <small><Sol /> {sol(one)}</small>
                  </button>
                  <button className="tb-act" disabled={!myTurn || !l?.chaalDouble || busy} onClick={() => t.actions.chaal(true)}>
                    ×2 <small><Sol /> {sol(two)}</small>
                  </button>
                  <button className="tb-act" disabled={!myTurn || !l?.show || busy} onClick={t.actions.show} title="Show needs exactly two players">
                    Show
                  </button>
                </div>
              )}
              {seatedLike && respond && (
                <button className="tb-act is-chaal" disabled={busy} onClick={() => t.actions.respond(true)}>
                  Accept Side Show
                </button>
              )}
            </div>
          </div>
          <p className="tb-me-name">
            You · seat {me.seat + 1}
            {me.category && (me.status === "seen" || t.result) && <span> · {me.category}</span>}
            {myTurn && <em> · your turn {Math.ceil(t.turnLeft)}s</em>}
          </p>
          {seatedLike && respond && <p className="tb-note">Seat {g!.ss_requester + 1} asks you for a Side Show. The lower hand packs.</p>}
          <div className="tb-me-foot">
            {t.mode === "leaving" ? (
              <span className="tb-pill">You&apos;ll leave after this hand, then cash out</span>
            ) : t.mode === "seated" ? (
              <button className="tb-leave" disabled={busy} onClick={t.leave} data-testid="leave">
                Leave table
              </button>
            ) : null}
            {/* CF-076: add chips without leaving; they go in before the next deal */}
            {t.mode === "seated" && t.topUpRange && (
              <span className="tb-topup-wrap">
                <button
                  className={`tb-leave tb-topup ${busted ? "is-urgent" : ""}`}
                  disabled={busy || t.topUpRange.max < t.topUpRange.min}
                  title={t.topUpRange.max < t.topUpRange.min ? "Your stack is at the table's maximum" : "Add chips from your wallet"}
                  onClick={() => { setTopAmt(defaultTopUp); setTopOpen((v) => !v); }}
                  data-testid="top-up"
                >
                  {busted ? "Out of chips · Add chips" : "+ Add chips"}
                </button>
                {topOpen && t.topUpRange.max >= t.topUpRange.min && (
                  <div className="tb-topup-pop" role="dialog" aria-label="Add chips" data-testid="top-up-panel">
                    <b>Add chips</b>
                    <span className="tb-topup-amt"><Sol /> {sol(topAmt)}</span>
                    <input
                      type="range"
                      min={Number(t.topUpRange.min)}
                      max={Number(t.topUpRange.max)}
                      step={Number(t.topUpRange.min)}
                      value={Number(topAmt)}
                      onChange={(e) => setTopAmt(BigInt(e.target.value))}
                    />
                    <small>
                      {inHandNow ? "Joins your stack right after this hand." : "Joins your stack before the next deal."} You get back what you don&apos;t lose when you leave.
                    </small>
                    <div className="tb-topup-row">
                      <button className="tb-topup-go" disabled={busy} onClick={() => { setTopOpen(false); void t.topUp(topAmt); }} data-testid="top-up-confirm">
                        Add <Sol /> {sol(topAmt)}
                      </button>
                      <button className="tb-leave" onClick={() => setTopOpen(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </span>
            )}
            {t.topUpPending > 0n && (
              <span className="tb-pill is-ok" data-testid="top-up-pending">
                +<Sol /> {sol(t.topUpPending)} {inHandNow ? "after this hand" : "joining your stack"}
              </span>
            )}
            <p className="tb-status" aria-live="polite" data-testid="status-line">
              {t.busy ? `${t.busy}…` : t.events.at(-1) ?? ""}
            </p>
          </div>
        </section>
      )}

      {/* panels for everything else (buy in, joining, cash out, refunds, resume) */}
      {/* spectator: take-a-seat popup, or the watch bar */}
      {spectatorJoin && joinOpen && (
        <div className="tb-modal" role="dialog" aria-modal aria-label="Take a seat">
          <button type="button" className="tb-modal-shade" aria-label="Close" onClick={() => setJoinOpen(false)} />
          <div className="tb-modal-box">
            <button type="button" className="tb-modal-x" aria-label="Close" onClick={() => setJoinOpen(false)}>
              ✕
            </button>
            <span className="tb-modal-eyebrow">{name}</span>
            <Panel t={t} pickSeat={p.pickSeat} setPickSeat={p.setPickSeat} openSeats={p.openSeats} canJoin={p.canJoin} tee={tee} wallet={p.wallet} balance={p.balance} />
            <button type="button" className="tb-watch" onClick={() => setJoinOpen(false)}>
              <span>👁</span> Watch as spectator
            </button>
          </div>
        </div>
      )}
      {spectatorJoin && !joinOpen && (
        <div className="tb-spectate">
          <span className="tb-eye">👁 Spectating</span>
          <span className="tb-hint">Tap a + seat to join · you play from the next hand</span>
          <p className="tb-status" aria-live="polite" data-testid="status-line">
            {t.busy ? `${t.busy}…` : t.events.at(-1) ?? ""}
          </p>
        </div>
      )}

      {!seatedLike && !spectatorJoin && (
        <aside className="tb-panel">
          <Panel t={t} pickSeat={p.pickSeat} setPickSeat={p.setPickSeat} openSeats={p.openSeats} canJoin={p.canJoin} tee={tee} wallet={p.wallet} balance={p.balance} />
          {!showMeBottom && (
            <p className="tb-status" aria-live="polite" data-testid="status-line">
              {t.busy ? `${t.busy}…` : t.events.at(-1) ?? ""}
            </p>
          )}
        </aside>
      )}

      {t.exit ? (
        <ExitSummary e={t.exit} tableName={name} onClose={() => { t.clearExit(); t.clearPaid(); }} />
      ) : t.paid !== null ? (
        <button className="tb-toast" onClick={t.clearPaid} data-testid="paid">
          <Sol /> {sol(t.paid)} was sent to your wallet. <span>(dismiss)</span>
        </button>
      ) : null}
      {navBlocked && (
        <div className="tb-modal" role="dialog" aria-modal aria-label="You're at the table" data-testid="nav-lock">
          <button type="button" className="tb-modal-shade" aria-label="Stay" onClick={() => setNavBlocked(false)} />
          <div className="tb-modal-box tb-lock">
            <span className="tb-modal-eyebrow">{name}</span>
            <h3>You&apos;re at the table</h3>
            <p>
              Leave the table to go to other pages. {t.mode === "leaving" ? "You're already leaving: it happens when this hand ends, then you're paid out." : "If a hand is on, you finish it (or pack), then your chips are paid back to your wallet."}
            </p>
            <div className="tb-lock-row">
              {t.mode === "seated" && (
                <button className="tb-topup-go" disabled={busy} onClick={() => { setNavBlocked(false); void t.leave(); }} data-testid="nav-lock-leave">
                  Leave table
                </button>
              )}
              <button className="tb-leave" onClick={() => setNavBlocked(false)}>Stay at the table</button>
            </div>
          </div>
        </div>
      )}
      {t.error && (
        <button className="tb-toast is-bad" onClick={t.clearError} role="alert">
          {t.error} <span>(dismiss)</span>
        </button>
      )}

      <footer className="tb-foot">
        {name} <i>|</i> {short(tableId)} <i>|</i> Seats {n} <i>|</i> Rules v1
      </footer>
      <style>{CSS}</style>
    </div>
  );
}

function Seat({ s, spot, avatar, turn, progress, back, selectable, selected, onPick, cardsOut, handKey, dealDelay }: {
  s: SeatView; spot: { x: number; y: number }; avatar?: number; turn: boolean; progress: number; back: string; selectable: boolean; selected: boolean; onPick: () => void;
  cardsOut: boolean; handKey: string; dealDelay: (k: number) => number;
}) {
  const style = { left: `${spot.x}%`, top: `${spot.y}%` };
  if (!s.wallet) {
    return (
      <div className="tb-seat" style={style}>
        <button className={`tb-socket ${selected ? "is-picked" : ""}`} disabled={!selectable} onClick={onPick} title={selectable ? `Take seat ${s.seat + 1}` : "Open seat"} aria-label={`Open seat ${s.seat + 1}`}>
          +
        </button>
        <span className="tb-tag">Seat {s.seat + 1}</span>
      </div>
    );
  }
  const right = spot.x > 50;
  return (
    <div className={`tb-seat ${right ? "is-right" : ""}`} style={style} data-testid={`seat-${s.seat}`}>
      <span className="tb-name">
        {s.you ? "You" : short(s.wallet)}
        {s.leaving ? " · leaving" : ""}
      </span>
      <div className="tb-seat-row">
        <div className={`tb-ring ${turn ? "is-turn" : ""} ${s.status === "packed" ? "is-packed" : ""} ${s.winner ? "is-winner" : ""}`} style={{ "--t": progress } as React.CSSProperties}>
          {s.winner && <span className="tb-win-tag">Winner</span>}
          <Avatar name={s.you ? "You" : s.wallet} index={avatar ?? hashIndex(s.wallet)} size={58} />
          <span className="tb-no">{s.seat + 1}</span>
          {!s.winner && <StatusBadge status={s.status} />}
        </div>
        {s.dealt && (cardsOut || !!s.cards) && (
          <div className={`tb-hand ${s.status === "packed" ? "is-packed" : ""}`}>
            {[0, 1, 2].map((k) => (
              <img key={`${handKey}-${k}`} className="tb-deal" src={s.cards?.[k] !== undefined ? cardArt(s.cards[k]) : back} alt="" style={{ "--k": k - 1, animationDelay: `${dealDelay(k)}ms`, ...from(spot) } as React.CSSProperties} />
            ))}
          </div>
        )}
      </div>
      <span className="tb-stack">
        <Sol /> {sol(s.stack)}
      </span>
      {s.winner && s.payout > 0n && <span className="tb-won" key={`won-${handKey}`}>+<Sol /> {sol(s.payout)}</span>}
      {s.category && <span className="tb-cat">{s.category}</span>}
    </div>
  );
}

const OUT = "cubic-bezier(.22,1,.36,1)";
const CSS = `
.tb-emerald{--glow:47,224,122 !important;--accent:#5cf09a !important}
.tb-emerald .tb-no{background:#15803d}
.tb-emerald .tb-act:not(.is-pack):not(.is-chaal){background:linear-gradient(180deg,rgba(14,70,40,.88),rgba(6,32,18,.92))}
.tb-emerald .tb-modal-box .glass,.tb-emerald .tb-panel .glass{background:linear-gradient(170deg,rgba(10,60,34,.94),rgba(4,24,14,.94)) !important}
.tb-ruby{--glow:255,70,70 !important;--accent:#ff7b7b !important}
.tb-ruby .tb-no{background:#b91c1c}
.tb-ruby .tb-act:not(.is-pack):not(.is-chaal){background:linear-gradient(180deg,rgba(90,14,20,.9),rgba(40,4,8,.94))}
.tb-ruby .tb-modal-box .glass,.tb-ruby .tb-panel .glass{background:linear-gradient(170deg,rgba(80,10,18,.94),rgba(30,3,8,.95)) !important}
.tb-ruby .tb-act.is-pack{background:linear-gradient(180deg,#5a5f6e,#363a46);border-color:rgba(255,255,255,.25)}
.tb{--glow:168,85,247;--accent:#c98bff;position:fixed;inset:0;z-index:0;overflow:hidden;font-family:var(--font-outfit),system-ui,sans-serif;color:#fff;background:#0b0418}
.tb-hall{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.tb-shade{position:absolute;inset:0;background:radial-gradient(60% 55% at 50% 52%,transparent 30%,rgba(6,2,14,.55) 100%),linear-gradient(0deg,rgba(6,2,14,.85),rgba(6,2,14,0) 32%),linear-gradient(180deg,rgba(6,2,14,.6),rgba(6,2,14,0) 20%)}

/* top strip */
.tb-strip{position:absolute;top:96px;left:50%;transform:translateX(-50%);z-index:5;display:flex;flex-wrap:wrap;justify-content:center;gap:8px}
.tb-pill{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 13px;border-radius:99px;border:1px solid rgba(255,255,255,.12);background:rgba(10,4,24,.55);backdrop-filter:blur(8px);color:rgba(233,221,255,.85) !important;font:500 12.5px var(--font-outfit),sans-serif;white-space:nowrap;cursor:default}
a.tb-pill,button.tb-pill{cursor:pointer}
.tb-pill.tb-name{color:#fff !important;font-weight:600;border-color:rgba(var(--glow),.5)}
.tb .is-ok{color:#5cf09a !important}
.tb .is-bad{color:#ff8a98 !important}

/* scene: dealer behind the table; everything else is placed in % of it */
.tb-scene{--sw:min(58vw,calc((100dvh - 345px) / .735));position:absolute;left:50%;top:132px;width:var(--sw);height:calc(var(--sw) * .735);transform:translateX(-50%);z-index:2}
.tb-spot{position:absolute;left:50%;top:0;width:60%;height:70%;transform:translateX(-50%);border-radius:50%;background:radial-gradient(closest-side,rgba(var(--glow),.4),rgba(var(--glow),.1) 60%,transparent)}
.tb-dealer{position:absolute;left:50%;bottom:30%;height:66%;width:auto;transform:translateX(-50%);filter:drop-shadow(0 20px 40px rgba(0,0,0,.5))}
.tb-table{position:absolute;height:auto}
/* Amethyst: the whole table image faded into its hall; Emerald / Ruby: cut-outs placed solid */
.tb-table.is-cut{left:7%;width:86%;bottom:calc(var(--sw) * .066);filter:drop-shadow(0 26px 30px rgba(0,0,0,.55))}
.tb-table.is-blended{left:0;bottom:0;width:100%;-webkit-mask-image:linear-gradient(180deg,transparent 15%,#000 21%),radial-gradient(ellipse 50% 52% at 50% 50%,#000 74%,transparent 100%);-webkit-mask-composite:source-in;mask-image:linear-gradient(180deg,transparent 15%,#000 21%),radial-gradient(ellipse 50% 52% at 50% 50%,#000 74%,transparent 100%);mask-composite:intersect}

/* pot */
.tb-pot{position:absolute;left:50%;top:53%;transform:translate(-50%,-50%);display:grid;justify-items:center;gap:6px;z-index:3}
.tb-pot-amt{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px 0 6px;border-radius:99px;background:rgba(10,4,24,.7);border:1px solid rgba(255,214,102,.45);font-size:17px;font-weight:600;box-shadow:0 8px 20px rgba(0,0,0,.4)}
.tb-pot-amt img{width:44px;height:auto;margin:-8px 0}
.tb-pot small{font-size:10.5px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:rgba(233,221,255,.7)}
.tb-phase{padding:9px 18px;border-radius:99px;background:rgba(10,4,24,.65);border:1px solid rgba(var(--glow),.45);font-size:14px;font-weight:500;white-space:nowrap}

/* bets */
.tb-bet{position:absolute;transform:translate(-50%,-50%);display:flex;align-items:center;gap:4px;z-index:3}
.tb-bet img{width:calc(var(--sw) * .04);height:auto;filter:drop-shadow(0 4px 6px rgba(0,0,0,.5))}
.tb-bet span{padding:2px 9px;border-radius:99px;background:rgba(10,4,24,.75);font-size:11.5px;font-weight:600}

/* seats */
.tb-seat{position:absolute;transform:translate(-50%,-50%);display:grid;justify-items:center;gap:4px;z-index:4}
.tb-name{font-size:13px;font-weight:600;color:#f3e8ff;text-shadow:0 2px 8px rgba(0,0,0,.8);white-space:nowrap}
.tb-seat-row{display:flex;align-items:center;gap:6px}
.tb-seat.is-right .tb-seat-row{flex-direction:row-reverse}
.tb-ring{position:relative;flex:none;border-radius:50%;padding:3px;background:conic-gradient(var(--accent) calc(var(--t,1) * 360deg),rgba(255,255,255,.12) 0);box-shadow:0 8px 20px rgba(0,0,0,.5)}
.tb-ring:not(.is-turn){background:linear-gradient(160deg,rgba(var(--glow),.95),rgba(var(--glow),.35))}
.tb-ring.is-turn{box-shadow:0 0 0 4px rgba(var(--glow),.25),0 0 28px rgba(var(--glow),.8)}
.tb-ring.is-packed{filter:grayscale(.8) brightness(.6)}
.tb-ring.is-winner{background:conic-gradient(from 0deg,#fff2b0,#ffd23f,#c98a12,#ffe98a,#fff2b0) !important;animation:tb-win-pulse 1.1s ease-in-out 4}
@keyframes tb-win-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,214,102,.75),0 0 30px rgba(255,214,102,.7)}50%{box-shadow:0 0 0 12px rgba(255,214,102,0),0 0 56px rgba(255,214,102,1)}}
.tb-win-tag{position:absolute;left:50%;top:-14px;z-index:3;transform:translateX(-50%);padding:3px 10px;border-radius:99px;background:linear-gradient(180deg,#fff27a,#ffc21a);color:#3a2300;font-size:10.5px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;box-shadow:0 4px 14px rgba(255,190,40,.6);animation:tb-tag-pop .6s cubic-bezier(.2,1.6,.4,1) both;white-space:nowrap}
@keyframes tb-tag-pop{from{opacity:0;transform:translateX(-50%) translateY(10px) scale(.4)}}
.tb-seat .tb-win-tag{top:auto;bottom:-12px;font-size:9.5px;padding:2px 8px}
/* dealing: each card flies from the deck in front of the dealer */
.tb-deal{animation:tb-deal .55s cubic-bezier(.2,.75,.25,1) backwards}
@keyframes tb-deal{0%{transform:translate(var(--from-x,0),var(--from-y,-160px)) rotate(-200deg) scale(.45);opacity:0}12%{opacity:1}}
/* pot chips flying to the winner */
.tb-fly{position:absolute;z-index:7;width:calc(var(--sw) * .04);height:auto;transform:translate(-50%,-50%);opacity:0;pointer-events:none;filter:drop-shadow(0 6px 8px rgba(0,0,0,.5));animation:tb-fly 1.1s cubic-bezier(.45,0,.2,1) forwards}
@keyframes tb-fly{0%{transform:translate(calc(-50% + var(--from-x)),calc(-50% + var(--from-y))) scale(.9);opacity:0}10%{opacity:1}85%{opacity:1}100%{transform:translate(-50%,-50%) scale(.6);opacity:0}}
.tb-no{position:absolute;right:-2px;top:-2px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:#7c3aed;font-size:10.5px;font-weight:700;box-shadow:0 0 0 2px #1a0b38}
.tb-hand{display:flex}
.tb-hand img{width:calc(var(--sw) * .036);height:auto;margin:0 calc(var(--sw) * -.011);border-radius:6%;transform:rotate(calc(var(--k) * 12deg));box-shadow:0 4px 8px rgba(0,0,0,.5)}
.tb-hand.is-packed{opacity:.4}
.tb-stack{display:inline-flex;align-items:center;gap:5px;padding:3px 11px;border-radius:99px;background:rgba(10,4,24,.72);border:1px solid rgba(255,255,255,.1);font-size:12px;font-weight:600}
.tb-won{font-size:13px;font-weight:800;color:#ffd76a;text-shadow:0 0 12px rgba(255,214,102,.8);animation:tb-won-up 1s cubic-bezier(.2,.8,.2,1) .9s both}
@keyframes tb-won-up{from{opacity:0;transform:translateY(14px) scale(.7)}60%{transform:translateY(-4px) scale(1.15)}}
/* hand strength under your cards */
.tb-meter{position:absolute;left:50%;top:calc(100% + 6px);transform:translateX(-50%);display:grid;grid-template-columns:auto 84px auto;align-items:center;gap:7px;padding:4px 10px;border-radius:99px;background:rgba(10,4,24,.82);border:1px solid rgba(255,214,102,.35);box-shadow:0 8px 20px rgba(0,0,0,.45);white-space:nowrap;z-index:6;animation:tb-fade .4s both}
.tb-meter b{font-size:12px;font-weight:700;color:#ffe9a3}
.tb-meter small{font-size:10.5px;color:rgba(233,221,255,.7)}
.tb-meter-bar{position:relative;height:8px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden}
.tb-meter-bar i{position:absolute;left:0;top:0;bottom:0;width:calc(var(--p) * 100%);min-width:6px;border-radius:99px;background:linear-gradient(90deg,#ff5a6e,#ffb02e 45%,#ffe800 70%,#5cf09a) 0 0/84px 100%;box-shadow:0 0 10px rgba(255,214,102,.45);animation:tb-meter-in .9s cubic-bezier(.2,.8,.2,1) .2s both}
@keyframes tb-meter-in{from{width:0}}
.tb-cat{font-size:11.5px;font-weight:600;color:#ffe9a3}
.tb-socket{display:grid;place-items:center;width:50px;height:50px;border-radius:50%;border:1.5px dashed rgba(255,255,255,.35);background:rgba(10,4,24,.45);color:rgba(255,255,255,.6);font-size:22px;cursor:pointer;transition:all .25s ${OUT}}
.tb-socket:not(:disabled):hover{border-color:#ffd76a;color:#ffd76a;transform:scale(1.08)}
.tb-socket:disabled{cursor:default}
.tb-socket.is-picked{border:2px solid #ffd76a;color:#ffd76a;box-shadow:0 0 22px rgba(255,214,102,.6)}
.tb-tag{padding:2px 9px;border-radius:99px;background:rgba(10,4,24,.65);font-size:11px;color:rgba(233,221,255,.7)}

/* your cards on the front rim */
.tb-mycards{position:absolute;left:50%;top:63%;transform:translateX(-50%);display:flex;z-index:5}
.tb-card{--w:calc(var(--sw) * .095);display:block;width:var(--w);margin:0 calc(var(--w) * -.22);transform:rotate(calc(var(--k) * 9deg)) translateY(calc(var(--k) * var(--k) * 6px));transform-origin:50% 100%;transition:transform .4s ${OUT}}
.tb-card img{display:block;width:100%;height:auto;border-radius:7%;box-shadow:0 12px 24px rgba(0,0,0,.55)}
.tb-mycards:hover .tb-card{transform:rotate(calc(var(--k) * 14deg)) translate(calc(var(--k) * 14px),calc(var(--k) * var(--k) * 8px - 10px))}
.tb-card.is-packed{opacity:.45}

/* result */
.tb-result{position:absolute;left:50%;top:32%;transform:translate(-50%,-50%);display:grid;justify-items:center;gap:6px;padding:14px 22px;border-radius:22px;background:rgba(10,4,24,.82);border:1px solid rgba(255,214,102,.5);box-shadow:0 18px 40px rgba(0,0,0,.5);z-index:6;text-align:center;white-space:nowrap}
.tb-result{animation:tb-res-in .5s cubic-bezier(.2,1.4,.4,1) both}
@keyframes tb-res-in{from{opacity:0;transform:translate(-50%,-50%) scale(.6)}}
.tb-result.is-mine{border-color:#ffd76a;box-shadow:0 0 0 2px rgba(255,214,102,.3),0 0 60px rgba(255,190,40,.55),0 18px 40px rgba(0,0,0,.5)}
.tb-result.is-mine b{font-size:24px;background:linear-gradient(90deg,#fff6c4,#ffd23f,#fff6c4);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:tb-shine 1.6s linear 3}
@keyframes tb-shine{to{background-position:-200% 0}}
.tb-burst{position:absolute;left:50%;top:50%;width:0;height:0;pointer-events:none}
.tb-burst i{position:absolute;left:-4px;top:-4px;width:8px;height:8px;border-radius:2px;background:linear-gradient(135deg,#fff6c4,#ffc21a);transform:rotate(var(--a)) translateY(0);opacity:0;animation:tb-burst 1.1s cubic-bezier(.15,.7,.3,1) .15s forwards}
.tb-burst i:nth-child(3n){background:linear-gradient(135deg,#e9d5ff,#b86cff)}
@keyframes tb-burst{0%{opacity:1;transform:rotate(var(--a)) translateY(0) scale(1)}100%{opacity:0;transform:rotate(var(--a)) translateY(-150px) scale(.4) rotate(220deg)}}
.tb-result b{font-size:20px;font-weight:600;color:#ffd76a}
.tb-result span{font-size:12.5px;color:rgba(233,221,255,.75)}
.tb-result em{font-style:normal}
.tb-result a{font-size:13px;font-weight:600;color:#ffd76a !important}

/* you */
.tb-me{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);z-index:6;display:grid;justify-items:center;width:min(1100px,96vw)}
.tb-me-row{display:grid;grid-template-columns:1fr auto 1fr;align-items:end;gap:18px;width:100%}
.tb-side{display:grid;gap:10px}
.tb-left{justify-items:end}
.tb-right{justify-items:start}
.tb-left .tb-chip{order:-1}
.tb-right .tb-chip{order:-1}
.tb-acts{display:flex;gap:8px}
.tb-act{display:inline-flex;align-items:center;gap:6px;height:46px;padding:0 18px;border-radius:14px;border:1px solid rgba(var(--glow),.45);background:linear-gradient(180deg,rgba(60,24,110,.85),rgba(30,10,60,.9));color:#f3e8ff;font:700 14px var(--font-outfit),sans-serif;letter-spacing:.6px;text-transform:uppercase;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 6px 16px rgba(0,0,0,.4);transition:transform .2s,filter .2s,opacity .2s}
.tb-act small{font-size:11.5px;font-weight:600;opacity:.85;text-transform:none}
.tb-act:hover:not(:disabled){transform:translateY(-2px);filter:brightness(1.15)}
.tb-act:disabled{opacity:.4;cursor:default}
.tb-act.is-pack{border-color:rgba(255,90,120,.6);background:linear-gradient(180deg,#ff4d74,#d81f4f);color:#fff}
.tb-act.is-chaal{border-color:rgba(160,255,90,.6);background:linear-gradient(180deg,#9dff4a,#4fc71b);color:#0e2a03}
.tb-chip{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 14px;border-radius:12px;background:rgba(10,4,24,.72);border:1px solid rgba(255,214,102,.3);font-size:13px;font-weight:600;letter-spacing:.4px}
.tb-me-av{display:grid;justify-items:center}
.tb-me-av .tb-ring{padding:4px}
.tb-me-name{margin:10px 0 0;font-size:17px;font-weight:600}
.tb-me-name span{color:#ffe9a3}
.tb-me-name em{font-style:normal;color:#9dff4a}
.tb-note{margin:4px 0 0;font-size:13px;color:rgba(233,221,255,.75)}
.tb-me-foot{display:flex;align-items:center;gap:14px;margin-top:6px}
.tb-leave{height:30px;padding:0 14px;border-radius:99px;border:1px solid rgba(255,255,255,.15);background:rgba(10,4,24,.55);color:rgba(233,221,255,.8);font:500 12px var(--font-outfit),sans-serif;cursor:pointer}
.tb-leave:hover{color:#fff;border-color:rgba(255,255,255,.35)}
.tb-topup-wrap{position:relative;display:inline-flex}
.tb-topup{color:#ffe9a3;border-color:rgba(255,214,102,.45)}
.tb-topup.is-urgent{background:linear-gradient(180deg,#fff27a,#ffc21a);color:#3a2300;border-color:#ffd23f;font-weight:700;animation:tb-breathe 1.6s ease-in-out infinite}
.tb-topup-pop{position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);z-index:20;display:grid;gap:9px;width:270px;padding:14px 16px;border-radius:18px;background:linear-gradient(170deg,rgba(42,11,71,.97),rgba(18,1,40,.97));border:1px solid rgba(255,214,102,.45);box-shadow:0 20px 44px rgba(0,0,0,.6);text-align:left;animation:tb-pop .3s cubic-bezier(.2,.8,.2,1) both}
.tb-topup-pop b{font-size:14px;color:#ffd76a}
.tb-topup-amt{font-size:22px;font-weight:700;color:#fff}
.tb-topup-pop input{width:100%;accent-color:#ffd23f}
.tb-topup-pop small{font-size:11.5px;line-height:1.4;color:rgba(233,221,255,.7)}
.tb-topup-row{display:flex;gap:8px;align-items:center}
.tb-topup-go{flex:1;height:36px;border:0;border-radius:99px;background:#ffe800;color:#140f11;font:700 13px var(--font-outfit),sans-serif;cursor:pointer}
.tb-topup-go:disabled{opacity:.5}
.tb-lock{display:grid;gap:12px;max-width:380px;text-align:left}
.tb-lock h3{margin:0;font-size:22px;font-weight:600}
.tb-lock p{margin:0;font-size:13.5px;line-height:1.5;color:rgba(233,221,255,.8)}
.tb-lock-row{display:flex;gap:10px;align-items:center}
.tb-lock-row .tb-topup-go{flex:none;padding:0 22px}
.tb-status{margin:0;min-height:18px;font-size:13px;color:#c8f7a0}

/* spectator / other panels: a card on the left, like the boards page */
.tb-panel{position:absolute;left:max(24px,calc((100vw - 80rem) / 2 + 24px));top:50%;transform:translateY(-42%);z-index:7;width:min(330px,24vw)}
/* a side card is showing: move the table right to make room */
@media (min-width:900px){.tb.has-panel .tb-scene{--sw:min(52vw,calc((100dvh - 345px) / .735));left:calc(50% + min(170px,12vw))}}
/* take-a-seat popup */
.tb-modal{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:20px}
.tb-modal-shade{position:absolute;inset:0;border:0;background:rgba(6,1,16,.6);backdrop-filter:blur(5px);cursor:default;animation:tb-fade .3s both}
.tb-modal-box{position:relative;width:min(400px,100%);display:grid;gap:12px;animation:tb-pop .45s ${OUT} both}
.tb-modal-eyebrow{justify-self:center;font-size:11.5px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:var(--accent)}
.tb-modal-x{position:absolute;right:-6px;top:-6px;z-index:2;width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.2);background:rgba(20,6,40,.9);color:#fff;cursor:pointer}
.tb-watch{display:flex;align-items:center;justify-content:center;gap:8px;height:48px;border-radius:99px;border:1px solid rgba(var(--glow),.55);background:rgba(20,6,40,.85);color:#f3e8ff;font:600 14.5px var(--font-outfit),sans-serif;cursor:pointer;transition:background .2s,transform .2s}
.tb-watch:hover{background:rgba(var(--glow),.25);transform:translateY(-1px)}
@keyframes tb-fade{from{opacity:0}}
@keyframes tb-pop{from{opacity:0;transform:translateY(18px) scale(.96)}}
/* watching: a small bar at the bottom */
.tb-spectate{position:absolute;left:50%;bottom:40px;transform:translateX(-50%);z-index:7;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px;padding:8px 8px 8px 16px;border-radius:99px;background:rgba(10,4,24,.75);border:1px solid rgba(var(--glow),.45);backdrop-filter:blur(10px)}
.tb-eye{font-size:13px;font-weight:600;color:var(--accent)}
.tb-hint{font-size:13px;color:rgba(233,221,255,.75)}
.tb-join{height:40px;padding:0 20px;border:0;border-radius:99px;background:linear-gradient(180deg,#fff27a,#ffe100 45%,#f0b400);color:#1d1200;font:600 14px var(--font-outfit),sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(245,190,0,.3)}
.tb-spectate .tb-status{position:absolute;top:calc(100% + 6px);left:0;right:0;text-align:center}
.tb-socket:not(:disabled){border-color:rgba(255,214,102,.6);color:#ffd76a;animation:tb-breathe 2.2s ease-in-out infinite}
@keyframes tb-breathe{50%{box-shadow:0 0 18px rgba(255,214,102,.45)}}
.tb-modal .glass,.tb-panel .glass{margin-top:0;border-radius:26px;background:linear-gradient(170deg,rgba(42,11,71,.92),rgba(18,4,38,.92));border:1px solid rgba(var(--glow),.45);box-shadow:0 30px 60px rgba(0,0,0,.5);backdrop-filter:blur(10px);font-family:var(--font-outfit),sans-serif}
.tb-modal .glass > p:first-child,.tb-panel .glass > p:first-child{font-family:var(--font-outfit),sans-serif !important;font-weight:600;font-size:22px}
.tb-modal .btn-lime,.tb-modal .btn-gold,.tb-panel .btn-lime,.tb-panel .btn-gold{border:0;border-radius:99px;background:linear-gradient(180deg,#fff27a,#ffe100 45%,#f0b400);color:#1d1200;font-family:var(--font-outfit),sans-serif;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,.7),0 8px 22px rgba(245,190,0,.3)}
.tb-modal input[type=range],.tb-panel input[type=range]{accent-color:#ffd76a}
.tb-modal [data-testid=result],.tb-panel [data-testid=result]{display:none}
.tb-modal .glass{max-width:none}
.tb-modal .bg-lime-500,.tb-panel .bg-lime-500{background:linear-gradient(180deg,#fff27a,#f0b400) !important;color:#1d1200 !important}
.tb-panel > p,.tb-panel > .mt-4{color:rgba(233,221,255,.8)}

/* toasts + footer */
.tb-toast{position:absolute;left:50%;top:136px;transform:translateX(-50%);z-index:9;padding:9px 16px;border-radius:14px;border:1px solid rgba(92,240,154,.4);background:rgba(10,40,20,.9);color:#c8f7d8;font:500 13px var(--font-outfit),sans-serif;cursor:pointer}
.tb-toast.is-bad{border-color:rgba(255,90,110,.5);background:rgba(60,8,20,.92);color:#ffc2cb;top:176px}
.tb-toast span{opacity:.65}
/* short laptop screens (≤ 760 px tall): the table is small, so the pot and result shrink with it */
@media (min-width:900px) and (max-height:760px){.tb-pot-amt{height:32px;font-size:14px;padding:0 12px 0 4px}.tb-pot-amt img{width:34px}.tb-pot small{font-size:9.5px;letter-spacing:1.2px}.tb-result{top:24%;padding:10px 16px;gap:4px}.tb-result b{font-size:16px}.tb-result.is-mine b{font-size:18px}.tb-result span{font-size:11.5px}}
.tb-foot{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);z-index:5;font-size:11.5px;color:rgba(233,221,255,.5);white-space:nowrap}
.tb-foot i{font-style:normal;margin:0 6px;opacity:.5}

/* phones */
@media (max-width:899px){
  .tb-scene{--sw:96vw;top:150px}
  .tb-panel{left:50%;top:auto;bottom:40px;transform:translateX(-50%);width:min(380px,92vw)}
  .tb-me-row{grid-template-columns:1fr;justify-items:center}
  .tb-side{justify-items:center}
  .tb-acts{flex-wrap:wrap;justify-content:center}
  .tb-act{height:40px;padding:0 12px;font-size:12.5px}
  .tb-strip{top:84px;width:96vw}
  .tb-strip .tb-pill:nth-child(n+4):not([data-testid]){display:none}
}
`;
