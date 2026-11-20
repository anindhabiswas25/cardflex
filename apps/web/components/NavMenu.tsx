"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSettings } from "@/lib/settings";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/tables", label: "Tables", icon: "♠" },
  { href: "/rules", label: "Rules", icon: "📜" },
  { href: "/dashboard#hands", label: "My hands", icon: "🂠" },
  { href: "/verify", label: "Verify a hand", icon: "✓" },
  { href: "/#fair", label: "How it's fair", icon: "🛡" },
];

export function NavMenu() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useSettings();
  const sound = settings.sound;

  // "#menu" in the address opens the menu (deep link).
  useEffect(() => {
    if (window.location.hash === "#menu") setOpen(true);
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  return (
    <>
      <button onClick={() => setOpen(true)} className="icon-btn bg-gradient-to-b from-violet-400 to-violet-700" aria-label="Open menu" aria-expanded={open}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="white" aria-hidden><rect y="3" width="20" height="3" rx="1.5" /><rect y="8.5" width="20" height="3" rx="1.5" /><rect y="14" width="20" height="3" rx="1.5" /></svg>
      </button>
      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal aria-label="Menu">
          <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-label="Close menu" onClick={() => setOpen(false)} />
          <nav className="glass absolute right-0 top-0 flex h-full w-[min(20rem,86vw)] flex-col gap-1 rounded-l-3xl p-5" style={{ animation: "menu-in 220ms ease" }}>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-[family-name:var(--font-display)] text-2xl">Menu</span>
              <button onClick={() => setOpen(false)} className="icon-btn glass" aria-label="Close menu">✕</button>
            </div>
            {LINKS.map((l) => (
              <Link key={l.label} href={l.href} onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-2xl px-3 py-3 font-extrabold hover:bg-white/10">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-fuchsia-500 to-violet-700 text-base shadow-[inset_0_2px_0_rgba(255,255,255,.3)]" aria-hidden>{l.icon}</span>
                {l.label}
              </Link>
            ))}
            <div className="my-3 h-px bg-violet-400/20" />
            <button onClick={() => setSettings({ sound: !sound })} className="flex items-center justify-between rounded-2xl px-3 py-3 font-extrabold hover:bg-white/10" aria-pressed={sound}>
              <span className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-white/10" aria-hidden>{sound ? "🔊" : "🔈"}</span>Sound</span>
              <span className={`relative h-6 w-11 rounded-full transition ${sound ? "bg-lime-500" : "bg-white/20"}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${sound ? "left-[1.4rem]" : "left-0.5"}`} />
              </span>
            </button>
            <Link href="/dashboard#settings" onClick={() => setOpen(false)} className="flex items-center gap-3 rounded-2xl px-3 py-3 font-extrabold hover:bg-white/10">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-amber-300 to-amber-600 text-amber-950" aria-hidden>⚙</span>
              Settings
            </Link>
            <p className="mt-auto text-xs text-violet-300/70">Card Flex · Devnet preview · 18+</p>
          </nav>
        </div>
      )}
    </>
  );
}
