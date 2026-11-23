"use client";

// Site navigation shared by the landing page and the top bar of every other
// page: Connect wallet (with its dropdown) and the ☰ menu. Styles live in
// app/globals.css ("site nav").
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { errorText, short, sol } from "@/lib/format";
import { useSettings } from "@/lib/settings";
import { TEST_WALLET, useWallet } from "@/lib/wallet";
import { Sol } from "./Sol";

export function MenuButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="hc-menu-btn" aria-label="Open menu" aria-expanded={open} onClick={onClick}>
      <i />
      <i />
      <i />
    </button>
  );
}

// Connect wallet: the app's wallets (Wallet Standard + the devnet test wallet).
// The wallet signs only buy-ins, cash-outs and refunds; moves use a session key.
export function WalletMenu({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const { wallet, available, balance, connecting, connect, disconnect } = useWallet();
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open, setOpen]);

  async function pick(name: string) {
    setNote(null);
    try {
      await connect(name);
      setOpen(false);
    } catch (e) {
      setNote(errorText(e));
    }
  }
  const addr = wallet?.publicKey.toBase58();
  return (
    <div className="hc-wallet" ref={ref}>
      <button
        type="button"
        className="hc-buy"
        aria-expanded={open}
        disabled={connecting}
        data-testid={wallet ? "wallet-pill" : undefined}
        onClick={() => setOpen(!open)}
      >
        {wallet ? (
          <>
            <span className="hc-coin"><Sol size="16px" /></span>
            {short(addr!)}
          </>
        ) : connecting ? (
          "Connecting…"
        ) : (
          "Connect wallet"
        )}
      </button>
      {open && (
        <div className="hc-pop">
          {wallet ? (
            <>
              <div className="hc-pop-head">
                <span className="hc-pop-wico">{wallet.icon ? <img src={wallet.icon} alt="" width={26} height={26} /> : <Sol size="18px" />}</span>
                <div>
                  <h5>{wallet.name}</h5>
                  <span className="hc-live-dot">Connected · Devnet</span>
                </div>
              </div>
              <div className="hc-pop-bal">
                <small>Balance</small>
                <b>
                  <Sol size="22px" /> {balance === null ? "…" : sol(balance)}
                </b>
                <em>devnet SOL</em>
              </div>
              <button
                type="button"
                className="hc-addr"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(addr!)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1200);
                    })
                    .catch(() => setNote("Couldn't copy here. Select the address instead."));
                }}
              >
                <code>{short(addr!)}</code>
                <span>{copied ? "Copied ✓" : "Copy"}</span>
              </button>
              <button
                type="button"
                className="hc-pop-out"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              <h5>Choose a wallet</h5>
              {[...available, { name: TEST_WALLET, icon: undefined }].map((w) => (
                <button
                  key={w.name}
                  type="button"
                  className="hc-pop-row"
                  data-testid={w.name === TEST_WALLET ? "test-wallet" : undefined}
                  onClick={() => pick(w.name)}
                >
                  {w.icon ? <img src={w.icon} alt="" width={22} height={22} /> : <span className="hc-coin"><Sol size="16px" /></span>}
                  {w.name}
                  <b>→</b>
                </button>
              ))}
              {!available.length && (
                <p>
                  No Solana wallet found in this browser. Install{" "}
                  <a href="https://phantom.app" target="_blank" rel="noreferrer">Phantom</a> or{" "}
                  <a href="https://solflare.com" target="_blank" rel="noreferrer">Solflare</a> (set to Devnet), or use the test wallet.
                </p>
              )}
              <small>Your wallet signs only buy-ins and cash-outs. Moves at the table use a session key, so no pop-ups while you play.</small>
            </>
          )}
          {note && <p className="hc-note" role="status">{note}</p>}
        </div>
      )}
    </div>
  );
}

