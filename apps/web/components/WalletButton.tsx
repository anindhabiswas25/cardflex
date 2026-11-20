"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { errorText, short, sol } from "@/lib/format";
import { requestDevnetSol, TEST_WALLET, useWallet } from "@/lib/wallet";

// The wallet signs only buy-ins, cash-outs and refunds. Moves at the table
// use a session key, so there are no pop-ups while you play.
export function WalletButton() {
  const { wallet, available, balance, connecting, connect, disconnect, refreshBalance } = useWallet();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  async function pick(name: string) {
    setNote(null);
    try {
      await connect(name);
      setOpen(false);
    } catch (e) {
      setNote(errorText(e));
    }
  }

  async function faucet() {
    if (!wallet) return;
    setNote("Asking the devnet faucet…");
    try {
      await requestDevnetSol(wallet.publicKey);
      setNote("◎1 devnet SOL received.");
      refreshBalance();
    } catch {
      setNote("The devnet faucet is busy (rate-limited). Try again in a minute, or use faucet.solana.com.");
    }
  }

  const addr = wallet?.publicKey.toBase58();
  return (
    <div ref={ref} className="relative">
      {wallet ? (
        <button onClick={() => setOpen((o) => !o)} className="pill py-1.5 pl-1.5 pr-3 text-sm" aria-expanded={open} data-testid="wallet-pill">
          <span className="coin">◎</span>
          <span>{balance === null ? "…" : sol(balance)}</span>
          <span className="hidden text-violet-300 sm:inline">· {short(addr!)}</span>
        </button>
      ) : (
        <button onClick={() => setOpen((o) => !o)} className="btn btn-lime px-4 py-2.5 text-sm sm:text-base" aria-expanded={open} disabled={connecting}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden><rect x="2" y="6" width="20" height="14" rx="3" /><path d="M16 13h2M2 10h20" /></svg>
          <span className="hidden sm:inline">{connecting ? "Connecting…" : "Connect wallet"}</span>
          <span className="sm:hidden">{connecting ? "…" : "Connect"}</span>
        </button>
      )}
      {open && (
        <div className="glass absolute right-0 z-40 mt-2 w-72 rounded-2xl p-3">
          {wallet ? (
            <>
              <p className="px-2 text-xs font-bold uppercase tracking-widest text-violet-300">{wallet.name}</p>
              <button
                className="px-2 text-left font-extrabold hover:text-lime-300"
                onClick={() => { navigator.clipboard?.writeText(addr!); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
                title="Copy address"
              >
                {short(addr!)} <span className="text-xs text-violet-300">{copied ? "copied" : "copy"}</span>
              </button>
              <p className="px-2 text-sm text-violet-200">◎ {balance === null ? "…" : sol(balance)} devnet SOL</p>
              <div className="mt-3 grid gap-2">
                <Link href="/dashboard" onClick={() => setOpen(false)} className="btn btn-violet w-full text-sm">My seats &amp; hands</Link>
                <button className="btn btn-ghost w-full text-sm" onClick={faucet}>Get devnet SOL</button>
                <button className="btn btn-ghost w-full text-sm" onClick={() => { disconnect(); setOpen(false); }}>Disconnect</button>
              </div>
            </>
          ) : (
            <>
              <p className="px-2 pb-2 font-[family-name:var(--font-display)] text-lg">Choose a wallet</p>
              {available.map((w) => (
                <button key={w.name} onClick={() => pick(w.name)} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left font-bold hover:bg-white/10">
                  <span className="flex items-center gap-2">
                    {w.icon && <img src={w.icon} alt="" width={22} height={22} className="rounded-md" />}
                    {w.name}
                  </span>
                  <span className="text-violet-300" aria-hidden>→</span>
                </button>
              ))}
              {!available.length && (
                <p className="px-3 pb-2 text-sm text-violet-200">
                  No Solana wallet found in this browser. Install <a className="underline" href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> or <a className="underline" href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> (set it to Devnet), or use a test wallet:
                </p>
              )}
              <button onClick={() => pick(TEST_WALLET)} className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left font-bold hover:bg-white/10" data-testid="test-wallet">
                <span className="flex items-center gap-2"><span className="grid h-[22px] w-[22px] place-items-center rounded-md bg-gradient-to-b from-lime-400 to-green-700 text-xs">◎</span>{TEST_WALLET}</span>
                <span className="text-violet-300" aria-hidden>→</span>
              </button>
              <p className="mt-2 px-2 text-[11px] leading-snug text-violet-300">Your wallet signs only buy-ins and cash-outs. Moves at the table use a session key, so no pop-ups while you play. The test wallet keeps its key in this browser: Devnet only.</p>
            </>
          )}
          {note && <p className="mt-2 px-2 text-xs text-amber-200" role="status">{note}</p>}
        </div>
      )}
    </div>
  );
}
