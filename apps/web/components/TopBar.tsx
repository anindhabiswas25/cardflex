"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { MenuButton, MenuPanel, WalletMenu } from "./SiteNav";

const LINKS = [
  { href: "/tables", label: "Tables" },
  { href: "/rules", label: "Rules" },
  { href: "/verify", label: "Verify" },
];

// Top bar of every page except the landing page, in the landing page's style.
export function TopBar() {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);

  // "#menu" in the address opens the menu (deep link); Esc closes overlays.
  useEffect(() => {
    if (window.location.hash === "#menu") setMenu(true);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenu(false);
      setWalletOpen(false);
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, []);

  return (
    <header className="cf-topbar">
      <Link href="/" aria-label="Card Flex home" className="cf-topbar-logo">
        <img src="/landing/logo.webp" alt="Card Flex" width={560} height={402} />
      </Link>
      <nav className="cf-topbar-links">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={path?.startsWith(l.href) ? "is-active" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <WalletMenu open={walletOpen} setOpen={setWalletOpen} />
      <MenuButton open={menu} onClick={() => setMenu(true)} />
      {menu && <MenuPanel onClose={() => setMenu(false)} />}
    </header>
  );
}
