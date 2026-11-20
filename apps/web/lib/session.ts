// Per-seat session keys (findings CF-003): the key that reads your cards and
// signs your moves. One per sit-down, kept ONLY in this tab's sessionStorage
// (never localStorage, never sent anywhere). Another tab or device resumes
// the seat with `rotate_session`, signed by the wallet.
import { Keypair } from "@solana/web3.js";

const keyOf = (config: string, wallet: string) => `cf:session:${config}:${wallet}`;

export type StoredSession = { seat: number; key: Keypair };

export function loadSession(config: string, wallet: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(keyOf(config, wallet));
    if (!raw) return null;
    const v = JSON.parse(raw) as { seat: number; secret: number[] };
    return { seat: v.seat, key: Keypair.fromSecretKey(Uint8Array.from(v.secret)) };
  } catch {
    return null;
  }
}

export function saveSession(config: string, wallet: string, s: StoredSession) {
  try {
    sessionStorage.setItem(keyOf(config, wallet), JSON.stringify({ seat: s.seat, secret: [...s.key.secretKey] }));
  } catch { /* storage blocked: the key lives in memory for this page only */ }
}

export function dropSession(config: string, wallet: string) {
  try { sessionStorage.removeItem(keyOf(config, wallet)); } catch { /* ignore */ }
}