export const REPO = "https://github.com/anindhabiswas25/cardflex";
export const X_ICON = "M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-6.4L6.4 22H3.3l7.3-8.3L2.9 2h6.4l4.4 5.9L18.9 2Zm-1.1 18.1h1.7L8.3 3.8H6.5l11.3 16.3Z";
export const GH_ICON =
  "M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z";

const MENU_LINKS = [
  { href: "/tables", label: "Tables", sub: "Pick a board and take a seat", icon: "♠" },
  { href: "/rules", label: "Rules", sub: "Hands, betting and Side Show", icon: "♣" },
  { href: "/verify", label: "Verify a hand", sub: "Replay any finished deal", icon: "✓" },
  { href: "/dashboard", label: "Dashboard", sub: "Your seats, hands and money", icon: "♦" },
  { href: "/rules#fair", label: "How it’s fair", sub: "Private cards, open shuffle", icon: "♥" },
];

const BELL = (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
    <path fill="currentColor" d="M12 2a6 6 0 0 0-6 6v3.6l-1.6 2.9A1 1 0 0 0 5.3 16h13.4a1 1 0 0 0 .9-1.5L18 11.6V8a6 6 0 0 0-6-6Zm0 20a3 3 0 0 0 2.8-2H9.2A3 3 0 0 0 12 22Z" />
  </svg>
);
const PREFS: ["sound" | "turnAlert", string, React.ReactNode][] = [
  ["sound", "Sound", "♪"],
  ["turnAlert", "Turn alert", BELL],
];

// ☰ side panel (outside the landing page's scaled stage, so it keeps normal screen size).
export function MenuPanel({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useSettings();
  const path = usePathname();
  // The page underneath doesn't scroll (or show its scrollbar) while the menu is open.
  useEffect(() => {
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = "hidden";
    return () => {
      el.style.overflow = prev;
    };
  }, []);
  return (
    <div className="hc-menu" role="dialog" aria-modal aria-label="Menu">
      <button type="button" className="hc-menu-shade" aria-label="Close menu" onClick={onClose} />
      <div className="hc-menu-panel">
        <button type="button" className="hc-menu-x" aria-label="Close menu" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </button>

        <div className="hc-menu-brand">
          <span className="hc-menu-halo" aria-hidden />
          <img src="/landing/logo.webp" alt="Card Flex" width={560} height={402} />
          <p>
            <i />
            Fortune Favours the Bold
            <i />
          </p>
        </div>

        <nav className="hc-menu-nav">
          {MENU_LINKS.map((l, k) => {
            const active = l.href === path;
            return (
              <Link
                key={l.label}
                href={l.href}
                className={`hc-menu-row ${active ? "is-active" : ""}`}
                style={{ animationDelay: `${0.12 + k * 0.05}s` }}
                onClick={onClose}
              >
                <span className="hc-menu-ico">{l.icon}</span>
                <span className="hc-menu-txt">
                  <b>{l.label}</b>
                  <small>{l.sub}</small>
                </span>
                <span className="hc-menu-go" aria-hidden>
                  →
                </span>
              </Link>
            );
          })}
        </nav>

        {/* preferences (saved in this browser) */}
        <div className="hc-menu-tiles">
          {PREFS.map(([k, label, icon]) => (
            <button key={k} type="button" className="hc-menu-tile" aria-pressed={settings[k]} onClick={() => setSettings({ [k]: !settings[k] })}>
              <span>{icon}</span>
              <i className={`hc-toggle ${settings[k] ? "is-on" : ""}`} />
              <b>{label}</b>
            </button>
          ))}
        </div>

        <div className="hc-menu-foot">
          <a href="#" aria-label="X">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
              <path fill="currentColor" d={X_ICON} />
            </svg>
          </a>
          <a href={REPO} target="_blank" rel="noreferrer" aria-label="GitHub">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
              <path fill="currentColor" d={GH_ICON} />
            </svg>
          </a>
          <span>Devnet preview · 18+</span>
        </div>
      </div>
    </div>
  );
}
