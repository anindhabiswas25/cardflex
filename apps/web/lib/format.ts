// Display helpers. Amounts are lamports (bigint) everywhere in the app.
import { idl } from "@card-flex/client-sdk";
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "0.025", "1.20", "12.5" — enough digits to tell bets apart. */
export function sol(lamports: bigint | number | string | null | undefined): string {
  if (lamports === null || lamports === undefined) return "–";
  const l = typeof lamports === "bigint" ? lamports : BigInt(lamports);
  const neg = l < 0n;
  const v = Number(neg ? -l : l) / 1e9;
  const s = v === 0 ? "0" : v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toFixed(4);
  return `${neg ? "−" : ""}${s.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")}`;
}

export const toLamports = (solAmount: number) => BigInt(Math.round(solAmount * 1e9));

export const short = (addr: string | { toBase58(): string }) => {
  const s = typeof addr === "string" ? addr : addr.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
};

/** A stable small number per address (avatar colours). */
export const hashIndex = (addr: string) => [...addr].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);

export const CATEGORY_LABEL: Record<string, string> = {
  high_card: "High card", pair: "Pair", color: "Color", sequence: "Sequence", pure_sequence: "Pure sequence", trail: "Trail",
};

/** GameState.end_reason (table.rs): 0 last player, 1 show, 2 pot limit. */
export const END_REASON = ["last player standing", "show", "pot limit"];

/** Friendly text for a failed transaction (program errors by name). */
export function errorText(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/User rejected|rejected the request|declined/i.test(m)) return "You cancelled in your wallet.";
  if (/insufficient (funds|lamports)|InsufficientFunds|0x1\b/i.test(m)) return "Not enough SOL in your wallet for this.";
  const code = /"Custom":(\d+)/.exec(m)?.[1];
  const named = /Error Code: (\w+)/.exec(m)?.[1] ?? (code ? idl.errors.find((x) => x.code === Number(code))?.name : undefined);
  const known: Record<string, string> = {
    StaleAction: "The table moved on before your move landed. Try again.",
    NotYourTurn: "It isn't your turn.",
    WrongPhase: "Not possible in this phase of the hand.",
    SeatTaken: "That seat was just taken. Pick another.",
    BadAmount: "Buy-in must be between the table's minimum and maximum.",
    Paused: "New buy-ins are paused right now. Cash-outs still work.",
    NotLeft: "Your leave hasn't been synced to Solana yet. Try again in a moment.",
    GrantActive: "Wait until the current Side Show ends.",
    MustSee: "After 4 blind bets you must See your cards first.",
    InsufficientStack: "Your stack can't cover that bet.",
    CannotShow: "Show needs exactly two players, and a blind player can't Show a seen one.",
    CannotSideShow: "Side Show needs a seen player before you.",
    TableNotActive: "This table was closed and refunded.",
    NotConfigured: "This table isn't open for buy-ins.",
    NothingToClaim: "Nothing left to claim.",
  };
  if (named) return known[named] ?? `The program refused it (${named}).`;
  if (/fetch failed|Failed to fetch|NetworkError|timed out|not confirmed/i.test(m)) return "Network trouble reaching Solana. Try again.";
  return m.length > 160 ? `${m.slice(0, 160)}…` : m;
}
