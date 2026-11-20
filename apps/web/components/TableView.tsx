"use client";

import Link from "next/link";
import { PHASE } from "@card-flex/client-sdk";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { Chips } from "./Chips";
import { Crest } from "./Crest";
import { PlayingCard } from "./PlayingCard";
import { END_REASON, hashIndex, short, sol } from "@/lib/format";
import { metaFor } from "@/lib/lobby";
import { useTee } from "@/lib/tee";
import { readSettings } from "@/lib/settings";
import { play } from "@/lib/sound";
import { useTable, type SeatView } from "@/lib/useTable";
import { useWallet } from "@/lib/wallet";

const TURN_SECS = 25;
// Seat spots around the oval (% of the stage). Spot 0 = bottom centre: you,
// or (spectating) the first seat. m = mobile (taller table), d = desktop.
type Spot = { x: number; y: number; mx: number; my: number; side: "l" | "r" | "t" | "b" };
const SPOTS: Spot[] = [
  { x: 50, y: 98, mx: 50, my: 94, side: "b" },
  { x: 5, y: 64, mx: 11, my: 66, side: "l" },
  { x: 14, y: 10, mx: 13, my: 22, side: "l" },
  { x: 50, y: -4, mx: 50, my: 4, side: "t" },
  { x: 86, y: 10, mx: 87, my: 22, side: "r" },
  { x: 95, y: 64, mx: 89, my: 66, side: "r" },
];
const BET_SPOTS = [{ x: 50, y: 74 }, { x: 20, y: 62 }, { x: 25, y: 32 }, { x: 50, y: 22 }, { x: 75, y: 32 }, { x: 80, y: 62 }];
// Which spots a table of n seats uses (spot 0 first).
const LAYOUT: Record<number, number[]> = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 1, 3, 5], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };

