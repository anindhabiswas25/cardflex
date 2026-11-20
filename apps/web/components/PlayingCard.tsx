import { cardRank, cardSuit, SUIT_GLYPH, RANK_LABEL } from "@/lib/cards";

type Props = {
  id?: number; // undefined = face down
  width?: string;
  rotate?: number;
  className?: string;
  style?: React.CSSProperties;
};

export function PlayingCard({ id, width = "4.6rem", rotate = 0, className = "", style }: Props) {
  const common = { ["--cw" as string]: width, transform: `rotate(${rotate}deg)`, ...style };
  if (id === undefined) {
    return (
      <div className={`card card-back ${className}`} style={common} aria-label="hidden card">
        <span className="absolute inset-0 grid place-items-center font-[family-name:var(--font-display)] text-white/80" style={{ fontSize: `calc(${width} * 0.28)` }}>
          CF
        </span>
      </div>
    );
  }
  const suit = cardSuit(id);
  const rank = RANK_LABEL[cardRank(id)];
  const red = suit === 1 || suit === 2;
  return (
    <div className={`card card-face ${red ? "red" : ""} ${className}`} style={common} aria-label={`${rank} of ${["clubs", "diamonds", "hearts", "spades"][suit]}`}>
      <div className="absolute left-[9%] top-[5%] flex flex-col items-center leading-none font-black" style={{ fontSize: `calc(${width} * 0.3)` }}>
        <span>{rank}</span>
        <span style={{ fontSize: "0.8em" }}>{SUIT_GLYPH[suit]}</span>
      </div>
      <span className="absolute bottom-[6%] right-[10%] leading-none" style={{ fontSize: `calc(${width} * 0.62)` }}>
        {SUIT_GLYPH[suit]}
      </span>
    </div>
  );
}
