import type { Metadata } from "next";
import { RulesView } from "@/components/RulesView";
import { TopBar } from "@/components/TopBar";

// Summary of docs/spec/teen-patti-rules-v1.md (signed off 2026-11-19).
export const metadata: Metadata = { title: "Rules — Card Flex" };

export default function Rules() {
  return (
    <>
      <TopBar />
      <RulesView />
    </>
  );
}
