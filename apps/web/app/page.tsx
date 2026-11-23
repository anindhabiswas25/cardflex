import type { Metadata } from "next";
import { CardFlexLanding } from "@/components/CardFlexLanding";

export const metadata: Metadata = { title: "Card Flex — Fortune Favours the Bold" };

export default function Home() {
  return <CardFlexLanding />;
}
