"use client";
// Lobby: the tables in lobby.json, with everything else read on chain.
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { PHASE, TABLE_STATUS } from "@card-flex/client-sdk";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { LobbyTable, type LobbyEntry } from "./LobbyTable";
import { loadTables } from "@/lib/chain";
import { hashIndex } from "@/lib/format";
import { LOBBY, metaFor } from "@/lib/lobby";
import { useWallet } from "@/lib/wallet";

const bit = (m: number, s: number) => ((m >> s) & 1) === 1;

// One poller for every component that shows the lobby (the home page shows
// it twice: hero counter and table list), shared through a tiny store.
type LobbyState = { tables: LobbyEntry[] | null; failed: boolean };
let lobbyState: LobbyState = { tables: null, failed: false };
const lobbySubs = new Set<(s: LobbyState) => void>();
let lobbyTimer: ReturnType<typeof setInterval> | null = null;

async function loadLobby() {
  try {
    const snaps = await loadTables(LOBBY.map((m) => new PublicKey(m.config)));
    const tables = snaps.flatMap((s, i) => {
      if (!s) return [];
      const meta = metaFor(LOBBY[i].config);
      const rt = s.rt;
      const occ = rt ? rt.occupied : s.cfg.seated;
      const wallets = rt ? rt.wallets : s.cfg.wallets;
      const inHand = !!rt && rt.phase >= PHASE.DEALT && rt.phase <= PHASE.REVEALED && rt.game.n > 0;
      return [{
        config: meta.config, name: meta.name, tier: meta.tier, tone: meta.toneValue, hot: meta.hot,
        boot: rt && rt.boot > 0n ? rt.boot : s.cfg.min_buy_in / 40n, minBuyIn: s.cfg.min_buy_in, maxBuyIn: s.cfg.max_buy_in,
        seated: Array.from({ length: s.cfg.max_seats }, (_, k) => (bit(occ, k) || bit(s.cfg.seated, k) ? (bit(occ, k) ? wallets[k] : s.cfg.wallets[k]).toBase58() : null)),
        pot: inHand ? rt!.game.pot : 0n, handNo: rt?.hand_no ?? 0n, live: s.live,
        open: s.live && s.cfg.status === TABLE_STATUS.ACTIVE && s.cfg.min_buy_in > 0n,
      }];
    });
    lobbyState = { tables, failed: false };
  } catch {
    lobbyState = { ...lobbyState, failed: true };
  }
  lobbySubs.forEach((f) => f(lobbyState));
}

export function useLobby(): LobbyState {
  const [st, setSt] = useState<LobbyState>(lobbyState);
  useEffect(() => {
    lobbySubs.add(setSt);
    if (!lobbyTimer) {
      loadLobby();
      lobbyTimer = setInterval(loadLobby, 8_000);
    }
    return () => {
      lobbySubs.delete(setSt);
      if (!lobbySubs.size && lobbyTimer) { clearInterval(lobbyTimer); lobbyTimer = null; }
    };
  }, []);
  return st;
}

const FILTERS = ["All", "Low boot", "High roller", "Seats open"] as const;

export function LobbySection({ limit }: { limit?: number }) {
  const { tables, failed } = useLobby();
  const { wallet } = useWallet();
  const you = wallet?.publicKey.toBase58() ?? null;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const shown = useMemo(() => {
    if (!tables) return null;
    const boots = tables.map((t) => t.boot).sort((a, b) => (a < b ? -1 : 1));
    const median = boots[Math.floor(boots.length / 2)] ?? 0n;
    const f = tables.filter((t) =>
      filter === "Low boot" ? t.boot <= median : filter === "High roller" ? t.boot > median || /high|vip/i.test(t.tier) : filter === "Seats open" ? t.open && t.seated.some((s) => !s) : true,
    );
    return limit ? f.slice(0, limit) : f;
  }, [tables, filter, limit]);

  return (
    <section className="mt-20" aria-labelledby="tables" id="tables">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="tables-h" className="font-[family-name:var(--font-display)] text-3xl sm:text-4xl">Choose your table</h2>
          <p className="text-violet-300">Boot, buy-in and seats are fixed per table. Amounts in devnet SOL, read live from Solana.</p>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)} className={`rounded-full px-4 py-1.5 text-sm font-extrabold ${filter === f ? "bg-lime-500 text-lime-950" : "glass text-violet-200"}`}>{f}</button>
          ))}
        </div>
      </div>
      {failed && !tables && <p className="glass mt-8 rounded-2xl p-4 text-amber-200">Couldn&apos;t reach Solana devnet. Retrying…</p>}
      {!tables && !failed && (
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="glass h-[25rem] animate-pulse rounded-[1.75rem]" />)}
        </div>
      )}
      {shown && !shown.length && <p className="glass mt-8 rounded-2xl p-4 text-violet-200">{LOBBY.length ? "No table matches this filter." : "No tables are open yet."}</p>}
      {shown && shown.length > 0 && (
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {shown.map((t) => <LobbyTable key={t.config} t={t} you={you} />)}
        </div>
      )}
      {limit && tables && tables.length > limit && (
        <div className="mt-6 text-center"><Link href="/tables" className="btn btn-ghost">All {tables.length} tables →</Link></div>
      )}
    </section>
  );
}

/** "Play now" (first table with an open seat) and the live player count, for the hero. */
export function HeroLive() {
  const { tables } = useLobby();
  const players = tables ? [...new Set(tables.flatMap((t) => t.seated.filter(Boolean) as string[]))] : [];
  const hands = tables ? tables.reduce((s, t) => s + Number(t.handNo), 0) : 0;
  const target = tables?.find((t) => t.open && t.seated.some((s) => !s)) ?? tables?.find((t) => t.open);
  return (
    <>
      <div className="mt-7 flex flex-wrap gap-3">
        <Link href={target ? `/table/${target.config}` : "/#tables"} className="btn btn-lime px-7 py-4 text-xl">Play now</Link>
        <a href="#fair" className="btn btn-ghost px-6 py-4 text-lg">How it&apos;s fair</a>
      </div>
      <div className="mt-8 flex items-center gap-3 text-sm text-violet-200">
        {players.length > 0 && (
          <div className="flex -space-x-3">
            {players.slice(0, 4).map((w) => (
              <span key={w} className="rounded-full ring-2 ring-[#120630]">
                <Avatar name={w} index={hashIndex(w)} size={36} />
              </span>
            ))}
          </div>
        )}
        <span>
          {tables === null ? "Reading the tables…" : <><b className="text-white">{players.length}</b> player{players.length === 1 ? "" : "s"} seated · <b className="text-white">{tables.length}</b> table{tables.length === 1 ? "" : "s"} · <b className="text-white">{hands.toLocaleString()}</b> hands dealt</>}
        </span>
      </div>
    </>
  );
}
