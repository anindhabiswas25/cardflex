"use client";

import Link from "next/link";
import { TABLE_STATUS, cashOut, claimRefund, emergencyRefund, type SeatLedger } from "@card-flex/client-sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ApiPlayer } from "@/lib/api";
import { base, loadTables, myLedgers, sendWithWallet, type TableSnapshot } from "@/lib/chain";
import { errorText, short, sol } from "@/lib/format";
import { metaFor } from "@/lib/lobby";
import { useWallet } from "@/lib/wallet";
import { WalletMenu } from "./SiteNav";
import { Sol } from "./Sol";
import { viewW } from "@/lib/viewport";

type Seat = SeatLedger & { address: import("@solana/web3.js").PublicKey; snap: TableSnapshot | null; state: "playing" | "joining" | "leaving" | "syncing" | "cashout" | "refund" | "stalled" | "closed" };
const bit = (m: number, s: number) => ((m >> s) & 1) === 1;

function seatState(l: SeatLedger, s: TableSnapshot | null): Seat["state"] {
  if (!s) return "closed";
  if (s.cfg.status === TABLE_STATUS.REFUNDED) return "refund";
  if (l.left) return "cashout";
  // No sync for the whole refund timeout: the table's rollup stalled, and
  // anyone may switch it to refunds (ADR 0004).
  if (s.live && BigInt(Math.floor(Date.now() / 1000)) >= BigInt(s.cfg.last_sync_time) + BigInt(s.cfg.refund_timeout_secs)) return "stalled";
  const rt = s.rt;
  if (rt && bit(rt.departed, l.seat) && rt.seat_epoch[l.seat] === l.epoch) return "syncing";
  if (rt && bit(rt.leaving, l.seat)) return "leaving";
  if (rt && bit(rt.occupied, l.seat) && rt.seat_epoch[l.seat] === l.epoch) return "playing";
  return "joining";
}

