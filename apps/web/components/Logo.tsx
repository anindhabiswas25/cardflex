import { Crest } from "./Crest";

export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const big = size === "lg";
  return (
    <div className="flex items-center gap-2 select-none">
      <Crest size={big ? 88 : 40} className="crest-static" />
      <div className={`wordmark flex items-baseline gap-[0.18em] whitespace-nowrap ${big ? "text-6xl sm:text-8xl" : "text-xl sm:text-3xl"}`}>
        <span className="w1">CARD</span>
        <span className="w2">FLEX</span>
      </div>
    </div>
  );
}
