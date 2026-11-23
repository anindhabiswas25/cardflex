"use client";
// Lobby: the tables in lobby.json, with everything else read on chain.
import { PublicKey } from "@solana/web3.js";
import { PHASE, TABLE_STATUS } from "@card-flex/client-sdk";
import { useEffect, useState } from "react";
import { loadTables } from "@/lib/chain";
import { LOBBY, metaFor, type Tone } from "@/lib/lobby";

const bit = (m: number, s: number) => ((m >> s) & 1) === 1;

/** One lobby table: display data from lobby.json, the rest read on chain. */
export type LobbyEntry = {
  config: string;
  name: string;
  tier: string;
  tone: Tone;
  hot?: boolean;
  boot: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  /** Wallet per seat (null = open). */
  seated: (string | null)[];
  /** Chips in the current hand (last committed state), 0 between hands. */
  pot: bigint;
  handNo: bigint;
  live: boolean;
  open: boolean;
};

// One poller for every component that shows the lobby, shared through a tiny store.
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
