// PER (Private Ephemeral Rollup) access: session keys and auth tokens.
// Findings CF-003: the token lasts 30 days with no refresh endpoint, so the
// identity that reads a hand is a per-sit-down session key, never the wallet.
import { Connection, Keypair, Transaction, type Commitment, type ConnectionConfig, type TransactionInstruction } from "@solana/web3.js";
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
/**
 * `httpAgent` (Node only): share one bounded keep-alive pool between
 * connections. CF-061: the PER throttles NEW connections from one IP, so a
 * process with many connections (a keeper, a load test) must reuse a few
 * sockets instead of each Connection opening its own pool of up to 25.
 */
export function perConnection(token: string | null, perUrl: string = ENDPOINTS.devnet.per, commitment: Commitment = "confirmed", httpAgent?: ConnectionConfig["httpAgent"]) {
  const q = token ? `?token=${token}` : "";
  return new Connection(`${perUrl}${q}`, { commitment, wsEndpoint: `${perUrl.replace(/^http/, "ws")}${q}`, ...(httpAgent ? { httpAgent } : {}) });
}

/** Base-layer connection (money, table configs, ledgers). */
export const baseConnection = (url: string = ENDPOINTS.devnet.base, commitment: Commitment = "confirmed") => new Connection(url, commitment);

/**
 * CF-061: confirms a transaction by polling `getSignatureStatuses` over HTTP.
 * Never opens a WebSocket: with web3.js 1.98, a PER socket that closes while
 * `confirmTransaction` waits makes it retry `signatureSubscribe` on the dead
 * socket in a tight loop until the process runs out of memory (seen in the
 * CF-054 load test at 50 tables). PER sockets also miss updates (CF-006).
 * Resolves with the transaction error (null on success); throws on timeout.
 */
export async function confirmByPolling(conn: Connection, signature: string, timeoutMs = 60_000, everyMs = 150): Promise<unknown> {
  const t0 = Date.now();
  // Back off 150 ms -> 1 s: most transactions confirm on the first polls,
  // and a slow one must not hammer the endpoint (CF-054: polling every
  // 150 ms from ~100 senders on one IP tripped the PER's rate limiting).
  let wait = everyMs;
  for (;;) {
    // A failed status poll (network blip) says nothing about the transaction:
    // keep polling until the deadline. Throwing here made callers resend a
    // transaction that had landed (CF-067).
    const st = await conn.getSignatureStatuses([signature]).then((r) => r.value[0], () => undefined);
    if (st?.err) return st.err;
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return null;
    if (Date.now() - t0 > timeoutMs) throw new Error(`not confirmed within ${timeoutMs} ms: ${signature}`);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(1_000, Math.ceil(wait * 1.5));
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 (Bitcoin alphabet), for transaction signatures. */
export function base58(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const byte of bytes) { if (byte !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** The first of `sigs` that landed without error, if any (null if unknown). */
export async function firstLanded(conn: Connection, sigs: string[]): Promise<string | null> {
  if (!sigs.length) return null;
  const st = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }).then((r) => r.value, () => []);
  const i = st.findIndex((x) => x && !x.err && (x.confirmationStatus === "confirmed" || x.confirmationStatus === "finalized"));
  return i >= 0 ? sigs[i] : null;
}

/**
 * CF-067: send, confirm, and retry WITHOUT ever applying a transaction twice.
 * Every copy's signature is known before it is sent; before each resend (and
 * before giving up) the earlier copies are checked, so a copy that landed
 * while its confirmation was slow or lost counts as success. A retry is a new
 * transaction (fresh blockhash), so a stale copy can't land later and be
 * mistaken for it. Only transport failures are retried (network, preflight,
 * confirm timeout); an on-chain error is final. Throws the last error (an
 * on-chain error as its JSON, so `isProgramError` works). Returns the landed
 * signature.
 */
export async function sendAndConfirm(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  o: { skipPreflight?: boolean; retries?: number; timeoutMs?: number; backoffMs?: number } = {},
): Promise<string> {
  const retries = o.retries ?? 2;
  const sent: string[] = [];
  let last: unknown;
  for (let a = 0; a <= retries; a++) {
    if (a > 0) {
      const landed = await firstLanded(conn, sent);
      if (landed) return landed;
      await new Promise((r) => setTimeout(r, o.backoffMs ?? 1_000));
    }
    try {
      const tx = new Transaction().add(...ixs);
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      tx.feePayer = signers[0].publicKey;
      tx.sign(...signers);
      const sig = base58(tx.signature!);
      sent.push(sig); // before sending: the send may reach the cluster and still throw
      await conn.sendRawTransaction(tx.serialize(), { skipPreflight: o.skipPreflight ?? false });
      const err = await confirmByPolling(conn, sig, o.timeoutMs);
      if (!err) return sig;
      // The program refused it: final, don't resend the same instruction
      // (unless an earlier copy landed, which is checked below).
      last = new Error(JSON.stringify(err));
      break;
    } catch (e) {
      last = e; // network, preflight or confirm timeout: retry
    }
  }
  const landed = await firstLanded(conn, sent);
  if (landed) return landed;
  throw last;
}
