import { useId } from "react";

// The Solana mark (three slanted bars, teal to purple), drawn as a vector so it
// stays sharp at any size. Used wherever an amount is in SOL.
export function Sol({ size = "0.9em", className = "", title }: { size?: string | number; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      className={`sol-mark ${className}`}
      viewBox="0 0 398 312"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: "inline-block", verticalAlign: "-0.08em", flex: "none" }}
    >
      <defs>
        <linearGradient id={`sol${id}`} x1="360" y1="-30" x2="140" y2="390" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <g fill={`url(#sol${id})`}>
        <path d="M64.6 237.9a14 14 0 0 1 9.9-4.1h317.4c6.2 0 9.4 7.5 5 11.9l-62.7 62.7a14 14 0 0 1-9.9 4.1H6.9c-6.2 0-9.4-7.5-5-11.9z" />
        <path d="M64.6 3.8A14.4 14.4 0 0 1 74.5 0h317.4c6.2 0 9.4 7.5 5 11.9l-62.7 62.7a14 14 0 0 1-9.9 4.1H6.9c-6.2 0-9.4-7.5-5-11.9z" />
        <path d="M333.1 120.1a14 14 0 0 0-9.9-4.1H5.8c-6.2 0-9.4 7.5-5 11.9l62.7 62.7a14 14 0 0 0 9.9 4.1h317.4c6.2 0 9.4-7.5 5-11.9z" />
      </g>
    </svg>
  );
}
