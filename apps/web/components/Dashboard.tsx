"use client";

import Link from "next/link";
import { TABLE_STATUS, cashOut, claimRefund, type SeatLedger } from "@card-flex/client-sdk";
import { useCallback, useEffect, useState } from "react";
import { api, type ApiPlayer } from "@/lib/api";
import { loadTables, myLedgers, sendWithWallet, type TableSnapshot } from "@/lib/chain";
import { errorText, short, sol } from "@/lib/format";
import { metaFor } from "@/lib/lobby";
import { useSettings } from "@/lib/settings";
import { useWallet } from "@/lib/wallet";

type Seat = SeatLedger & { snap: TableSnapshot | null; state: "playing" | "joining" | "leaving" | "syncing" | "cashout" | "refund" | "closed" };
const bit = (m: number, s: number) => ((m >> s) & 1) === 1;

function seatState(l: SeatLedger, s: TableSnapshot | null): Seat["state"] {
  if (!s) return "closed";
  if (s.cfg.status === TABLE_STATUS.REFUNDED) return "refund";
  if (l.left) return "cashout";
  const rt = s.rt;
  if (rt && bit(rt.departed, l.seat) && rt.seat_epoch[l.seat] === l.epoch) return "syncing";
  if (rt && bit(rt.leaving, l.seat)) return "leaving";
  if (rt && bit(rt.occupied, l.seat) && rt.seat_epoch[l.seat] === l.epoch) return "playing";
  return "joining";
}

