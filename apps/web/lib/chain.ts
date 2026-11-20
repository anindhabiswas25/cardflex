// Everything the app reads from or sends to Solana and the PER.
// Base layer: TableConfig, ledgers, and the LAST COMMITTED copy of each
// table's runtime and hand log (public). PER: the live runtime, readable only
// by the table's seated session keys (and its authority and keeper).
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, PROGRAM_ID, confirmByPolling, decodeHandLog, decodeLedger, decodeRuntime, decodeTableConfig, perConnection, perLogin, perLoginWithSigner,
  sendAndConfirm, sizeOf, tableAddresses, type SeatLedger, type TableConfig, type TableRuntime,
} from "@card-flex/client-sdk";
import { BASE_RPC, PER_RPC } from "./env";
import type { CfWallet } from "./wallet";

export const base = new Connection(BASE_RPC, "confirmed");

export type TableSnapshot = {
  config: PublicKey;
  cfg: TableConfig;
  /** Last committed runtime on the base layer (public, a few seconds behind). */
  rt: TableRuntime | null;
  /** The table is live in the PER (runtime delegated). */
  live: boolean;
  handLog: Record<string, unknown> | null;
};

const tryDecode = <T,>(f: () => T): T | null => { try { return f(); } catch { return null; } };

export async function loadTables(configs: PublicKey[]): Promise<(TableSnapshot | null)[]> {
  if (!configs.length) return [];
  const keys = configs.flatMap((c) => { const t = tableAddresses(c); return [c, t.runtime]; });
  const infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await base.getMultipleAccountsInfo(keys.slice(i, i + 100))));
  return configs.map((config, i) => {
    const c = infos[2 * i], r = infos[2 * i + 1];
    const cfg = c && tryDecode(() => decodeTableConfig(c.data));
    if (!cfg) return null;
    return { config, cfg, rt: r ? tryDecode(() => decodeRuntime(r.data)) : null, live: !!r?.owner.equals(DELEGATION_PROGRAM_ID), handLog: null };
  });
}

export async function loadTable(config: PublicKey): Promise<TableSnapshot | null> {
  const t = tableAddresses(config);
  const [c, r, l] = await base.getMultipleAccountsInfo([config, t.runtime, t.handLog]);
  const cfg = c && tryDecode(() => decodeTableConfig(c.data));
  if (!cfg) return null;
  return {
    config, cfg, rt: r ? tryDecode(() => decodeRuntime(r.data)) : null, live: !!r?.owner.equals(DELEGATION_PROGRAM_ID),
    handLog: l ? tryDecode(() => decodeHandLog(l.data)) : null,
  };
}

/** Every seat ledger this wallet holds, on any table (SeatLedger.wallet at byte 41). */
export async function myLedgers(wallet: PublicKey): Promise<(SeatLedger & { address: PublicKey })[]> {
  const accs = await base.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: 8 + sizeOf({ defined: { name: "SeatLedger" } }) }, { memcmp: { offset: 41, bytes: wallet.toBase58() } }],
  });
  return accs.flatMap((a) => { const l = tryDecode(() => decodeLedger(a.account.data)); return l ? [{ ...l, address: a.pubkey }] : []; });
}

/** A base-layer transaction signed by the player's wallet (one pop-up). */
export async function sendWithWallet(wallet: CfWallet, ixs: TransactionInstruction[], conn: Connection = base): Promise<string> {
  const tx = new Transaction().add(...ixs);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  const signed = await wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const err = await confirmByPolling(conn, sig, 90_000);
  if (err) throw new Error(JSON.stringify(err));
  return sig;
}

/** A PER transaction signed by the session key: no pop-up, no fee. */
export const sendWithSession = (conn: Connection, session: Keypair, ixs: TransactionInstruction[]) =>
  sendAndConfirm(conn, ixs, [session], { skipPreflight: true, retries: 1, timeoutMs: 30_000 });

// ---- PER logins (30-day tokens; kept in memory only) ----
const tokens = new Map<string, Promise<Connection>>();

export function sessionConnection(session: Keypair): Promise<Connection> {
  const k = session.publicKey.toBase58();
  if (!tokens.has(k)) {
    const p = perLogin(session, PER_RPC).then((t) => perConnection(t.token, PER_RPC));
    p.catch(() => tokens.delete(k));
    tokens.set(k, p);
  }
  return tokens.get(k)!;
}

/** The wallet logs in to the PER by signing a challenge (only for recovery steps like rotating a lost session). */
export async function walletConnection(wallet: CfWallet): Promise<Connection> {
  const { token } = await perLoginWithSigner(wallet.publicKey, (m) => wallet.signMessage(m), PER_RPC);
  return perConnection(token, PER_RPC);
}
