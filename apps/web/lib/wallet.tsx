"use client";
// Wallets. Real wallets (Phantom, Solflare, Backpack, …) are found with the
// Wallet Standard discovery events, the same protocol @wallet-standard/app
// implements, so no extra dependency. The wallet signs only base-layer money
// steps (buy-in, cash-out, refund claim) and recovery; moves at the table are
// signed by a per-seat session key (no pop-ups).
//
// "Devnet test wallet": a key kept in this browser's localStorage, for
// trying the game without an extension. Devnet only, never for real value.
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import nacl from "tweetnacl";
import { base } from "./chain";
import { CLUSTER } from "./env";

export type CfWallet = {
  name: string;
  icon?: string;
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  disconnect(): Promise<void>;
};

// ---- Wallet Standard (minimal) ----
type StdAccount = { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] };
type StdWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, any>;
};
const CHAIN = `solana:${CLUSTER}`;

function usable(w: StdWallet) {
  return !!w.features["standard:connect"] && !!w.features["solana:signTransaction"] && w.chains.some((c) => c.startsWith("solana:"));
}

function discover(onWallet: (w: StdWallet) => void): () => void {
  const api = Object.freeze({ register: (...ws: StdWallet[]) => { ws.forEach(onWallet); return () => {}; } });
  const listener = (e: Event) => (e as CustomEvent<(a: typeof api) => void>).detail(api);
  window.addEventListener("wallet-standard:register-wallet", listener);
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  return () => window.removeEventListener("wallet-standard:register-wallet", listener);
}

async function connectStd(w: StdWallet, silent = false): Promise<CfWallet> {
  const { accounts } = await w.features["standard:connect"].connect(silent ? { silent: true } : undefined);
  const account: StdAccount | undefined = (accounts ?? w.accounts)[0];
  if (!account) throw new Error(`${w.name} shared no account`);
  return {
    name: w.name,
    icon: w.icon,
    publicKey: new PublicKey(account.publicKey),
    async signTransaction(tx) {
      const [out] = await w.features["solana:signTransaction"].signTransaction({
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }), account, chain: CHAIN,
      });
      return Transaction.from(out.signedTransaction);
    },
    async signMessage(message) {
      const f = w.features["solana:signMessage"];
      if (!f) throw new Error(`${w.name} can't sign messages`);
      const [out] = await f.signMessage({ account, message });
      return out.signature;
    },
    async disconnect() { await w.features["standard:disconnect"]?.disconnect(); },
  };
}

// ---- Devnet test wallet ----
const BURNER_KEY = "cf:test-wallet";
function burnerKeypair(): Keypair {
  try {
    const s = localStorage.getItem(BURNER_KEY);
    if (s) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(s)));
  } catch { /* storage blocked: an in-memory key for this visit */ }
  const k = Keypair.generate();
  try { localStorage.setItem(BURNER_KEY, JSON.stringify([...k.secretKey])); } catch { /* ignore */ }
  return k;
}
function burner(): CfWallet {
  const k = burnerKeypair();
  return {
    name: "Devnet test wallet",
    publicKey: k.publicKey,
    async signTransaction(tx) { tx.partialSign(k); return tx; },
    async signMessage(m) { return nacl.sign.detached(m, k.secretKey); },
    async disconnect() {},
  };
}

// ---- context ----
type WalletState = {
  wallet: CfWallet | null;
  available: { name: string; icon?: string }[];
  balance: bigint | null;
  connecting: boolean;
  connect(name: string): Promise<void>;
  disconnect(): Promise<void>;
  refreshBalance(): void;
};
const Ctx = createContext<WalletState | null>(null);
const LAST = "cf:last-wallet";
export const TEST_WALLET = "Devnet test wallet";

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const std = useRef(new Map<string, StdWallet>());
  const [available, setAvailable] = useState<{ name: string; icon?: string }[]>([]);
  const [wallet, setWallet] = useState<CfWallet | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [connecting, setConnecting] = useState(false);

  const connect = useCallback(async (name: string) => {
    setConnecting(true);
    try {
      const w = name === TEST_WALLET ? burner() : await connectStd(std.current.get(name)!);
      setWallet(w);
      try { localStorage.setItem(LAST, name); } catch { /* ignore */ }
    } finally {
      setConnecting(false);
    }
  }, []);

  useEffect(() => {
    const off = discover((w) => {
      if (!usable(w) || std.current.has(w.name)) return;
      std.current.set(w.name, w);
      setAvailable([...std.current.values()].map((x) => ({ name: x.name, icon: x.icon })));
      // Reconnect silently to the wallet used last time.
      let last: string | null = null;
      try { last = localStorage.getItem(LAST); } catch { /* ignore */ }
      if (last === w.name) connectStd(w, true).then(setWallet).catch(() => {});
    });
    let last: string | null = null;
    try { last = localStorage.getItem(LAST); } catch { /* ignore */ }
    if (last === TEST_WALLET) setWallet(burner());
    return off;
  }, []);

  const refreshBalance = useCallback(() => {
    if (!wallet) return setBalance(null);
    base.getBalance(wallet.publicKey).then((b) => setBalance(BigInt(b))).catch(() => {});
  }, [wallet]);
  useEffect(() => {
    refreshBalance();
    if (!wallet) return;
    const id = setInterval(refreshBalance, 15_000);
    return () => clearInterval(id);
  }, [wallet, refreshBalance]);

  const disconnect = useCallback(async () => {
    await wallet?.disconnect().catch(() => {});
    setWallet(null);
    try { localStorage.removeItem(LAST); } catch { /* ignore */ }
  }, [wallet]);

  const value = useMemo(() => ({ wallet, available, balance, connecting, connect, disconnect, refreshBalance }), [wallet, available, balance, connecting, connect, disconnect, refreshBalance]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside WalletProvider");
  return v;
}

