import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import { Providers } from "@/components/Providers";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-outfit" });

export const metadata: Metadata = {
  title: "Card Flex — Fortune Favours the Bold",
  description: "Provably fair card game on Solana. Private cards, every hand verifiable.",
};
export const viewport: Viewport = { themeColor: "#0b0418" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className="min-h-dvh overflow-x-hidden antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
