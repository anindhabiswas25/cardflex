import { TopBar } from "@/components/TopBar";
import { VerifyHand } from "@/components/VerifyHand";

export const metadata = { title: "Verify a hand · Card Flex" };

export default async function VerifyPage({ params }: { params: Promise<{ table: string; hand: string }> }) {
  const { table, hand } = await params;
  return (
    <>
      <TopBar />
      <VerifyHand table={table} hand={hand} />
    </>
  );
}
