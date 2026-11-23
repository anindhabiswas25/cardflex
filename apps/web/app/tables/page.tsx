import { Boards } from "@/components/Boards";
import { TopBar } from "@/components/TopBar";

export const metadata = { title: "Tables · Card Flex" };

export default function Tables() {
  return (
    <>
      <TopBar />
      <main>
        <Boards />
      </main>
    </>
  );
}
