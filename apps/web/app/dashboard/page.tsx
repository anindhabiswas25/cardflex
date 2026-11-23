import { Dashboard } from "@/components/Dashboard";
import { TopBar } from "@/components/TopBar";

export const metadata = { title: "Dashboard · Card Flex" };

export default function DashboardPage() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-4 sm:px-6">
        <Dashboard />
      </main>
    </>
  );
}
