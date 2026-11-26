// A sit-down this browser has left but that may not be paid yet. Leaving is
// instant for the player (leave_seat in the PER), but the money follows a few
// steps later: the keeper commits the table, syncs the final stack to the
// seat ledger on Solana and pays it from the vault (cash_out). The record lets
// the Boards page follow that and show the result, and keeps the table page
// from treating the old seat as "joining" while the base layer still shows it.
// No secrets: addresses, seat, amounts. localStorage, so it survives the tab.
export type PendingExit = {
  config: string;
  wallet: string;
  /** Table name for the popup. */
  name: string;
  seat: number;
  /** SeatLedger.epoch of the sit-down that was left. */
  epoch: number;
  /** Lamports as strings (JSON has no bigint). buy-in + top-ups. */
  deposited: string;
  /** The live stack (plus held top-ups) when leaving: what should come back. */
  stack: string;
  /** Unix ms when leave_seat landed. */
  at: number;
  /** CF-084: "session" = the table's free-commit session ended and seated everyone out. */
  reason?: "left" | "session";
};

const KEY = "cf:exits";

function all(): PendingExit[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(v: PendingExit[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
    window.dispatchEvent(new Event("cf:exits"));
  } catch { /* storage blocked: the table page still shows the cash-out state */ }
}

export function saveExit(e: PendingExit) {
  write([...all().filter((x) => !(x.config === e.config && x.wallet === e.wallet)), e]);
}

export function exitsFor(wallet: string | null): PendingExit[] {
  return wallet ? all().filter((x) => x.wallet === wallet) : [];
}

export function exitFor(config: string, wallet: string): PendingExit | null {
  return all().find((x) => x.config === config && x.wallet === wallet) ?? null;
}

export function dropExit(config: string, wallet: string) {
  write(all().filter((x) => !(x.config === config && x.wallet === wallet)));
}
