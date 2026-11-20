// Card Flex emblem: a spade wrapped in a flame, on a faceted gem. Original art.
export function Crest({ size = 120, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" className={className} aria-hidden>
      <defs>
        <linearGradient id="cf-gem" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0abfc" />
          <stop offset="0.5" stopColor="#a855f7" />
          <stop offset="1" stopColor="#4c1d95" />
        </linearGradient>
        <linearGradient id="cf-flame" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#f97316" />
          <stop offset="0.6" stopColor="#fbbf24" />
          <stop offset="1" stopColor="#fef3c7" />
        </linearGradient>
        <linearGradient id="cf-spade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#ddd6fe" />
        </linearGradient>
      </defs>
      <path d="M60 6 L104 34 L104 82 L60 114 L16 82 L16 34 Z" fill="url(#cf-gem)" stroke="#2e1065" strokeWidth="4" strokeLinejoin="round" />
      <path d="M60 6 L104 34 L60 52 L16 34 Z" fill="#ffffff" opacity="0.18" />
      <path d="M60 22 C 68 34, 80 38, 78 52 C 86 46, 88 38, 86 32 C 96 44, 96 66, 82 78 L 38 78 C 24 66, 24 44, 34 32 C 32 38, 34 46, 42 52 C 40 38, 52 34, 60 22 Z" fill="url(#cf-flame)" opacity="0.95" />
      <path d="M60 36 C 46 52, 36 58, 36 68 C 36 78, 46 82, 54 76 C 52 84, 50 88, 46 92 L 74 92 C 70 88, 68 84, 66 76 C 74 82, 84 78, 84 68 C 84 58, 74 52, 60 36 Z" fill="url(#cf-spade)" stroke="#2e1065" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}
