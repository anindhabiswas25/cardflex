import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import { Providers } from "@/components/Providers";
import { MusicPlayer } from "@/components/MusicPlayer";
import { TapSound } from "@/components/TapSound";
import { RotateHint } from "@/components/RotateHint";
import { RotatedScroll } from "@/components/RotatedScroll";
import { ORIENT_SCRIPT } from "@/lib/viewport";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "Card Flex — Fortune Favours the Bold",
  description: "Provably fair card game on Solana. Private cards, every hand verifiable.",
};
export const viewport: Viewport = { themeColor: "#0b0418" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-land / data-rot are set before hydration by ORIENT_SCRIPT (phones play in landscape)
    <html lang="en" className={outfit.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ORIENT_SCRIPT }} />
      </head>
      <body className="min-h-dvh overflow-x-hidden antialiased">
        <div className="cf-rot">
          <div className="cf-rot-in">
            <Providers>{children}</Providers>
          </div>
          <RotatedScroll />
        </div>
        <RotateHint />
        <MusicPlayer />
        <TapSound />
      </body>
    </html>
  );
}