export function TableView({ tableId }: { tableId: string }) {
  const t = useTable(tableId);
  const { wallet, balance } = useWallet();
  const tee = useTee();
  const meta = metaFor(tableId);
  const [pickSeat, setPickSeat] = useState<number | null>(null);
  const [potKey, setPotKey] = useState(0);
  const lastPot = useRef<bigint>(0n);

  const rt = t.rt;
  const n = t.snap?.cfg.max_seats ?? 6;
  // Rotate so my seat sits at the bottom.
  const anchor = t.mySeat ?? 0;
  const spotOf = (seat: number) => LAYOUT[n]?.[(seat - anchor + n) % n] ?? 0;
  const me = t.mySeat !== null ? t.seats[t.mySeat] : null;
  const showMeBottom = !!me && (t.mode === "seated" || t.mode === "leaving" || t.mode === "joining" || t.mode === "resume" || t.mode === "cashout");
  // After settlement the program empties the pot; show what was played for.
  const pot = t.gameLive && rt ? (rt.game.phase === 2 ? t.seats.reduce((a, x) => a + x.bet, 0n) : rt.game.pot) : 0n;
  useEffect(() => {
    if (pot !== lastPot.current) {
      if (pot > lastPot.current && lastPot.current > 0n) play("chip");
      lastPot.current = pot;
      setPotKey((k) => k + 1);
    }
  }, [pot]);
  // Sounds and the turn alert.
  const myTurnNow = t.seated && t.toAct !== null && t.toAct === t.mySeat;
  useEffect(() => {
    if (!myTurnNow) return;
    if (readSettings().turnAlert) {
      play("turn");
      if (document.hidden) document.title = "▶ Your turn · Card Flex";
    }
    return () => { document.title = "Card Flex — Play Blind. Play Bold."; };
  }, [myTurnNow, rt?.action_seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const dealtNow = t.gameLive && rt?.phase === PHASE.DEALT;
  useEffect(() => { if (dealtNow) play("deal"); }, [dealtNow, rt?.hand_no]); // eslint-disable-line react-hooks/exhaustive-deps
  const resultKey = t.result ? `${t.result.handNo}` : "";
  useEffect(() => {
    if (!t.result || t.mySeat === null || !t.seats[t.mySeat]?.dealt) return;
    play(t.result.winners.includes(t.mySeat) ? "win" : "lose");
  }, [resultKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (t.mode === "loading") return <Centered>Reading the table from Solana…</Centered>;
  if (t.mode === "missing") return <Centered>No table at this address. <Link className="underline" href="/#tables">Back to the lobby</Link></Centered>;

  const myTurn = t.seated && t.toAct !== null && t.toAct === t.mySeat;
  const progress = Math.min(1, t.turnLeft / TURN_SECS);
  const openSeats = t.seats.filter((s) => s.status === "empty").map((s) => s.seat);
  const canJoin = t.mode === "spectator" && !!t.snap?.live && t.snap.cfg.status === 1 && openSeats.length > 0;

  return (
    <main className="relative mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col items-center px-3 pb-2 sm:px-6">
      <StatusStrip t={t} name={meta.name} tee={tee} />

      {/* ---------- the table ---------- */}
      <section className="table-stage table-fit mt-[clamp(2.2rem,7vh,5.5rem)]" aria-label={`Table ${meta.name}`}>
        <div className="table-base" />
        <div className="table-rim" />
        <div className="table-felt">
          <div className="felt-line" />
          <Crest size={150} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.09]" />
        </div>

        {/* Pot and stake */}
        <div className="absolute left-1/2 top-[47%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5">
          {t.gameLive && rt ? (
            <>
              <span key={potKey} className="pill pot-pop text-base sm:text-lg" aria-live="polite" data-testid="pot">
                <span className="coin">◎</span>
                {sol(pot)}
              </span>
              <span className="text-[11px] font-bold uppercase tracking-widest text-violet-200/80">
                Pot · Stake {sol(rt.game.stake)} · Boot {sol(rt.boot)}
              </span>
            </>
          ) : (
            <span className="pill whitespace-nowrap text-xs text-violet-100 sm:text-sm">{phaseText(t)}</span>
          )}
        </div>

        {/* Bets on the felt */}
        {t.seats.map((s) =>
          s.bet > 0n && s.status !== "packed" && rt ? (
            <div key={`bet-${s.seat}`} className="absolute flex -translate-x-1/2 -translate-y-1/2 items-end gap-1" style={{ left: `${BET_SPOTS[spotOf(s.seat)].x}%`, top: `${BET_SPOTS[spotOf(s.seat)].y}%` }}>
              <Chips count={Math.ceil(Number(s.bet / (rt.boot || 1n)))} tone={s.you ? "gold" : s.seat % 2 ? "teal" : "violet"} />
              <span className="pill py-0.5 pl-2 text-[11px]">{sol(s.bet)}</span>
            </div>
          ) : null,
        )}

        {/* Seats (yours is drawn below the table) */}
        {t.seats.map((s) => (s.seat === t.mySeat && showMeBottom ? null : (
          <SeatSpot
            key={s.seat}
            s={s}
            spot={SPOTS[spotOf(s.seat)]}
            turn={t.toAct === s.seat}
            progress={progress}
            selectable={canJoin && s.status === "empty"}
            selected={pickSeat === s.seat}
            onPick={() => setPickSeat(s.seat)}
          />
        )))}

        {/* Your cards, resting on the rim */}
        {showMeBottom && me && me.dealt && (
          <div className="absolute left-1/2 top-[70%] flex -translate-x-1/2 items-end sm:top-[76%]" data-testid="my-cards">
            {[0, 1, 2].map((k) => {
              const face = (me.status === "seen" || t.result?.shown[me.seat] || (t.result && t.result.handNo === rt?.hand_no)) && t.myCards ? t.myCards[k] : undefined;
              return (
                <PlayingCard
                  key={`${rt?.hand_no}-${k}`}
                  id={face}
                  width="clamp(3.2rem, min(9vw, 9vh), 5.6rem)"
                  rotate={(k - 1) * 9}
                  className={`deal-in ${face !== undefined ? "flip-in" : ""} ${k ? "-ml-6 sm:-ml-8" : ""} ${me.status === "packed" ? "opacity-50" : ""}`}
                  style={{ animationDelay: `${k * 90}ms`, marginBottom: k === 1 ? "0.6rem" : 0 }}
                />
              );
            })}
          </div>
        )}
      </section>

      {/* ---------- you ---------- */}
      <section className="relative z-10 mt-[clamp(1.4rem,5vh,3rem)] flex w-full flex-col items-center">
        {showMeBottom && me && (
          <>
            <div className="flex items-center gap-3 sm:gap-5">
              <span className="pill text-xs sm:text-sm" data-testid="my-stack">
                <span className="coin">◎</span>
                STACK {sol(me.stack)}
              </span>
              <div className={`avatar-ring ${myTurn ? "turn" : ""} ${me.status === "packed" ? "packed" : ""}`} style={{ ["--t" as string]: progress }}>
                <Avatar name="You" index={0} size={64} />
                <StatusBadge status={me.status} />
              </div>
              <span className="pill text-xs sm:text-sm">
                <span className="coin">◎</span>
                {t.gameLive && rt && rt.game.phase !== 2
                  ? <>{me.status === "seen" ? "CHAAL" : "BLIND"} {sol(t.legal?.chaal ?? (me.status === "seen" ? 2n * rt.game.stake : rt.game.stake))}</>
                  : <>BOOT {sol(rt?.boot ?? 0n)}</>}
              </span>
            </div>
            <p className="mt-2 font-[family-name:var(--font-display)] text-lg tracking-wide">
              You · seat {me.seat + 1}
              {me.category && (me.status === "seen" || t.result) && <span className="text-violet-300"> · {me.category}</span>}
              {myTurn && <span className="ml-2 text-lime-300">· your turn {Math.ceil(t.turnLeft)}s</span>}
            </p>
          </>
        )}

        <Panel t={t} pickSeat={pickSeat} setPickSeat={setPickSeat} openSeats={openSeats} canJoin={canJoin} tee={tee} wallet={!!wallet} balance={balance} />

        {t.error && (
          <button className="mt-3 max-w-xl rounded-2xl bg-rose-600/25 px-4 py-2 text-sm text-rose-100 ring-1 ring-rose-400/40" onClick={t.clearError} role="alert">
            {t.error} <span className="opacity-70">(dismiss)</span>
          </button>
        )}
        <p className="mt-3 min-h-5 text-center text-sm text-lime-200" aria-live="polite" data-testid="status-line">
          {t.busy ? `${t.busy}…` : t.events.at(-1) ?? ""}
        </p>
      </section>

      <footer className="mt-auto hidden flex-wrap items-center justify-center gap-x-3 pb-1 text-xs text-violet-300/70 [@media(min-height:860px)]:flex">
        <span>{meta.name}</span>|<span>{short(tableId)}</span>|<span>Hand #{String(rt?.hand_no ?? 0n)}</span>|<span>Seats {n}</span>|<span>Rules v1</span>
      </footer>
    </main>
  );
}

type T = ReturnType<typeof useTable>;

function phaseText(t: T): string {
  const rt = t.rt;
  if (!rt) return "Table not opened yet";
  if (!t.snap?.live) return "Table closed";
  const players = t.seats.filter((s) => s.wallet && s.status !== "sitting").length;
  switch (rt.phase) {
    case PHASE.IDLE: {
      if (players < 2) return "Waiting for players · 2 needed";
      return `Next hand starting…`;
    }
    case PHASE.SALTS_PENDING: return "Shuffling · players add randomness";
    case PHASE.SALTS_DONE:
    case PHASE.VRF_PENDING:
    case PHASE.SEEDED: return "Drawing verifiable randomness…";
    case PHASE.DEALT: return "Dealing…";
    case PHASE.HAND_COMPLETE: return "Hand over · revealing";
    case PHASE.REVEALED: return "Hand over";
    default: return "…";
  }
}

function StatusStrip({ t, name, tee }: { t: T; name: string; tee: ReturnType<typeof useTee> }) {
  const r = tee.result;
  return (
    <div className="mt-3 flex w-full flex-wrap items-center justify-center gap-2 text-xs sm:text-sm">
      <Link href="/#tables" className="pill text-violet-200 hover:text-white">← Lobby</Link>
      <span className="pill"><span className="font-[family-name:var(--font-display)] text-base tracking-wide">{name}</span></span>
      <span className="pill text-violet-200">Hand #{String(t.rt?.hand_no ?? 0n)}</span>
      <span className="pill text-violet-200" title="Boot / buy-in range">
        Boot ◎{sol(t.rt?.boot || (t.snap ? t.snap.cfg.min_buy_in / 40n : 0n))} · buy-in ◎{sol(t.snap?.cfg.min_buy_in)}–{sol(t.snap?.cfg.max_buy_in)}
      </span>
      <button
        className={`pill ${r === null ? "text-violet-200" : r.ok ? "text-lime-300" : "text-rose-300"}`}
        onClick={() => r && !r.ok && tee.retry()}
        title={r === null ? "Checking the TEE attestation…" : r.ok ? `Intel TDX quote verified · TCB ${r.tcbStatus} · measurements pinned` : `Attestation failed: ${r.reasons.join("; ")} (click to retry)`}
        data-testid="tee-badge"
      >
        {r === null ? "◌ checking TEE" : r.ok ? "🛡 TEE verified" : "⚠ TEE unverified"}
      </button>
      {t.seated && <span className="pill text-lime-300">● seated</span>}
    </div>
  );
}

function Panel({ t, pickSeat, setPickSeat, openSeats, canJoin, tee, wallet, balance }: {
  t: T; pickSeat: number | null; setPickSeat: (s: number | null) => void; openSeats: number[]; canJoin: boolean;
  tee: ReturnType<typeof useTee>; wallet: boolean; balance: bigint | null;
}) {
  const rt = t.rt;
  const busy = !!t.busy;

  // A finished hand: who won, and a link to check it.
  const resultBlock = t.result && rt && (rt.phase === PHASE.HAND_COMPLETE || rt.phase === PHASE.REVEALED || rt.phase === PHASE.IDLE) && (
    <div className="mt-4 flex flex-col items-center gap-2" data-testid="result">
      <p className="text-center font-[family-name:var(--font-display)] text-2xl text-amber-300 drop-shadow">
        {t.result.winners.map((w) => (w === t.mySeat ? "You" : `Seat ${w + 1}`)).join(" & ")} won ◎{sol(t.result.winners.reduce((s, w) => s + (t.result!.payouts[w] ?? 0n), 0n))}
        <span className="text-base text-violet-200"> · {END_REASON[t.result.reason] ?? ""}</span>
      </p>
      <div className="flex items-center gap-2 text-xs text-violet-200">
        <span>Rake ◎{sol(t.result.rake)}</span>
        {t.result.verified === true && <span className="rounded-full bg-lime-500/15 px-2 py-0.5 font-black text-lime-300">verified in your browser ✓</span>}
        {t.result.verified === false && <span className="rounded-full bg-rose-500/20 px-2 py-0.5 font-black text-rose-300">verification FAILED</span>}
        <Link className="btn btn-ghost px-3 py-1.5 text-xs" href={`/verify/${t.config?.toBase58()}/${String(t.result.handNo)}`}>Verify hand</Link>
      </div>
    </div>
  );

  if (t.mode === "refunded") {
    return (
      <Card title="This table was closed and refunded">
        <p className="text-sm text-violet-200">Your last synced stack, ◎{sol(t.ledger?.synced_stack)}, is waiting in the table vault.</p>
        <button className="btn btn-lime mt-3" disabled={busy || !t.ledger || t.ledger.synced_stack === 0n} onClick={t.claimRefund}>Claim ◎{sol(t.ledger?.synced_stack)}</button>
      </Card>
    );
  }
  if (t.mode === "cashout") {
    const ready = !!t.ledger?.left;
    return (
      <Card title="You left the table">
        {ready ? (
          <>
            <p className="text-sm text-violet-200">Your final stack is synced to Solana.</p>
            <button className="btn btn-lime mt-3 text-lg" disabled={busy} onClick={t.cashOut} data-testid="cash-out">Cash out ◎{sol(t.ledger!.synced_stack)}</button>
          </>
        ) : (
          <p className="text-sm text-violet-200">Syncing your final stack to Solana… (usually a few seconds; at most one heartbeat)</p>
        )}
      </Card>
    );
  }
  if (t.mode === "resume") {
    return (
      <Card title="You have a seat here">
        <p className="text-sm text-violet-200">Your seat&apos;s session key lives in another tab or device. Resume here: your wallet signs once to log in and once to hand the seat to this tab (the old key stops working).</p>
        <button className="btn btn-lime mt-3" disabled={busy} onClick={t.resume}>Resume my seat</button>
      </Card>
    );
  }
  if (t.mode === "joining") {
    return (
      <Card title="You're bought in">
        <p className="text-sm text-violet-200">Seating you before the next hand… You play from the next deal.</p>
      </Card>
    );
  }
  if (t.mode === "spectator") {
    if (!canJoin) {
      return (
        <>
          {resultBlock}
          <p className="mt-4 text-sm text-violet-300">{!t.snap?.live ? "This table isn't open." : openSeats.length ? "" : "The table is full. Watching the last committed state."}</p>
        </>
      );
    }
    return <>{resultBlock}<BuyIn t={t} pickSeat={pickSeat} setPickSeat={setPickSeat} openSeats={openSeats} tee={tee} wallet={wallet} balance={balance} /></>;
  }

  // ---- seated ----
  const l = t.legal;
  const myTurn = t.toAct === t.mySeat;
  const g = rt?.game;
  const respond = !!g && g.phase === 1 && g.ss_target === t.mySeat && rt?.phase === PHASE.DEALT;
  // Bet sizes to show even when it isn't your turn (rules v1: seen players bet 2× the stake).
  const base = g ? (t.seats[t.mySeat!]?.status === "seen" ? 2n * g.stake : g.stake) : 0n;
  const one = l?.chaal ?? base, two = l?.chaalDouble ?? 2n * base;
  const handActive = rt?.phase === PHASE.DEALT && t.seats[t.mySeat!]?.dealt && t.seats[t.mySeat!]?.status !== "packed";
  return (
    <>
      {rt?.phase === PHASE.DEALT && handActive ? (
        respond ? (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
            <p className="w-full text-center text-sm text-violet-200">Seat {g!.ss_requester + 1} asks you for a Side Show. Accept to compare hands privately; the lower hand packs.</p>
            <button className="btn btn-ember" disabled={busy} onClick={() => t.actions.respond(false)}>Refuse</button>
            <button className="btn btn-lime text-lg" disabled={busy} onClick={() => t.actions.respond(true)}>Accept Side Show</button>
          </div>
        ) : (
          <div className="mt-4 grid w-full max-w-3xl grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-3" data-testid="actions">
            <button className="btn btn-ghost" disabled={!l?.see || busy} onClick={t.actions.see}>See cards</button>
            <button className="btn btn-violet" disabled={!myTurn || !l?.sideShow || busy} onClick={t.actions.sideShow}>Side Show</button>
            <button className="btn btn-ember" disabled={!myTurn || !l?.pack || busy} onClick={t.actions.pack}>Pack</button>
            <button className="btn btn-lime col-span-2 text-lg sm:px-7" disabled={!myTurn || !l?.chaal || busy} onClick={() => t.actions.chaal(false)} data-testid="chaal">
              {t.seats[t.mySeat!]?.status === "seen" ? "Chaal" : "Blind"} <span className="text-sm opacity-90">◎{sol(one)}</span>
            </button>
            <button className="btn btn-lime" disabled={!myTurn || !l?.chaalDouble || busy} onClick={() => t.actions.chaal(true)}>
              ×2 <span className="text-sm opacity-90">◎{sol(two)}</span>
            </button>
            <button className="btn btn-gold" disabled={!myTurn || !l?.show || busy} onClick={t.actions.show} title="Show needs exactly two players">Show</button>
          </div>
        )
      ) : (
        resultBlock || <p className="mt-4 text-sm text-violet-200">{phaseText(t)}</p>
      )}
      <div className="mt-3 flex items-center gap-2">
        {t.mode === "leaving" ? (
          <span className="pill text-amber-200">You&apos;ll leave after this hand, then cash out</span>
        ) : (
          <button className="btn btn-ghost px-3 py-2 text-xs" disabled={busy} onClick={t.leave} data-testid="leave">Leave table</button>
        )}
      </div>
    </>
  );
}

function BuyIn({ t, pickSeat, setPickSeat, openSeats, tee, wallet, balance }: {
  t: T; pickSeat: number | null; setPickSeat: (s: number | null) => void; openSeats: number[]; tee: ReturnType<typeof useTee>; wallet: boolean; balance: bigint | null;
}) {
  const cfg = t.snap!.cfg;
  const boot = t.rt?.boot || cfg.min_buy_in / 40n;
  const minB = Number(cfg.min_buy_in / boot), maxB = Number(cfg.max_buy_in / boot);
  // Leave room for the seat ledger's rent and fees.
  const reserve = 3_000_000n;
  const affordable = balance === null ? maxB : Math.min(maxB, Number((balance > reserve ? balance - reserve : 0n) / boot));
  // Default: 100 boots, or as much as the wallet can cover, until the player moves the slider.
  const [boots, setBoots] = useState<number | null>(null);
  const b = Math.max(minB, Math.min(boots ?? Math.min(100, affordable), maxB));
  const seat = pickSeat !== null && openSeats.includes(pickSeat) ? pickSeat : openSeats[0];
  const amount = BigInt(b) * boot;
  const teeOk = tee.result?.ok === true;
  const enough = balance === null || affordable >= b;
  return (
    <div className="glass mt-4 w-full max-w-md rounded-3xl p-5" data-testid="buy-in">
      <p className="font-[family-name:var(--font-display)] text-xl">Take a seat</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {openSeats.map((s) => (
          <button key={s} onClick={() => setPickSeat(s)} className={`rounded-full px-3 py-1 text-sm font-extrabold ${s === seat ? "bg-lime-500 text-lime-950" : "glass text-violet-200"}`}>Seat {s + 1}</button>
        ))}
      </div>
      <label className="mt-4 block text-sm font-bold text-violet-200">
        Buy-in: <span className="text-white">◎{sol(amount)}</span> <span className="text-violet-300">({b} boots)</span>
        <input type="range" min={minB} max={maxB} step={1} value={b} onChange={(e) => setBoots(Number(e.target.value))} className="mt-2 w-full accent-lime-500" aria-label="Buy-in in boots" />
      </label>
      <div className="flex justify-between text-[11px] text-violet-300"><span>min ◎{sol(cfg.min_buy_in)}</span><span>max ◎{sol(cfg.max_buy_in)}</span></div>
      {!wallet ? (
        <p className="mt-4 text-sm text-amber-200">Connect a wallet (top right) to buy in.</p>
      ) : (
        <>
          <button className="btn btn-lime mt-4 w-full text-lg" disabled={!!t.busy || !teeOk || !enough || seat === undefined} onClick={() => t.buyIn(seat!, amount)} data-testid="buy-in-btn">
            Buy in ◎{sol(amount)} · seat {seat !== undefined ? seat + 1 : "–"}
          </button>
          {!enough && <p className="mt-2 text-xs text-amber-200">Your wallet has ◎{sol(balance)}. Lower the buy-in or get devnet SOL from the wallet menu.</p>}
          {tee.result && !teeOk && <p className="mt-2 text-xs text-rose-200">The private rollup&apos;s TEE attestation didn&apos;t verify, so buy-ins are blocked. <button className="underline" onClick={tee.retry}>Check again</button></p>}
          {tee.result === null && <p className="mt-2 text-xs text-violet-300">Checking the TEE attestation…</p>}
        </>
      )}
      <p className="mt-3 text-[11px] leading-snug text-violet-300">Your wallet signs the buy-in once. This tab then gets its own session key that signs your moves and is the only reader of your cards. Leave any time: you finish the hand, then cash out to this wallet.</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass mt-4 w-full max-w-md rounded-3xl p-5 text-center">
      <p className="font-[family-name:var(--font-display)] text-xl">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto mt-24 max-w-md px-4 text-center text-violet-200">{children}</main>;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "empty" || status === "out") return null;
  const style = status === "seen" ? "bg-lime-500 text-lime-950" : status === "packed" ? "bg-rose-600 text-white" : status === "sitting" ? "bg-amber-500 text-amber-950" : "bg-violet-500 text-white";
  return (
    <span className={`absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow ${style}`}>
      {status === "sitting" ? "joining" : status}
    </span>
  );
}

function SeatSpot({ s, spot, turn, progress, selectable, selected, onPick }: {
  s: SeatView; spot: Spot; turn: boolean; progress: number; selectable: boolean; selected: boolean; onPick: () => void;
}) {
  const style = { ["--x" as string]: `${spot.x}%`, ["--y" as string]: `${spot.y}%`, ["--mx" as string]: `${spot.mx}%`, ["--my" as string]: `${spot.my}%` };
  const pos = "absolute left-[var(--mx)] top-[var(--my)] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center sm:left-[var(--x)] sm:top-[var(--y)]";
  if (!s.wallet) {
    return (
      <div className={pos} style={style}>
        <button
          className={`seat-socket h-12 w-12 text-xl ${selected ? "ring-4 ring-lime-400" : ""}`}
          style={{ ["--tone-glow" as string]: "190 242 100" }}
          disabled={!selectable}
          onClick={onPick}
          title={selectable ? `Take seat ${s.seat + 1}` : "Open seat"}
          aria-label={`Open seat ${s.seat + 1}`}
        >
          +
        </button>
        <span className="pill mt-1 whitespace-nowrap py-0 pl-2 text-[11px] text-violet-200">Seat {s.seat + 1}</span>
      </div>
    );
  }
  const cardsFirst = spot.side === "r";
  const cards = s.dealt && (
    <div className="flex">
      {[0, 1, 2].map((k) => (
        <PlayingCard key={k} id={s.cards?.[k]} width="clamp(1.9rem, 3.4vw, 2.6rem)" rotate={(k - 1) * 12} className={`deal-in ${k ? "-ml-4" : ""} ${s.status === "packed" ? "opacity-40" : ""}`} style={{ animationDelay: `${s.seat * 60 + k * 40}ms` }} />
      ))}
    </div>
  );
  return (
    <div className={pos} style={style} data-testid={`seat-${s.seat}`}>
      <span className="mb-1 whitespace-nowrap text-sm font-extrabold text-violet-100 drop-shadow">{s.you ? "You" : short(s.wallet)}{s.leaving ? " · leaving" : ""}</span>
      <div className={`flex items-center gap-2 ${cardsFirst ? "flex-row-reverse" : ""}`}>
        <div className={`avatar-ring ${turn ? "turn" : ""} ${s.status === "packed" ? "packed" : ""} ${s.winner ? "shadow-[0_0_30px_rgb(251_191_36/.9)]" : ""}`} style={{ ["--t" as string]: progress }}>
          <Avatar name={s.you ? "You" : s.wallet} index={hashIndex(s.wallet)} size={54} />
          <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-violet-600 text-[10px] font-black ring-2 ring-[#1a0b38]">{s.seat + 1}</span>
          <StatusBadge status={s.status} />
        </div>
        <div className="hidden sm:block">{cards}</div>
      </div>
      <span className="pill mt-3 py-0.5 pl-1 text-[11px]">
        <span className="coin" style={{ width: "1rem", height: "1rem", fontSize: "0.55rem" }}>◎</span>
        {sol(s.stack)}
      </span>
      {s.winner && s.payout > 0n && <span className="mt-1 text-[11px] font-black text-amber-300">+◎{sol(s.payout)}</span>}
      {s.category && <span className="mt-0.5 text-[11px] font-bold text-amber-200">{s.category}</span>}
    </div>
  );
}
