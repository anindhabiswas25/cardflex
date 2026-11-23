import { TopBar } from "@/components/TopBar";
import { VerifyHand } from "@/components/VerifyHand";

export const metadata = { title: "Verify a hand · Card Flex" };

/** Paste a hand record (cf-hand-record/2) or pick a table + hand number. */
export default function VerifyIndex() {
  return (
    <>
      <TopBar />
      <VerifyHand />
    </>
  );
}
