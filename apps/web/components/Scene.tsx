// Background hall: an arched colonnade with warm wall sconces, haze and
// drifting embers. Original SVG/CSS art. Deterministic positions so the
// server and client render the same markup.
const EMBERS = Array.from({ length: 22 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: (i * 1.7) % 9,
  duration: 9 + ((i * 13) % 8),
  drift: (i % 2 ? 1 : -1) * (20 + ((i * 11) % 50)) + "px",
}));
const ARCHES = [-5, 15, 35, 65, 85, 105];

export function Scene() {
  return (
    <div className="scene" aria-hidden>
      <svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="hall-wall" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3d1d86" />
            <stop offset="1" stopColor="#12062c" />
          </linearGradient>
          <radialGradient id="sconce-glow">
            <stop offset="0" stopColor="#fdba74" stopOpacity="0.85" />
            <stop offset="0.35" stopColor="#f97316" stopOpacity="0.3" />
            <stop offset="1" stopColor="#f97316" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.45" stopColor="#fff" />
            <stop offset="0.95" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <mask id="hall-fade"><rect width="1600" height="900" fill="url(#fade)" /></mask>
        </defs>
        <g mask="url(#hall-fade)" opacity="1">
          {/* Back wall with arched openings */}
          {ARCHES.map((x, i) => (
            <g key={i} transform={`translate(${(x / 100) * 1600} 0)`}>
              <path d="M-90 900 L-90 330 Q -90 200 0 170 Q 90 200 90 330 L90 900 Z" fill="#0a031c" opacity="0.85" />
              <rect x="-118" y="120" width="28" height="780" fill="url(#hall-wall)" />
              <rect x="90" y="120" width="28" height="780" fill="url(#hall-wall)" />
              <rect x="-124" y="112" width="40" height="18" rx="3" fill="#3b1a7a" />
              <rect x="84" y="112" width="40" height="18" rx="3" fill="#3b1a7a" />
            </g>
          ))}
          {/* Sconces on the outer pillars */}
          {[180, 420, 1180, 1420].map((x, i) => (
            <g key={x} className="sconce" style={{ animationDelay: `${i * 0.7}s` }}>
              <circle cx={x} cy="300" r="110" fill="url(#sconce-glow)" />
              <rect x={x - 3} y="292" width="6" height="22" rx="2" fill="#fde68a" />
              <path d={`M${x} 278 q 7 10 0 16 q -7 -6 0 -16z`} fill="#fef3c7" />
            </g>
          ))}
        </g>
      </svg>
      {EMBERS.map((e, i) => (
        <span
          key={i}
          className="ember"
          style={{
            left: `${e.left}%`,
            animationDelay: `${e.delay}s`,
            animationDuration: `${e.duration}s`,
            ["--drift" as string]: e.drift,
          }}
        />
      ))}
    </div>
  );
}
