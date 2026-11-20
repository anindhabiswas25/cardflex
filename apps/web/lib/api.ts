// The read-only indexer API (services/api, ADR 0006). Amounts are lamport strings.
import { API_URL } from "./env";

export type ApiSeat = { seat: number; wallet: string; startStack: string; bet: string; payout: string; net: string; cards: number[]; won: boolean };
export type ApiHand = { table: string; handNo: string; endReason: string; winners: number[]; pot: string; rake: string; verified: boolean; seats: ApiSeat[]; indexedAt: number };
export type ApiHandFull = ApiHand & { record: object; checks: { overall: string; checks: { name: string; status: string; detail: string }[] } };
export type ApiPlayer = {
  wallet: string; handsPlayed: number; handsWon: number; net: string;
  recent: { table: string; handNo: string; seat: number; net: string; won: boolean; endReason: string; verified: boolean; cards: number[] }[];
};

async function get<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${API_URL}${path}`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null; // API offline: callers show what the chain alone can tell
  }
}

export const api = {
  player: (wallet: string, limit = 50) => get<ApiPlayer>(`/players/${wallet}?limit=${limit}`),
  tableHands: (config: string, limit = 20) => get<ApiHand[]>(`/tables/${config}/hands?limit=${limit}`),
  hand: (config: string, handNo: string) => get<ApiHandFull>(`/hands/${config}/${handNo}`),
  health: () => get<{ ok: boolean }>(`/health`),
};
