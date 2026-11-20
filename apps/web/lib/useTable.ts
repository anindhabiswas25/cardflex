"use client";
// The live table: everything one player's browser does at a table.
// - Reads the last committed table state on Solana (public) for everyone.
// - Seated players read the LIVE runtime in the PER with their session key,
//   poll their own SeatHand (CF-006: don't trust the socket), add their
//   randomness to each shuffle automatically, and act with the session key.
// - Money steps (buy-in, cash-out, refund) are signed by the wallet.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ACTION, PHASE, TABLE_STATUS, act as actIx, buyIn as buyInIx, cashOut as cashOutIx, claimRefund as claimRefundIx, decodeLedger, emergencyRefund as emergencyRefundIx,
  decodeRuntime, decodeSeatHand, dealPositions, handRecordFromHandLog, joinSeat, leaveSeat, loadVerifier, newSalt, rotateSession, rules,
  submitSalt, tableAddresses, type SeatLedger, type TableRuntime, type Verifier,
} from "@card-flex/client-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { base, loadTable, sendWithSession, sendWithWallet, sessionConnection, walletConnection, type TableSnapshot } from "./chain";
import { CATEGORY_LABEL, errorText, sol } from "./format";
import { dropSession, loadSession, saveSession, type StoredSession } from "./session";
import { useWallet } from "./wallet";

export type SeatStatus = "empty" | "sitting" | "blind" | "seen" | "packed" | "out";
export type SeatView = {
  seat: number;
  wallet: string | null;
  you: boolean;
  stack: bigint;
  status: SeatStatus;
  /** Chips this seat put in the current hand (boot included). */
  bet: bigint;
  dealt: boolean;
  cards: number[] | null;
  category: string | null;
  winner: boolean;
  payout: bigint;
  leaving: boolean;
};
export type HandResult = { handNo: bigint; reason: number; winners: number[]; payouts: bigint[]; rake: bigint; pot: bigint; shown: Record<number, number[]>; verified: boolean | null };
export type Mode = "loading" | "missing" | "spectator" | "joining" | "resume" | "seated" | "leaving" | "cashout" | "refunded" | "stalled";

const LIVE_POLL_MS = 700;
const BASE_POLL_MS = 3_500;
const PHASES_IN_HAND: number[] = [PHASE.SALTS_PENDING, PHASE.SALTS_DONE, PHASE.VRF_PENDING, PHASE.SEEDED, PHASE.DEALT, PHASE.HAND_COMPLETE, PHASE.REVEALED];

let verifierPromise: Promise<Verifier> | null = null;
export const getVerifier = () => (verifierPromise ??= loadVerifier(fetch("/cf_verify.wasm")));

const bit = (m: number, s: number) => ((m >> s) & 1) === 1;

