// PER (Private Ephemeral Rollup) access: session keys and auth tokens.
// Findings CF-003: the token lasts 30 days with no refresh endpoint, so the
// identity that reads a hand is a per-sit-down session key, never the wallet.
import { Connection, Keypair, type Commitment } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import { ENDPOINTS } from "./constants.ts";

/** A fresh session key for one sit-down. Keep it in memory or session storage only. */
export const newSessionKey = () => Keypair.generate();

export type PerToken = { token: string; expiresAt: number };

/** Logs a session key in to PER (the key signs a challenge; no wallet pop-up). */
export async function perLogin(session: Keypair, perUrl: string = ENDPOINTS.devnet.per): Promise<PerToken> {
  const { token } = await getAuthToken(perUrl, session.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, session.secretKey));
  return { token, expiresAt: jwtExpiry(token) ?? Date.now() + 30 * 864e5 };
}

/** Expiry (ms) from the token's JWT `exp`, if present. */
export function jwtExpiry(token: string): number | null {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(part)).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** A connection to PER that reads with this token's permissions. */
export function perConnection(token: string | null, perUrl: string = ENDPOINTS.devnet.per, commitment: Commitment = "confirmed") {
  const q = token ? `?token=${token}` : "";
  return new Connection(`${perUrl}${q}`, { commitment, wsEndpoint: `${perUrl.replace(/^http/, "ws")}${q}` });
}

/** Base-layer connection (money, table configs, ledgers). */
export const baseConnection = (url: string = ENDPOINTS.devnet.base, commitment: Commitment = "confirmed") => new Connection(url, commitment);
