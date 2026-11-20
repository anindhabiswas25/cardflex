import { Dashboard } from "@/components/Dashboard";
import { TopBar } from "@/components/TopBar";

export const metadata = { title: "Dashboard · Card Flex" };

export default function DashboardPage() {
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pb-16 pt-10 sm:px-6">
        <h1 className="font-[family-name:var(--font-display)] text-4xl sm:text-5xl">Dashboard</h1>
        <p className="text-violet-300">Your money, your seats and every hand you played.</p>
        <Dashboard />
      </main>
    </>
  );
}
