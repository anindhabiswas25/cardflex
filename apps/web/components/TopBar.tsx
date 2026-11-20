import Link from "next/link";
import { Logo } from "./Logo";
import { NavMenu } from "./NavMenu";
import { WalletButton } from "./WalletButton";

export function TopBar() {
  return (
    <header className="relative z-20 mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-4 sm:px-6">
      <Link href="/" aria-label="Card Flex home" className="transition hover:brightness-110">
        <Logo />
      </Link>
      <div className="flex items-center gap-2 sm:gap-3">
        <WalletButton />
        <NavMenu />
      </div>
    </header>
  );
}
