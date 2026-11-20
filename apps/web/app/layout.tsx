import type { Metadata, Viewport } from "next";
import { Lilita_One, Nunito } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Scene } from "@/components/Scene";
import "./globals.css";

const lilita = Lilita_One({ weight: "400", subsets: ["latin"], variable: "--font-lilita" });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito" });

export const metadata: Metadata = {
  title: "Card Flex — Play Blind. Play Bold.",
  description: "Provably fair Teen Patti on Solana. Private cards, every hand verifiable.",
};
export const viewport: Viewport = { themeColor: "#0b0418" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lilita.variable} ${nunito.variable}`}>
      <body className="min-h-dvh overflow-x-hidden antialiased">
        <Scene />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