export function useTable(configStr: string) {
  const { wallet, refreshBalance } = useWallet();
  const config = useMemo(() => { try { return new PublicKey(configStr); } catch { return null; } }, [configStr]);
  const addrs = useMemo(() => (config ? tableAddresses(config) : null), [config]);
  const me = wallet?.publicKey.toBase58() ?? null;

  const [snap, setSnap] = useState<TableSnapshot | null | undefined>(undefined);
  const [ledger, setLedger] = useState<SeatLedger | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);
  const [per, setPer] = useState<Connection | null>(null);
  const [live, setLive] = useState<TableRuntime | null>(null);
  const [liveOk, setLiveOk] = useState<boolean | null>(null); // null = not checked yet
  const [myHand, setMyHand] = useState<{ handNo: bigint; cards: number[] } | null>(null);
  const [peeks, setPeeks] = useState<Record<number, number[]>>({});
  const [result, setResult] = useState<HandResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  /** Set when this wallet's left seat was paid (by the keeper or a cash-out click). */
  const [paid, setPaid] = useState<bigint | null>(null);
  const prevLedger = useRef<SeatLedger | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const prevRt = useRef<TableRuntime | null>(null);
  const saltSent = useRef<string>("");
  const joinTried = useRef<string>("");

  // ---- clock ----
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 250);
    return () => clearInterval(id);
  }, []);

  // ---- base layer: table config + last committed state (everyone) ----
  const refreshBase = useCallback(async () => {
    if (!config) return setSnap(null);
    try {
      const s = await loadTable(config);
      setSnap(s);
      if (s && me) {
        const seat = s.cfg.wallets.findIndex((w, i) => bit(s.cfg.seated, i) && w.toBase58() === me);
        if (seat >= 0) {
          const la = await base.getAccountInfo(tableAddresses(config).ledger(seat));
          setLedger(la ? decodeLedger(la.data) : null);
        } else setLedger(null);
      } else setLedger(null);
    } catch {
      /* keep the last snapshot through network blips */
    }
  }, [config, me]);
  useEffect(() => {
    refreshBase();
    const id = setInterval(refreshBase, BASE_POLL_MS);
    return () => clearInterval(id);
  }, [refreshBase]);

  // The keeper pays players whose departure is synced (`cash_out` is
  // permissionless): a left ledger that disappears was paid out.
  // The payout can land between two polls, before this tab ever saw the
  // ledger marked `left`: what counts is that the seat was on its way out
  // (leaving, departed or left) and its ledger is now gone. The amount is the
  // seat's final stack (the runtime keeps it until the seat is reused).
  const exiting = useRef<{ seat: number; stack: bigint } | null>(null);
  useEffect(() => {
    const rtNow = live ?? snap?.rt ?? null;
    if (ledger) {
      const s = ledger.seat;
      const out = ledger.left || (!!rtNow && (bit(rtNow.leaving, s) || (bit(rtNow.departed, s) && rtNow.seat_epoch[s] === ledger.epoch)));
      exiting.current = out ? { seat: s, stack: ledger.left ? ledger.synced_stack : rtNow?.stacks[s] ?? ledger.synced_stack } : null;
    }
  }, [ledger, live, snap]);
  useEffect(() => {
    const p = prevLedger.current;
    prevLedger.current = ledger;
    if (p && !ledger && exiting.current) {
      setPaid(exiting.current.stack);
      exiting.current = null;
      if (config && me) dropSession(config.toBase58(), me);
      setSession(null);
    }
  }, [ledger]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- session key for my seat (this tab only) ----
  useEffect(() => {
    if (!config || !me) return setSession(null);
    setSession(loadSession(config.toBase58(), me));
  }, [config, me, ledger?.epoch]);

  useEffect(() => {
    setPer(null);
    setLiveOk(null);
    if (!session) return;
    let off = false;
    sessionConnection(session.key).then((c) => !off && setPer(c)).catch((e) => !off && setError(`Couldn't log in to the private rollup: ${errorText(e)}`));
    return () => { off = true; };
  }, [session]);

  // ---- live runtime in the PER (seated players) ----
  useEffect(() => {
    if (!per || !addrs) return;
    let off = false;
    const tick = async () => {
      try {
        const a = await per.getAccountInfo(addrs.runtime);
        if (off) return;
        if (!a) { setLiveOk(false); return; } // not a member (yet): seat not taken by this key
        const rt = decodeRuntime(a.data);
        setLiveOk(session ? rt.session_keys[session.seat]?.equals(session.key.publicKey) && bit(rt.occupied, session.seat) : false);
        setLive(rt);
      } catch { /* blip */ }
    };
    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => { off = true; clearInterval(id); };
  }, [per, addrs, session]);

  const rt: TableRuntime | null = (liveOk && live) || snap?.rt || null;
  const seated = !!(liveOk && session);
  const mySeat = seated ? session!.seat : ledger ? ledger.seat : null;
  const inHand = !!rt && PHASES_IN_HAND.includes(rt.phase);
  const dealtSeats = rt ? rt.dealing_order.slice(0, rt.dealing_count) : [];
  const gameLive = !!rt && rt.phase >= PHASE.DEALT && rt.phase <= PHASE.REVEALED && rt.game.n > 0;

  // ---- my cards (and Side Show views) ----
  useEffect(() => {
    if (!per || !addrs || !live || !seated || mySeat === null) return;
    if (!gameLive || !dealtSeats.includes(mySeat)) return;
    let off = false;
    const handNo = live.hand_no;
    const read = async () => {
      if (myHand?.handNo === handNo) return;
      const a = await per.getAccountInfo(addrs.seatHand(mySeat)).catch(() => null);
      if (off || !a) return;
      const h = decodeSeatHand(a.data);
      if (h.handNo === handNo && h.dealt) setMyHand({ handNo, cards: h.cards });
    };
    read();
    const id = setInterval(read, 900);
    return () => { off = true; clearInterval(id); };
  }, [per, addrs, live?.hand_no, live?.phase, seated, mySeat, gameLive, myHand?.handNo]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!per || !addrs || !live || mySeat === null || live.side_show_hand_no !== live.hand_no) return;
    const viewers = live.side_show_viewers[mySeat] ?? 0;
    const want = [0, 1, 2, 3, 4, 5].filter((s) => bit(viewers, s) && !peeks[s]);
    if (!want.length) return;
    let off = false;
    Promise.all(want.map(async (s) => {
      const a = await per.getAccountInfo(addrs.seatHand(s)).catch(() => null);
      if (!a) return null;
      const h = decodeSeatHand(a.data);
      return h.handNo === live.hand_no ? ([s, h.cards] as const) : null;
    })).then((r) => !off && setPeeks((p) => ({ ...p, ...Object.fromEntries(r.filter(Boolean) as [number, number[]][]) })));
    return () => { off = true; };
  }, [per, addrs, live?.side_show_viewers, live?.hand_no, mySeat]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new hand: forget the old cards and peeks.
  useEffect(() => {
    if (!rt) return;
    if (rt.phase === PHASE.SALTS_PENDING || rt.phase === PHASE.DEALT) {
      setMyHand((h) => (h && h.handNo !== rt.hand_no ? null : h));
      setPeeks((p) => (Object.keys(p).length && rt.side_show_hand_no !== rt.hand_no ? {} : p));
    }
    if (rt.phase === PHASE.DEALT) setResult((r) => (r && r.handNo !== rt.hand_no ? null : r));
  }, [rt?.phase, rt?.hand_no]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- add my randomness to the shuffle (automatic) ----
  useEffect(() => {
    if (!per || !live || !seated || mySeat === null || !config || live.phase !== PHASE.SALTS_PENDING) return;
    if (!live.dealing_order.slice(0, live.dealing_count).includes(mySeat) || bit(live.salts_in, mySeat)) return;
    const tag = `${live.hand_no}`;
    if (saltSent.current === tag) return;
    saltSent.current = tag;
    sendWithSession(per, session!.key, [submitSalt({ session: session!.key.publicKey, config, seat: mySeat, salt: newSalt() })])
      .catch(() => { saltSent.current = ""; }); // retry on the next poll
  }, [per, live?.phase, live?.hand_no, live?.salts_in, seated, mySeat, config]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- a bought-in player who isn't seated yet: seat myself between hands (the keeper does it too) ----
  useEffect(() => {
    if (!per || !session || !config || liveOk !== false || !live || live.phase !== PHASE.IDLE) return;
    const tag = `${session.key.publicKey.toBase58()}:${live.hand_no}`;
    if (joinTried.current === tag) return;
    joinTried.current = tag;
    sendWithSession(per, session.key, [joinSeat({ payer: session.key.publicKey, config, seat: session.seat, live: true })]).catch(() => {});
  }, [per, session, config, liveOk, live?.phase, live?.hand_no]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what happened: a short log from state changes ----
  useEffect(() => {
    const p = prevRt.current;
    prevRt.current = rt;
    if (!rt || !p) return;
    const name = (s: number) => (s === mySeat ? "You" : `Seat ${s + 1}`);
    const out: string[] = [];
    if (rt.hand_no !== p.hand_no || (rt.phase === PHASE.SALTS_PENDING && p.phase !== PHASE.SALTS_PENDING)) out.push(`Hand #${rt.hand_no} starting · players add randomness`);
    if (rt.phase === PHASE.VRF_PENDING && p.phase !== PHASE.VRF_PENDING) out.push("Drawing verifiable randomness…");
    if (rt.phase === PHASE.DEALT && p.phase !== PHASE.DEALT) out.push("Cards dealt");
    if (rt.phase === PHASE.DEALT && p.phase === PHASE.DEALT && rt.hand_no === p.hand_no) {
      for (const s of rt.game.order.slice(0, rt.game.n)) {
        const a = rt.game.seats[s], b = p.game.seats[s];
        if (!a || !b) continue;
        if (a.seen && !b.seen) out.push(`${name(s)} saw ${s === mySeat ? "your" : "their"} cards`);
        if (a.contributed > b.contributed) out.push(`${name(s)} ${b.seen ? "chaal" : "bet blind"} ◎${sol(a.contributed - b.contributed)}`);
        if (b.active && !a.active) out.push(`${name(s)} packed`);
      }
      if (rt.game.phase === 1 && p.game.phase !== 1) out.push(`${name(rt.game.ss_requester)} asks ${name(rt.game.ss_target)} for a Side Show`);
    }
    for (let s = 0; s < 6; s++) {
      if (bit(rt.occupied, s) && !bit(p.occupied, s)) out.push(`${name(s)} sat down`);
      if (bit(rt.leaving, s) && !bit(p.leaving, s)) out.push(`${name(s)} will leave after this hand`);
      if (bit(rt.departed, s) && !bit(p.departed, s)) out.push(`${name(s)} left the table`);
    }
    if (out.length) setEvents((e) => [...e, ...out].slice(-8));
  }, [rt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- result of a finished hand (and the cards it revealed) ----
  useEffect(() => {
    if (!rt || !(rt.phase === PHASE.HAND_COMPLETE || rt.phase === PHASE.REVEALED) || rt.game.phase !== 2) return;
    const g = rt.game;
    const order = g.order.slice(0, g.n);
    const winners = order.filter((s) => bit(g.winners, s));
    const pot = order.reduce((t, s) => t + g.seats[s].contributed, 0n);
    // My own cards stay with the result (I always know them).
    const mine: Record<number, number[]> = mySeat !== null && myHand && myHand.handNo === rt.hand_no ? { [mySeat]: myHand.cards } : {};
    setResult((r) => (r && r.handNo === rt.hand_no && (r.verified !== null || rt.phase !== PHASE.REVEALED)
      ? { ...r, shown: { ...mine, ...r.shown } }
      : { handNo: rt.hand_no, reason: g.end_reason, winners, payouts: [...g.payouts], rake: g.rake, pot, shown: { ...mine, ...(r?.handNo === rt.hand_no ? r.shown : {}) }, verified: null }));
    if (rt.phase !== PHASE.REVEALED || !addrs) return;
    // Revealed: the deck is now public. Rebuild it with the verifier and show
    // the hands that reached a showdown.
    let off = false;
    (async () => {
      const conn = per ?? base;
      const a = await conn.getAccountInfo(addrs.handLog).catch(() => null);
      const record = a && handRecordFromHandLog(Uint8Array.from(a.data));
      if (!record || record.hand_no !== String(rt.hand_no)) return;
      const report = (await getVerifier()).verify(record);
      if (off) return;
      const shown: Record<number, number[]> = {};
      if (report.deck && g.end_reason !== 0) { // a showdown (show or pot limit) reveals the active hands
        order.forEach((s, k) => { if (g.seats[s].active) shown[s] = dealPositions(k, order.length).map((pos) => report.deck![pos]); });
      }
      setResult((r) => (r && r.handNo === rt.hand_no ? { ...r, shown: { ...r.shown, ...shown }, verified: report.overall === "VALID" } : r));
    })().catch(() => {});
    return () => { off = true; };
  }, [rt?.phase, rt?.hand_no, rt?.game.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- seats for the UI ----
  const seats: SeatView[] = useMemo(() => {
    if (!snap) return [];
    const max = snap.cfg.max_seats;
    const g = rt?.game;
    return Array.from({ length: max }, (_, s) => {
      const occupied = rt ? bit(rt.occupied, s) : bit(snap.cfg.seated, s);
      const walletAddr = occupied ? (rt ? rt.wallets[s] : snap.cfg.wallets[s]).toBase58() : bit(snap.cfg.seated, s) ? snap.cfg.wallets[s].toBase58() : null;
      const inGame = gameLive && g && g.order.slice(0, g.n).includes(s);
      const gs = inGame ? g!.seats[s] : null;
      const you = walletAddr !== null && walletAddr === me;
      let status: SeatStatus = !walletAddr ? "empty" : !occupied ? "sitting" : gs ? (!gs.active ? "packed" : gs.seen ? "seen" : "blind") : inHand && dealtSeats.includes(s) ? "blind" : "out";
      if (occupied && !inHand && !gs) status = "out";
      const fromResult = result && rt && (result.handNo === rt.hand_no || !gameLive) ? result.shown[s] : undefined;
      const showCards = fromResult ?? (you && myHand && rt && myHand.handNo === rt.hand_no ? myHand.cards : null) ?? peeks[s] ?? null;
      const resultHere = result && rt && (result.handNo === rt.hand_no || rt.phase === PHASE.IDLE);
      return {
        seat: s,
        wallet: walletAddr,
        you,
        stack: gs ? gs.stack : rt ? rt.stacks[s] : 0n,
        status,
        bet: gs ? gs.contributed : 0n,
        dealt: !!(inHand && dealtSeats.includes(s)) || !!fromResult,
        cards: showCards,
        category: showCards ? CATEGORY_LABEL[rules.categoryOf(showCards)] ?? null : null,
        winner: !!(resultHere && result!.winners.includes(s)),
        payout: resultHere ? result!.payouts[s] ?? 0n : 0n,
        leaving: !!rt && bit(rt.leaving, s),
      };
    });
  }, [snap, rt, gameLive, inHand, dealtSeats.join(","), me, myHand, peeks, result]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- what I may do now ----
  const engine = useMemo(() => (gameLive && rt && rt.phase === PHASE.DEALT ? rules.Hand.fromGameState(rt.game) : null), [gameLive, rt]);
  const toAct = engine && !engine.over ? engine.toAct() : null;
  const legal = useMemo(() => {
    if (!engine || mySeat === null || !seated) return null;
    try { return rules.legalActions(engine, mySeat); } catch { return null; }
  }, [engine, mySeat, seated]);
  const turnLeft = rt && rt.phase === PHASE.DEALT ? Math.max(0, Number(rt.turn_deadline) - now) : 0;

  // ---- mode ----
  const mode: Mode = useMemo(() => {
    if (snap === undefined) return "loading";
    if (snap === null) return "missing";
    if (snap.cfg.status === TABLE_STATUS.REFUNDED) return ledger ? "refunded" : "spectator";
    if (ledger?.left) return "cashout";
    // The rollup stalled: no sync for the whole refund timeout (ADR 0004).
    if (ledger && snap.live && BigInt(Math.floor(now)) >= BigInt(snap.cfg.last_sync_time) + BigInt(snap.cfg.refund_timeout_secs)) return "stalled";
    if (ledger && rt && bit(rt.departed, ledger.seat) && rt.seat_epoch[ledger.seat] === ledger.epoch) return "cashout";
    if (seated && rt && bit(rt.leaving, mySeat!)) return "leaving";
    if (seated) return "seated";
    if (ledger && !session) return "resume";
    if (ledger && session && liveOk === false) return "joining";
    if (ledger && session) return "joining";
    return "spectator";
  }, [snap, ledger, rt, seated, mySeat, session, liveOk, Math.floor(now / 30)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- actions ----
  const run = useCallback(async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try { await f(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); refreshBase(); refreshBalance(); }
  }, [refreshBase, refreshBalance]);

  const buyIn = useCallback((seat: number, amount: bigint) => run("Buying in", async () => {
    if (!wallet || !config || !snap) throw new Error("Connect a wallet first.");
    const key = Keypair.generate();
    const s = { seat, key };
    saveSession(config.toBase58(), wallet.publicKey.toBase58(), s); // before sending: a reload mid-way keeps it
    const ixs = [buyInIx({ wallet: wallet.publicKey, config, seat, amount, sessionKey: key.publicKey })];
    if (!snap.live) ixs.push(joinSeat({ payer: wallet.publicKey, config, seat, live: false }));
    try {
      await sendWithWallet(wallet, ixs);
    } catch (e) {
      dropSession(config.toBase58(), wallet.publicKey.toBase58());
      // Someone took the seat a moment earlier: show the table as it is now.
      if (/SeatTaken|"Custom":6003/.test(String((e as Error)?.message ?? e))) await refreshBase();
      throw e;
    }
    setSession(s);
  }), [run, wallet, config, snap]);

  const send = useCallback((label: string, action: number, amount = 0n) => run(label, async () => {
    if (!per || !session || !config || !live) throw new Error("Not seated.");
    await sendWithSession(per, session.key, [actIx({
      session: session.key.publicKey, config, action, amount, expectedSeq: live.action_seq, dealingOrder: live.game.order.slice(0, live.game.n),
    })]);
  }), [run, per, session, config, live]);

  const actions = useMemo(() => ({
    see: () => send("Seeing", ACTION.SEE),
    chaal: (double = false) => {
      const amt = double ? legal?.chaalDouble : legal?.chaal;
      return amt ? send(double ? "Raising" : "Betting", ACTION.CHAAL, amt) : Promise.resolve();
    },
    pack: () => send("Packing", ACTION.PACK),
    show: () => send("Showing", ACTION.SHOW),
    sideShow: () => send("Asking for a Side Show", ACTION.SIDE_SHOW),
    respond: (accept: boolean) => send(accept ? "Accepting" : "Refusing", ACTION.SIDE_SHOW_RESPOND, accept ? 1n : 0n),
  }), [send, legal]);

  const leave = useCallback(() => run("Leaving", async () => {
    if (!per || !session || !config) throw new Error("Not seated.");
    await sendWithSession(per, session.key, [leaveSeat({ signer: session.key.publicKey, config, seat: session.seat })]);
  }), [run, per, session, config]);

  const cashOut = useCallback(() => run("Cashing out", async () => {
    if (!wallet || !config || !ledger) throw new Error("Nothing to cash out.");
    try {
      await sendWithWallet(wallet, [cashOutIx({ payer: wallet.publicKey, config, seat: ledger.seat, wallet: wallet.publicKey })]);
    } catch (e) {
      // The keeper may have paid it a moment earlier (the ledger is gone).
      const still = await base.getAccountInfo(tableAddresses(config).ledger(ledger.seat)).catch(() => undefined);
      if (still !== null) throw e;
    }
    setPaid(ledger.synced_stack);
    dropSession(config.toBase58(), wallet.publicKey.toBase58());
    setSession(null);
  }), [run, wallet, config, ledger]);

  const claimRefund = useCallback(() => run("Claiming refund", async () => {
    if (!wallet || !config || !ledger || !snap) throw new Error("Nothing to claim.");
    const claim = claimRefundIx({ payer: wallet.publicKey, config, seat: ledger.seat, wallet: wallet.publicKey });
    // A stalled table is switched to refunds in the same transaction.
    await sendWithWallet(wallet, snap.cfg.status === TABLE_STATUS.REFUNDED ? [claim] : [emergencyRefundIx({ payer: wallet.publicKey, config }), claim]);
    setPaid(ledger.synced_stack);
    dropSession(config.toBase58(), wallet.publicKey.toBase58());
    setSession(null);
  }), [run, wallet, config, ledger]);

  /** Resume my seat in this tab: the wallet replaces the session key (one PER login + one signature). */
  const resume = useCallback(() => run("Resuming your seat", async () => {
    if (!wallet || !config || !ledger) throw new Error("No seat to resume.");
    const conn = await walletConnection(wallet);
    const key = Keypair.generate();
    await sendWithWallet(wallet, [rotateSession({ wallet: wallet.publicKey, config, seat: ledger.seat, newSession: key.publicKey })], conn);
    const s = { seat: ledger.seat, key };
    saveSession(config.toBase58(), wallet.publicKey.toBase58(), s);
    setSession(s);
  }), [run, wallet, config, ledger]);

  return {
    config, snap, rt, mode, seats, mySeat, seated, ledger, session, paid, clearPaid: () => setPaid(null),
    toAct, legal, turnLeft, inHand, gameLive, result, events, busy, error, clearError: () => setError(null),
    myCards: (myHand && rt && myHand.handNo === rt.hand_no ? myHand.cards : null) ?? (mySeat !== null && result && !gameLive ? result.shown[mySeat] ?? null : null),
    buyIn, actions, leave, cashOut, claimRefund, resume, refresh: refreshBase,
  };
}