export function Dashboard() {
  const { wallet, balance, refreshBalance } = useWallet();
  const [walletOpen, setWalletOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [player, setPlayer] = useState<ApiPlayer | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Desktop: the hands list gets whatever height is left on screen; show as
  // many rows as fit it (measured), so the page never scrolls.
  const [perPage, setPerPage] = useState(6);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const fit = () => {
      if (viewW() < 1000) return setPerPage(6);
      const row = (ul.querySelector("li") as HTMLElement | null)?.offsetHeight ?? 50;
      setPerPage(Math.max(2, Math.floor((ul.clientHeight + 6) / (row + 6))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(ul);
    return () => ro.disconnect();
  }, [player]);
  useEffect(() => setPage(0), [perPage]);

  const load = useCallback(async () => {
    if (!wallet) return;
    try {
      const ls = await myLedgers(wallet.publicKey);
      const snaps = await loadTables(ls.map((l) => l.config));
      // claim_refund zeroes the stack but keeps the ledger: a claimed seat on a
      // refunded table has nothing left to do, so it isn't "my seat" any more.
      setSeats(ls.map((l, i) => ({ ...l, snap: snaps[i], state: seatState(l, snaps[i]) })).filter((s) => !(s.state === "refund" && s.synced_stack === 0n)));
    } catch {
      setMsg("Couldn't read your seats from Solana. Retrying…");
    }
    setPlayer(await api.player(wallet.publicKey.toBase58(), 30));
  }, [wallet]);
  useEffect(() => {
    setSeats(null);
    setPlayer(undefined);
    load();
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [load]);

  async function pay(l: Seat, kind: "cashout" | "refund" | "stalled") {
    if (!wallet) return;
    setBusy(l.config.toBase58());
    setMsg(null);
    try {
      const p = { payer: wallet.publicKey, config: l.config, seat: l.seat, wallet: wallet.publicKey };
      try {
        // A stalled table: switch it to refunds and claim in one transaction.
        const ixs = kind === "cashout" ? [cashOut(p)] : kind === "stalled" ? [emergencyRefund({ payer: wallet.publicKey, config: l.config }), claimRefund(p)] : [claimRefund(p)];
        await sendWithWallet(wallet, ixs);
      } catch (e) {
        // The keeper may have paid it a moment earlier (cash-out closes the ledger).
        if (kind !== "cashout" || (await base.getAccountInfo(l.address).catch(() => undefined)) !== null) throw e;
      }
      setMsg(`${sol(l.synced_stack)} SOL sent to your wallet.`);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(null);
      refreshBalance();
      load();
    }
  }

  if (!wallet) {
    return (
      <div className="db">
        <Hero />
        <section className="db-empty">
          <img src="/landing/coin-stack.webp" alt="" width={280} height={240} />
          <h2>Connect a wallet</h2>
          <p>Your seats, cash-outs and hands live with your wallet.</p>
          <WalletMenu open={walletOpen} setOpen={setWalletOpen} />
        </section>
        <style>{CSS}</style>
      </div>
    );
  }

  const atTables = (seats ?? []).filter((s) => s.state !== "closed").reduce((t, s) => t + s.synced_stack, 0n);
  const net = player ? BigInt(player.net) : null;
  const winRate = player && player.handsPlayed ? Math.round((100 * player.handsWon) / player.handsPlayed) : 0;
  const stats = [
    { label: "Wallet", icon: WALLET_ICON, value: <><Sol /> {balance === null ? "…" : sol(balance)}</>, sub: "devnet SOL" },
    { label: "At tables", icon: "♠", value: <><Sol /> {seats ? sol(atTables) : "…"}</>, sub: seats ? `${seats.length} seat${seats.length === 1 ? "" : "s"} · last synced` : "reading…" },
    { label: "Hands", icon: "♥", value: player ? String(player.handsPlayed) : "–", sub: player ? `${player.handsWon} won · ${winRate}%` : player === null ? "history offline" : "…" },
    { label: "Net", icon: "♦", value: net === null ? "–" : <>{net >= 0n ? "+" : ""}<Sol /> {sol(net)}</>, sub: "all indexed hands", tone: net === null ? "" : net >= 0n ? "is-up" : "is-down" },
  ];

  return (
    <div className="db">
      <Hero addr={short(wallet.publicKey)} />

      <section className="db-stats">
        {stats.map((s, i) => (
          <div key={s.label} className={`db-stat ${s.tone ?? ""}`} style={{ animationDelay: `${i * 0.06}s` }}>
            <span className="db-ico">{s.icon}</span>
            <small>{s.label}</small>
            <b>{s.value}</b>
            <em>{s.sub}</em>
          </div>
        ))}
      </section>
      {msg && (
        <p className="db-msg" role="status">
          {msg}
        </p>
      )}

      <section className="db-grid">
        <div id="hands" className="db-card db-hands">
          <header>
            <h2>My hands</h2>
            <small>Every hand can be verified</small>
          </header>
          {player === undefined && <p className="db-note">Loading…</p>}
          {player === null && <p className="db-note">The hand history (indexer API) isn&apos;t reachable. Your money and seats are read straight from Solana.</p>}
          {player && !player.recent.length && (
            <p className="db-note">
              No finished hands yet. <Link href="/tables">Find a table →</Link>
            </p>
          )}
          <ul ref={listRef}>
            {player?.recent.slice(page * perPage, (page + 1) * perPage).map((h) => {
              const n = BigInt(h.net);
              return (
                <li key={`${h.table}-${h.handNo}`}>
                  <span className={`db-wl ${h.won ? "is-won" : "is-lost"}`}>{h.won ? "W" : "L"}</span>
                  <div>
                    <b>
                      Hand #{h.handNo} · {metaFor(h.table).name}
                    </b>
                    <small>
                      Seat {h.seat + 1} · {h.endReason.replace("_", " ")} · {h.verified ? <i className="is-ok">verified ✓</i> : <i className="is-bad">not verified</i>}
                    </small>
                  </div>
                  <div className="db-hand-end">
                    <strong className={n >= 0n ? "is-up" : "is-down"}>
                      {n >= 0n ? "+" : ""}<Sol /> {sol(n)}
                    </strong>
                    <Link href={`/verify/${h.table}/${h.handNo}`} className="db-pill">
                      Verify
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
          {player && player.recent.length > perPage && (
            <div className="db-pager">
              <button type="button" aria-label="Newer hands" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                ‹
              </button>
              <span>
                {page * perPage + 1}–{Math.min((page + 1) * perPage, player.recent.length)} of {player.recent.length}
              </span>
              <button type="button" aria-label="Older hands" disabled={(page + 1) * perPage >= player.recent.length} onClick={() => setPage((p) => p + 1)}>
                ›
              </button>
            </div>
          )}
        </div>

        <div className="db-side">
          <div className="db-card" id="seats">
            <header>
              <h2>My seats</h2>
            </header>
            {seats === null && <p className="db-note">Reading Solana…</p>}
            {seats && !seats.length && (
              <p className="db-note">
                No seat anywhere yet. <Link href="/tables">Take one →</Link>
              </p>
            )}
            <ul className="db-seats">
              {seats?.map((s) => {
                const id = s.config.toBase58();
                return (
                  <li key={id} className={`is-${s.state}`}>
                    <div className="db-seat-top">
                      <b>{metaFor(id).name}</b>
                      <span className="db-state">{STATE_TEXT[s.state]}</span>
                    </div>
                    <small>
                      Seat {s.seat + 1} · stack <i><Sol /> {sol(s.synced_stack)}</i> (last synced)
                    </small>
                    <div className="db-acts">
                      {(s.state === "playing" || s.state === "joining" || s.state === "leaving" || s.state === "syncing") && (
                        <Link href={`/table/${id}`} className="db-btn">
                          <span className="db-btn-ico">▶</span>Back to the table
                        </Link>
                      )}
                      {s.state === "cashout" && (
                        <button className="db-btn" disabled={busy === id} onClick={() => pay(s, "cashout")}>
                          <span className="db-btn-ico"><Sol size="15px" /></span>Cash out <Sol /> {sol(s.synced_stack)}
                        </button>
                      )}
                      {s.state === "stalled" && (
                        <button className="db-btn" disabled={busy === id || s.synced_stack === 0n} onClick={() => pay(s, "stalled")} data-testid="start-refund">
                          <span className="db-btn-ico">↺</span>Start refund &amp; claim <Sol /> {sol(s.synced_stack)}
                        </button>
                      )}
                      {s.state === "refund" && (
                        <button className="db-btn" disabled={busy === id || s.synced_stack === 0n} onClick={() => pay(s, "refund")}>
                          <span className="db-btn-ico">↺</span>Claim refund <Sol /> {sol(s.synced_stack)}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {!!seats?.length && (
              <p className="db-fine">Leaving takes effect after the current hand. Your stack goes to {short(wallet.publicKey)} once the hand is synced to Solana.</p>
            )}
          </div>
        </div>
      </section>
      <style>{CSS}</style>
    </div>
  );
}

const WALLET_ICON = (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5Z" />
    <circle cx="16" cy="13.5" r="1.3" fill="currentColor" />
  </svg>
);

function Hero({ addr }: { addr?: string }) {
  return (
    <section className="db-hero">
      <div>
        <span className="db-eyebrow">{addr ? `Wallet ${addr}` : "Dashboard"}</span>
        <h1>
          <small>YOUR</small>
          DASHBOARD
        </h1>
      </div>
      <img className="db-hero-coins" src="/landing/coin-pile.webp" alt="" width={400} height={201} aria-hidden />
    </section>
  );
}

const STATE_TEXT: Record<Seat["state"], string> = {
  playing: "playing",
  joining: "waiting to be seated",
  leaving: "leaving after this hand",
  syncing: "left · syncing final stack",
  cashout: "ready to cash out",
  refund: "table refunded · claim your stack",
  stalled: "table stalled (no sync for its refund timeout) · refund available",
  closed: "table not found",
};

const OUT = "cubic-bezier(.2,.8,.2,1)";
const CSS = `
.db{position:relative;z-index:1;font-family:var(--font-outfit),system-ui,sans-serif;color:#fff}
.db::before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(55% 45% at 85% 0%,rgba(190,70,255,.22),transparent 70%),radial-gradient(45% 40% at 0% 80%,rgba(255,190,60,.08),transparent 70%),linear-gradient(#140f0e,#120128 70%)}
.db h1,.db h2,.db p{margin:0}
.db ul{margin:0;padding:0;list-style:none}
.db-eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:11.5px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#ffd76a}
.db-eyebrow::before{content:"";width:26px;height:1px;background:linear-gradient(90deg,transparent,#ffd76a)}

/* header */
.db-hero{position:relative;display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:10px}
.db-hero h1{margin-top:8px;font-size:clamp(38px,min(calc(5 * var(--vw)),calc(7 * var(--vh))),60px);line-height:1;font-weight:500;letter-spacing:-1px}
.db-hero h1 small{display:block;margin-bottom:6px;font-size:.4em;letter-spacing:4px;color:#ffd76a;font-weight:500}
.db-hero-coins{width:clamp(110px,min(calc(12 * var(--vw)),calc(17 * var(--vh))),180px);height:auto;filter:drop-shadow(0 16px 26px rgba(0,0,0,.55));animation:db-rise .8s ${OUT} .15s both}
@media (max-width:640px){.db-hero-coins{display:none}}

/* stats */
.db-stats{display:grid;gap:14px;margin-top:18px;grid-template-columns:repeat(2,1fr)}
@media (min-width:1000px){.db-stats{grid-template-columns:repeat(4,1fr)}}
.db-stat{position:relative;display:grid;gap:3px;padding:16px 18px 14px;border-radius:26px;border:1px solid rgba(255,214,102,.18);background:linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.015));animation:db-rise .6s ${OUT} both}
.db-ico{position:absolute;right:16px;top:16px;display:grid;place-items:center;width:40px;height:40px;border-radius:13px;font-size:17px;color:#ffd76a;border:1.5px solid transparent;background:linear-gradient(160deg,#341257,#1b0733) padding-box,linear-gradient(160deg,#ffe9a3,#c98a12 55%,#6b3d06) border-box}
.db-stat small{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(233,221,255,.55)}
.db-stat b{margin-top:4px;font-size:clamp(22px,calc(2.3 * var(--vw)),29px);font-weight:600;line-height:1.1}
.db-stat em{font-style:normal;font-size:12.5px;color:rgba(233,221,255,.55)}
.db-stat.is-up b{color:#5cf09a}
.db-stat.is-down b{color:#ff7d8d}
.db-msg{margin-top:16px;padding:12px 18px;border-radius:16px;border:1px solid rgba(255,214,102,.3);background:rgba(255,214,102,.07);font-size:14px;color:#ffe9a3}

/* panels */
.db-grid{display:grid;gap:18px;margin-top:18px;padding-bottom:40px}
@media (min-width:1000px){
  .db{display:flex;flex-direction:column;height:calc(calc(100 * var(--dvh)) - 106px)}
  .db-grid{flex:1;min-height:0;grid-template-columns:1.7fr 1fr;align-items:stretch;padding-bottom:18px}
  .db-hands{display:flex;flex-direction:column;min-height:0}
  .db-hands ul{flex:1;min-height:0;overflow:hidden;align-content:start}
  .db-side{min-height:0;overflow:auto;scrollbar-width:none}
  .db-side::-webkit-scrollbar{display:none}
  /* My seats is as tall as My hands; the note sits at the bottom */
  .db-side{display:flex;flex-direction:column}
  .db-side > .db-card{flex:1;display:flex;flex-direction:column}
  .db-side .db-fine{margin-top:auto !important;padding-top:14px}
}
.db-side{display:grid;gap:18px}
.db-card{padding:18px 20px 16px;border-radius:30px;border:1px solid rgba(255,255,255,.08);background:linear-gradient(160deg,rgba(255,255,255,.055),rgba(255,255,255,.012));scroll-margin-top:24px;animation:db-rise .6s ${OUT} .1s both}
.db-card > header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px}
.db-card > header h2{font-size:22px;font-weight:600;letter-spacing:-.2px}
.db-card > header small{font-size:12px;color:rgba(233,221,255,.5)}
.db-note{font-size:14px;line-height:1.5;color:rgba(233,221,255,.65)}
.db-note a{color:#ffd76a !important}
.db-fine{margin-top:14px !important;font-size:11.5px;line-height:1.5;color:rgba(233,221,255,.45)}

/* hands */
.db-hands ul{display:grid;gap:6px}
.db-hands li{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;padding:7px 12px;border-radius:18px;border:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.025);transition:border-color .2s,background .2s}
.db-hands li:hover{border-color:rgba(255,214,102,.35);background:rgba(255,255,255,.05)}
.db-hands li > div{min-width:0}
.db-hands b{display:block;font-size:14.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.db-hands small{display:block;margin-top:2px;font-size:12px;color:rgba(233,221,255,.55)}
.db-hands i{font-style:normal}
.db-hands .is-ok{color:#5cf09a}
.db-hands .is-bad{color:#ff7d8d}
.db-wl{display:grid;place-items:center;width:34px;height:34px;border-radius:12px;font-size:15px;font-weight:700}
.db-wl.is-won{color:#140f11;background:linear-gradient(#ffe86a,#f5c400);box-shadow:0 4px 14px rgba(245,196,0,.3)}
.db-wl.is-lost{color:#ff9aa7;background:rgba(255,90,110,.14);border:1px solid rgba(255,90,110,.3)}
.db-hands strong{font-size:14.5px;font-weight:600;font-variant-numeric:tabular-nums}
.db .is-up{color:#5cf09a}
.db .is-down{color:#ff7d8d}
.db-pill{padding:7px 14px;border-radius:99px;border:1px solid rgba(255,214,102,.4);font-size:12.5px;font-weight:600;color:#ffd76a !important;transition:background .2s}
.db-pill:hover{background:rgba(255,214,102,.12)}
.db-hand-end{display:flex;align-items:center;gap:14px}
@media (max-width:560px){.db-hand-end{flex-direction:column;align-items:flex-end;gap:6px}.db-pill{padding:5px 12px;font-size:12px}}
.db-pager{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:12px;font-size:12.5px;color:rgba(233,221,255,.6)}
.db-pager button{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,214,102,.4);background:rgba(255,214,102,.06);color:#ffd76a;font:600 18px/1 var(--font-outfit),sans-serif;cursor:pointer;transition:background .2s,opacity .2s}
.db-pager button:hover:not(:disabled){background:rgba(255,214,102,.16)}
.db-pager button:disabled{opacity:.3;cursor:default}

/* seats */
.db-seats{display:grid;gap:10px}
.db-seats li{padding:14px 16px;border-radius:20px;border:1px solid rgba(255,214,102,.2);background:rgba(255,214,102,.035)}
.db-seat-top{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}
.db-seat-top b{font-size:16px;font-weight:600}
.db-state{padding:3px 10px;border-radius:99px;background:rgba(255,255,255,.08);font-size:11.5px;color:rgba(233,221,255,.75)}
.is-playing .db-state{background:rgba(47,224,122,.15);color:#5cf09a}
.is-cashout .db-state,.is-refund .db-state,.is-stalled .db-state{background:rgba(255,214,102,.16);color:#ffd76a}
.db-seats small{display:block;margin-top:6px;font-size:12.5px;color:rgba(233,221,255,.6)}
.db-seats small i{font-style:normal;color:#fff;font-weight:600}
.db-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.db-acts:empty{display:none}
/* premium gold pill: gradient, inner highlight, glow, a sheen that sweeps on hover */
.db-btn{position:relative;display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 20px 0 6px;border:0;border-radius:99px;overflow:hidden;cursor:pointer;
  background:linear-gradient(180deg,#fff27a 0%,#ffe100 45%,#f0b400 100%);color:#1d1200 !important;font:600 13.5px var(--font-outfit),sans-serif;letter-spacing:.2px;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 -2px 0 rgba(150,90,0,.35),0 6px 18px rgba(245,190,0,.3),0 0 0 1px rgba(255,214,102,.5);transition:transform .25s ${OUT},box-shadow .25s}
.db-btn::after{content:"";position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.6),transparent);transform:skewX(-18deg);transition:left .6s ${OUT};pointer-events:none}
.db-btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:inset 0 1px 0 rgba(255,255,255,.75),inset 0 -2px 0 rgba(150,90,0,.35),0 10px 26px rgba(245,190,0,.45),0 0 0 1px rgba(255,214,102,.7)}
.db-btn:hover:not(:disabled)::after{left:120%}
.db-btn-ico{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#1d1200;color:#ffe100;font-size:12px;box-shadow:inset 0 1px 0 rgba(255,255,255,.15)}
.db-btn:disabled{cursor:default;background:rgba(255,255,255,.05);color:rgba(233,221,255,.45) !important;box-shadow:0 0 0 1px rgba(255,214,102,.22)}
.db-btn:disabled .db-btn-ico{background:rgba(255,255,255,.08);color:rgba(233,221,255,.45)}
.db-btn:disabled::after{display:none}

/* not connected */
.db-empty{display:grid;justify-items:center;gap:12px;margin:34px auto 60px;max-width:560px;padding:36px 28px;border:6px solid #1d3743;border-radius:44px;text-align:center;background:radial-gradient(70% 60% at 50% 0%,rgba(196,42,255,.18),transparent 70%)}
.db-empty img{width:150px;height:auto;filter:drop-shadow(0 16px 26px rgba(0,0,0,.55))}
.db-empty h2{font-size:30px;font-weight:600}
.db-empty p{font-size:15px;color:rgba(233,221,255,.65)}
.db-empty .hc-wallet{margin-top:8px}
.db-empty .hc-pop{left:50%;right:auto;transform:translateX(-50%);text-align:left}
@keyframes db-rise{from{opacity:0;transform:translateY(16px)}}
@media (prefers-reduced-motion:reduce){.db *{animation:none !important}}
`;