export function Dashboard() {
  const { wallet, balance, refreshBalance } = useWallet();
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [player, setPlayer] = useState<ApiPlayer | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wallet) return;
    try {
      const ls = await myLedgers(wallet.publicKey);
      const snaps = await loadTables(ls.map((l) => l.config));
      setSeats(ls.map((l, i) => ({ ...l, snap: snaps[i], state: seatState(l, snaps[i]) })));
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

  async function pay(l: Seat, kind: "cashout" | "refund") {
    if (!wallet) return;
    setBusy(l.config.toBase58());
    setMsg(null);
    try {
      const p = { payer: wallet.publicKey, config: l.config, seat: l.seat, wallet: wallet.publicKey };
      await sendWithWallet(wallet, [kind === "cashout" ? cashOut(p) : claimRefund(p)]);
      setMsg(`◎${sol(l.synced_stack)} sent to your wallet.`);
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
      <div className="glass mt-8 rounded-3xl p-6 text-center">
        <p className="font-[family-name:var(--font-display)] text-2xl">Connect a wallet</p>
        <p className="mt-1 text-violet-200">Your seats, cash-outs and hand history live with your wallet. Use the button at the top right.</p>
      </div>
    );
  }

  const atTables = (seats ?? []).filter((s) => s.state !== "closed").reduce((t, s) => t + s.synced_stack, 0n);
  const net = player ? BigInt(player.net) : null;
  const stats = [
    { label: "Wallet", value: `◎ ${balance === null ? "…" : sol(balance)}`, sub: "devnet SOL", tone: "from-fuchsia-500 to-violet-700" },
    { label: "At tables", value: `◎ ${seats ? sol(atTables) : "…"}`, sub: seats ? `${seats.length} seat${seats.length === 1 ? "" : "s"} · last synced` : "reading…", tone: "from-lime-400 to-green-700" },
    { label: "Hands played", value: player ? String(player.handsPlayed) : "–", sub: player ? `${player.handsWon} won · ${player.handsPlayed ? Math.round((100 * player.handsWon) / player.handsPlayed) : 0}%` : player === null ? "history service offline" : "…", tone: "from-amber-300 to-orange-600" },
    { label: "Net result", value: net === null ? "–" : `${net >= 0n ? "+" : ""}◎ ${sol(net)}`, sub: "all indexed hands", tone: "from-sky-400 to-indigo-700" },
  ];

  return (
    <>
      <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="glass relative overflow-hidden rounded-3xl p-5">
            <div className={`absolute -right-8 -top-8 h-28 w-28 rounded-full bg-gradient-to-br ${s.tone} opacity-40 blur-2xl`} />
            <p className="relative text-xs font-bold uppercase tracking-widest text-violet-300">{s.label}</p>
            <p className="relative mt-1 font-[family-name:var(--font-display)] text-3xl">{s.value}</p>
            <p className="relative text-sm text-violet-200">{s.sub}</p>
          </div>
        ))}
      </section>
      {msg && <p className="mt-4 rounded-2xl bg-white/10 px-4 py-2 text-sm text-amber-100" role="status">{msg}</p>}

      <section className="mt-8 grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div id="hands" className="glass scroll-mt-8 rounded-3xl p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-[family-name:var(--font-display)] text-2xl">My hands</h2>
            <span className="text-xs text-violet-300">Every hand can be verified</span>
          </div>
          {player === undefined && <p className="mt-4 text-violet-300">Loading…</p>}
          {player === null && <p className="mt-4 text-sm text-violet-300">The hand-history service (indexer API) isn&apos;t reachable. Your money and seats below are read straight from Solana and are unaffected.</p>}
          {player && !player.recent.length && <p className="mt-4 text-sm text-violet-300">No finished hands yet. <Link className="underline" href="/#tables">Find a table</Link>.</p>}
          <ul className="mt-4 divide-y divide-violet-400/15">
            {player?.recent.map((h) => {
              const n = BigInt(h.net);
              const win = h.won;
              return (
                <li key={`${h.table}-${h.handNo}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                  <span className={`grid h-10 w-10 place-items-center rounded-xl font-black ${win ? "bg-lime-500/20 text-lime-300" : "bg-rose-500/15 text-rose-300"}`}>{win ? "W" : "L"}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-extrabold">Hand #{h.handNo} · {metaFor(h.table).name}</p>
                    <p className="text-sm text-violet-300">Seat {h.seat + 1} · {h.endReason.replace("_", " ")} {h.verified ? "· verified ✓" : "· NOT verified"}</p>
                  </div>
                  <span className={`font-extrabold tabular-nums ${n >= 0n ? "text-lime-300" : "text-rose-300"}`}>◎ {n >= 0n ? "+" : ""}{sol(n)}</span>
                  <Link href={`/verify/${h.table}/${h.handNo}`} className="btn btn-ghost px-3 py-2 text-xs">Verify</Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="flex flex-col gap-5">
          <div className="glass rounded-3xl p-5 sm:p-6" id="seats">
            <h2 className="font-[family-name:var(--font-display)] text-2xl">My seats</h2>
            {seats === null && <p className="mt-2 text-sm text-violet-300">Reading Solana…</p>}
            {seats && !seats.length && <p className="mt-2 text-sm text-violet-300">You don&apos;t hold a seat anywhere. <Link className="underline" href="/#tables">Take one</Link>.</p>}
            <ul className="mt-3 flex flex-col gap-3">
              {seats?.map((s) => {
                const id = s.config.toBase58();
                return (
                  <li key={id} className="rounded-2xl bg-black/20 p-3 ring-1 ring-violet-400/20">
                    <p className="font-extrabold">{metaFor(id).name} · seat {s.seat + 1}</p>
                    <p className="text-sm text-violet-300">Stack ◎{sol(s.synced_stack)} (last synced) · {STATE_TEXT[s.state]}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(s.state === "playing" || s.state === "joining" || s.state === "leaving" || s.state === "syncing") && <Link href={`/table/${id}`} className="btn btn-lime px-3 py-2 text-xs">Back to the table</Link>}
                      {s.state === "cashout" && <button className="btn btn-lime px-3 py-2 text-xs" disabled={busy === id} onClick={() => pay(s, "cashout")}>Cash out ◎{sol(s.synced_stack)}</button>}
                      {s.state === "refund" && <button className="btn btn-gold px-3 py-2 text-xs" disabled={busy === id || s.synced_stack === 0n} onClick={() => pay(s, "refund")}>Claim refund ◎{sol(s.synced_stack)}</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-[11px] leading-snug text-violet-300">Leaving takes effect after the current hand. Your stack is paid to the wallet you bought in with ({short(wallet.publicKey)}), once the hand is synced to Solana.</p>
          </div>
          <Settings />
        </div>
      </section>
    </>
  );
}

const STATE_TEXT: Record<Seat["state"], string> = {
  playing: "playing",
  joining: "waiting to be seated",
  leaving: "leaving after this hand",
  syncing: "left · syncing final stack",
  cashout: "ready to cash out",
  refund: "table refunded · claim your stack",
  closed: "table not found",
};

function Settings() {
  const [s, set] = useSettings();
  const rows: [keyof typeof s, string][] = [["sound", "Sound effects"], ["animations", "Card animations"], ["turnAlert", "Alert me when it's my turn"]];
  return (
    <div id="settings" className="glass scroll-mt-8 rounded-3xl p-5 sm:p-6">
      <h2 className="font-[family-name:var(--font-display)] text-2xl">Settings</h2>
      {rows.map(([k, label]) => (
        <label key={k} className="mt-3 flex items-center justify-between text-sm font-bold">
          {label}
          <input type="checkbox" checked={s[k]} onChange={(e) => set({ [k]: e.target.checked })} className="h-5 w-5 accent-lime-500" />
        </label>
      ))}
      <p className="mt-3 text-[11px] text-violet-300">Saved in this browser.</p>
    </div>
  );
}
