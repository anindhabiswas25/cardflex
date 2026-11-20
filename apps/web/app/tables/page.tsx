import { LobbySection } from "@/components/Lobby";
import { TopBar } from "@/components/TopBar";

export const metadata = { title: "Tables · Card Flex" };

export default function Tables() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <LobbySection />
      </main>
    </>
  );
}
