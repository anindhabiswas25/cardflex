// Generated avatar: a gradient medallion with the player's initials. No
// external images, so every player gets a distinct, original look.
const PALETTES = [
  ["#f0abfc", "#a21caf"],
  ["#a5b4fc", "#4338ca"],
  ["#fcd34d", "#c2410c"],
  ["#86efac", "#15803d"],
  ["#fda4af", "#be123c"],
  ["#67e8f9", "#0e7490"],
];

export function Avatar({ name, index, size = 64 }: { name: string; index: number; size?: number }) {
  const [a, b] = PALETTES[index % PALETTES.length];
  const initials = name.slice(0, 1).toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className="rounded-full block" aria-hidden>
      <defs>
        <radialGradient id={`av-${index}`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="32" fill={`url(#av-${index})`} />
      <path d="M0 44 Q 32 30 64 44 L64 64 L0 64 Z" fill="#000" opacity="0.18" />
      <text x="32" y="42" textAnchor="middle" fontSize="28" fontWeight="900" fill="#fff" style={{ fontFamily: "var(--font-display)" }}>
        {initials}
      </text>
    </svg>
  );
}
