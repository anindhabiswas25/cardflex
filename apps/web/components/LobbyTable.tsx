import Link from "next/link";
import { Avatar } from "./Avatar";
import { Chips } from "./Chips";
import { PlayingCard } from "./PlayingCard";
import { hashIndex, short, sol } from "@/lib/format";
import type { Tone } from "@/lib/lobby";

export type LobbyEntry = {
  config: string;
  name: string;
  tier: string;
  tone: Tone;
  hot?: boolean;
  boot: bigint;
  minBuyIn: bigint;
  maxBuyIn: bigint;
  /** Wallet per seat (null = open). */
  seated: (string | null)[];
  /** Chips in the current hand (last committed state), 0 between hands. */
  pot: bigint;
  handNo: bigint;
  live: boolean;
  open: boolean;
};

// Seat positions around the mini rim (% of the stage).
const SEAT_POS: Record<number, [number, number][]> = {
  2: [[50, 33], [50, 91]],
  3: [[50, 33], [86, 75], [14, 75]],
  4: [[50, 33], [90, 62], [50, 91], [10, 62]],
  5: [[50, 33], [88, 50], [72, 91], [28, 91], [12, 50]],
  6: [[30, 34], [70, 34], [92, 62], [70, 91], [30, 91], [8, 62]],
};

export function LobbyTable({ t, you }: { t: LobbyEntry; you?: string | null }) {
  const taken = t.seated.filter(Boolean).length;
  const seats = t.seated.length;
  const full = taken >= seats;
  const pos = SEAT_POS[seats] ?? SEAT_POS[6];
  const fill = Math.round((taken / seats) * 100);
  const mine = !!you && t.seated.includes(you);
  return (
    <article
      className="lobby-card"
      style={{ ["--tone-a" as string]: t.tone.a, ["--tone-b" as string]: t.tone.b, ["--tone-c" as string]: t.tone.c, ["--tone-glow" as string]: t.tone.glow }}
      data-testid="lobby-table"
    >
      <div className="lobby-inner">
        {/* ---------- the board ---------- */}
        <div className="lobby-stage">
          <span className="tier-ribbon">{t.tier}</span>
          <div className="absolute right-3 top-3 flex items-center gap-2">
            {t.hot && <span className="rounded-full bg-gradient-to-b from-orange-400 to-rose-600 px-2.5 py-1 text-[11px] font-black uppercase shadow-lg">🔥 Hot</span>}
            <span className="pill py-1 pl-2 text-[11px]">
              {t.live ? <span className="live-dot" /> : <span className="h-2 w-2 rounded-full bg-rose-400" />}
              {t.live ? `${taken} playing` : "closed"}
            </span>
          </div>

          <div className="mini-rim">
            <div className="mini-felt">
              <div className="mini-fan absolute left-1/2 top-[30%] flex -translate-x-1/2">
                {[0, 1, 2].map((k) => (
                  <PlayingCard key={k} width="1.7rem" rotate={(k - 1) * 14} className={k ? "-ml-3" : ""} />
                ))}
              </div>
              <span className="pill absolute bottom-[14%] left-1/2 -translate-x-1/2 py-0.5 pl-1 text-[11px]">
                <span className="coin" style={{ width: "1rem", height: "1rem", fontSize: "0.55rem" }}>◎</span>
                {t.pot > 0n ? sol(t.pot) : `#${t.handNo}`}
              </span>
            </div>
          </div>
          {t.pot > 0n && <div className="absolute left-[24%] top-[62%]"><Chips count={3} tone="teal" /></div>}
          {t.pot > 0n && <div className="absolute right-[24%] top-[62%]"><Chips count={4} tone="gold" /></div>}

          {pos.map(([x, y], i) => {
            const w = t.seated[i];
            return (
              <div key={i} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${x}%`, top: `${y}%` }}>
                {w ? (
                  <span
                    className="block rounded-full p-[2px] shadow-[0_0_0_2px_#12052b,0_6px_14px_rgba(0,0,0,.5)]"
                    style={{ background: w === you ? "linear-gradient(180deg,#bef264,#65a30d)" : `linear-gradient(180deg, ${t.tone.a}, ${t.tone.b})` }}
                    title={w === you ? "You" : short(w)}
                  >
                    <Avatar name={w === you ? "You" : w} index={hashIndex(w)} size={34} />
                  </span>
                ) : (
                  <span className="seat-socket h-9 w-9 text-lg" title="Open seat">+</span>
                )}
              </div>
            );
          })}
        </div>

        {/* ---------- details ---------- */}
        <div className="relative p-5 pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="tone-text font-[family-name:var(--font-display)] text-[1.7rem] leading-tight">{t.name}</h3>
            <span className="text-[10px] font-bold uppercase tracking-widest text-violet-300">Teen Patti · v1</span>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2">
            {[
              ["Boot", `◎${sol(t.boot)}`, "🪙"],
              ["Buy-in", `◎${sol(t.minBuyIn)} – ${sol(t.maxBuyIn)}`, "🎟️"],
              ["Seats", `${taken}/${seats}`, "💺"],
            ].map(([k, v, icon]) => (
              <div key={k} className="gem-tile">
                <dt className="text-[10px] font-bold uppercase tracking-widest text-violet-300">
                  <span className="mr-1" aria-hidden>{icon}</span>
                  {k}
                </dt>
                <dd className="mt-0.5 text-sm font-extrabold">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/40" role="meter" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100} aria-label="Seats filled">
            <div className="h-full rounded-full" style={{ width: `${fill}%`, background: `linear-gradient(90deg, ${t.tone.b}, ${t.tone.a})`, boxShadow: `0 0 12px rgb(${t.tone.glow} / .8)` }} />
          </div>
          <p className="mt-1.5 text-xs text-violet-300">
            {mine ? "You have a seat here" : !t.open ? "Not open for play" : full ? "Table full — watch the game" : `${seats - taken} seat${seats - taken > 1 ? "s" : ""} open`}
          </p>

          {mine ? (
            <Link href={`/table/${t.config}`} className="btn btn-gold mt-4 w-full text-lg">Back to your seat <span aria-hidden>→</span></Link>
          ) : full || !t.open ? (
            <Link href={`/table/${t.config}`} className="btn btn-ghost mt-4 w-full">Watch</Link>
          ) : (
            <Link href={`/table/${t.config}`} className="btn btn-lime mt-4 w-full text-lg">
              Take a seat <span aria-hidden>→</span>
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
