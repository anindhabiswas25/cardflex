"use client";

import Link from "next/link";
import { PHASE } from "@card-flex/client-sdk";
import { useEffect, useRef, useState } from "react";
import { avatarIndexes } from "./Avatar";
import { END_REASON, hashIndex, sol } from "@/lib/format";
import { metaFor } from "@/lib/lobby";
import { useTee } from "@/lib/tee";
import { readSettings } from "@/lib/settings";
import { play } from "@/lib/sound";
import { useTable } from "@/lib/useTable";
import { useWallet } from "@/lib/wallet";
import { Sol } from "./Sol";
import { BoardTable } from "./BoardTable";

const TURN_SECS = 25;

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
  const me = t.mySeat !== null ? t.seats[t.mySeat] : null;
  // One character per player at this table (no two alike).
  const avatars = avatarIndexes(t.seats.map((x) => x.wallet), hashIndex);
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
    return () => { document.title = "Card Flex — Fortune Favours the Bold"; };
  }, [myTurnNow, rt?.action_seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const dealtNow = t.gameLive && rt?.phase === PHASE.DEALT;
  useEffect(() => { if (dealtNow) play("deal"); }, [dealtNow, rt?.hand_no]); // eslint-disable-line react-hooks/exhaustive-deps
  const resultKey = t.result ? `${t.result.handNo}` : "";
  useEffect(() => {
    if (!t.result || t.mySeat === null || !t.seats[t.mySeat]?.dealt) return;
    play(t.result.winners.includes(t.mySeat) ? "win" : "lose");
  }, [resultKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (t.mode === "loading") return <Centered>Reading the table from Solana…</Centered>;
  if (t.mode === "missing") return <Centered>No table at this address. <Link className="underline" href="/tables">Back to the lobby</Link></Centered>;

  const myTurn = t.seated && t.toAct !== null && t.toAct === t.mySeat;
  const progress = Math.min(1, t.turnLeft / TURN_SECS);
  const openSeats = t.seats.filter((s) => s.status === "empty").map((s) => s.seat);
  const canJoin = t.mode === "spectator" && !!t.snap?.live && t.snap.cfg.status === 1 && openSeats.length > 0;

  // Every table is drawn as one of the themed boards (tables outside the lobby: Amethyst).
  return (
      <BoardTable
        board={meta.board ?? "amethyst"}
        t={t}
        name={meta.name}
        tableId={tableId}
        tee={tee}
        n={n}
        anchor={anchor}
        avatars={avatars}
        pot={pot}
        potKey={potKey}
        me={me}
        showMeBottom={showMeBottom}
        myTurn={myTurn}
        progress={progress}
        openSeats={openSeats}
        canJoin={canJoin}
        pickSeat={pickSeat}
        setPickSeat={setPickSeat}
        wallet={!!wallet}
        balance={balance}
      />
  );
}

export type T = ReturnType<typeof useTable>;

export function phaseText(t: T): string {
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


export function Panel({ t, pickSeat, setPickSeat, openSeats, canJoin, tee, wallet, balance }: {
  t: T; pickSeat: number | null; setPickSeat: (s: number | null) => void; openSeats: number[]; canJoin: boolean;
  tee: ReturnType<typeof useTee>; wallet: boolean; balance: bigint | null;
}) {
  const rt = t.rt;
  const busy = !!t.busy;

  // A finished hand: who won, and a link to check it.
  const resultBlock = t.result && rt && (rt.phase === PHASE.HAND_COMPLETE || rt.phase === PHASE.REVEALED || rt.phase === PHASE.IDLE) && (
    <div className="mt-4 flex flex-col items-center gap-2" data-testid="result">
      <p className="text-center font-[family-name:var(--font-display)] text-2xl text-amber-300 drop-shadow">
        {t.result.winners.map((w) => (w === t.mySeat ? "You" : `Seat ${w + 1}`)).join(" & ")} won <Sol /> {sol(t.result.winners.reduce((s, w) => s + (t.result!.payouts[w] ?? 0n), 0n))}
        <span className="text-base text-violet-200"> · {END_REASON[t.result.reason] ?? ""}</span>
      </p>
      <div className="flex items-center gap-2 text-xs text-violet-200">
        <span>Rake <Sol /> {sol(t.result.rake)}</span>
        {t.result.verified === true && <span className="rounded-full bg-lime-500/15 px-2 py-0.5 font-black text-lime-300">verified in your browser ✓</span>}
        {t.result.verified === false && <span className="rounded-full bg-rose-500/20 px-2 py-0.5 font-black text-rose-300">verification FAILED</span>}
        <Link className="btn btn-ghost px-3 py-1.5 text-xs" href={`/verify/${t.config?.toBase58()}/${String(t.result.handNo)}`}>Verify hand</Link>
      </div>
    </div>
  );

  if (t.mode === "stalled") {
    return (
      <Card title="This table has stalled">
        <p className="text-sm text-violet-200">Its private rollup hasn&apos;t synced to Solana for the whole refund timeout. Anyone may now switch it to refunds: your last synced stack, <Sol /> {sol(t.ledger?.synced_stack)}, goes straight back to your wallet.</p>
        <button className="btn btn-gold mt-3" disabled={busy || !t.ledger || t.ledger.synced_stack === 0n} onClick={t.claimRefund} data-testid="start-refund">Refund me <Sol /> {sol(t.ledger?.synced_stack)}</button>
      </Card>
    );
  }
  if (t.mode === "refunded") {
    return (
      <Card title="This table was closed and refunded">
        <p className="text-sm text-violet-200">Your last synced stack, <Sol /> {sol(t.ledger?.synced_stack)}, is waiting in the table vault.</p>
        <button className="btn btn-lime mt-3" disabled={busy || !t.ledger || t.ledger.synced_stack === 0n} onClick={t.claimRefund}>Claim <Sol /> {sol(t.ledger?.synced_stack)}</button>
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
            <button className="btn btn-lime mt-3 text-lg" disabled={busy} onClick={t.cashOut} data-testid="cash-out">Cash out <Sol /> {sol(t.ledger!.synced_stack)}</button>
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

  // Seated players: the board's own action bar (BoardTable) takes over.
  return null;
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
        Buy-in: <span className="text-white"><Sol /> {sol(amount)}</span> <span className="text-violet-300">({b} boots)</span>
        <input type="range" min={minB} max={maxB} step={1} value={b} onChange={(e) => setBoots(Number(e.target.value))} className="mt-2 w-full accent-lime-500" aria-label="Buy-in in boots" />
      </label>
      <div className="flex justify-between text-[11px] text-violet-300"><span>min <Sol /> {sol(cfg.min_buy_in)}</span><span>max <Sol /> {sol(cfg.max_buy_in)}</span></div>
      {!wallet ? (
        <p className="mt-4 text-sm text-amber-200">Connect a wallet (top right) to buy in.</p>
      ) : (
        <>
          <button className="btn btn-lime mt-4 w-full text-lg" disabled={!!t.busy || !teeOk || !enough || seat === undefined} onClick={() => t.buyIn(seat!, amount)} data-testid="buy-in-btn">
            Buy in <Sol /> {sol(amount)} · seat {seat !== undefined ? seat + 1 : "–"}
          </button>
          {!enough && <p className="mt-2 text-xs text-amber-200">Your wallet has <Sol /> {sol(balance)}. Lower the buy-in, or get devnet SOL at <a className="underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>.</p>}
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

export function StatusBadge({ status }: { status: string }) {
  if (status === "empty" || status === "out") return null;
  const style = status === "seen" ? "bg-lime-500 text-lime-950" : status === "packed" ? "bg-rose-600 text-white" : status === "sitting" ? "bg-amber-500 text-amber-950" : "bg-violet-500 text-white";
  return (
    <span className={`absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow ${style}`}>
      {status === "sitting" ? "joining" : status}
    </span>
  );
}

