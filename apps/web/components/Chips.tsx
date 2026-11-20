// A small stack of casino chips; height grows with the amount bet.
export function Chips({ count = 3, tone = "violet" }: { count?: number; tone?: "violet" | "gold" | "teal" }) {
  const c = { violet: ["#c4b5fd", "#7c3aed"], gold: ["#fde68a", "#d97706"], teal: ["#a5f3fc", "#0891b2"] }[tone];
  const n = Math.max(1, Math.min(6, count));
  return (
    <svg width="34" height={18 + n * 5} viewBox={`0 0 34 ${18 + n * 5}`} className="chip-stack" aria-hidden>
      {Array.from({ length: n }, (_, i) => {
        const y = 18 + (n - 1 - i) * 5;
        return (
          <g key={i}>
            <ellipse cx="17" cy={y} rx="15" ry="6" fill={c[1]} />
            <ellipse cx="17" cy={y - 2} rx="15" ry="6" fill={c[0]} />
            <ellipse cx="17" cy={y - 2} rx="9" ry="3.4" fill="none" stroke={c[1]} strokeWidth="2" strokeDasharray="3 3" />
          </g>
        );
      })}
    </svg>
  );
}
