// The keeper's brain (CF-051): from a table's runtime state, decide the one
// permissionless step that moves it forward. Pure, so every phase is tested
// without a chain. Players' own steps (salts, bets) are never taken for them;
// the keeper only uses the program's timeouts when players don't act.
import { PHASE, type TableRuntime } from "@card-flex/client-sdk";

/** Must match programs/card-flex/src/table.rs VRF_TIMEOUT_SLOTS. */
export const VRF_TIMEOUT_SLOTS = 3_000n;

export type Step =
  | { kind: "start_hand" }
  | { kind: "cancel_salts" }
  | { kind: "request_shuffle" }
  | { kind: "cancel_hand" }
  | { kind: "deal_hand"; order: number[] }
  | { kind: "grant_view"; a: number; b: number }
  | { kind: "timeout_turn"; order: number[]; seq: bigint }
  | { kind: "reveal_hand"; order: number[] }
  | { kind: "finish_hand"; order: number[] } // index, revoke views, commit, sync, next_hand
  | { kind: "revoke_views"; pairs: [number, number][] }
  | { kind: "commit_and_sync"; reason: "heartbeat" | "departed" }
  | { kind: "wait"; why: string };

export type Ctx = {
  nowSecs: bigint;
  slot: bigint;
  /** Unix seconds of the last commit the keeper saw land. */
  lastCommitSecs: bigint;
  /** Commit when idle at least this often (well under the table's refund timeout). */
  heartbeatSecs: bigint;
  /** Pause between hands so players see the result (at least the program's HAND_GAP_SECS = 3). */
  handGapSecs: bigint;
  /** Departed seats already synced (so cash-out is possible). */
  departedSynced: number;
};

const bits = (m: number) => [0, 1, 2, 3, 4, 5].filter((s) => (m >> s) & 1);
const dealt = (rt: TableRuntime) => rt.dealing_order.slice(0, rt.dealing_count);

/** Side Show pairs of this hand (from side_show_viewers). */
export function viewerPairs(rt: TableRuntime): [number, number][] {
  if (rt.side_show_hand_no !== rt.hand_no) return [];
  const out: [number, number][] = [];
  for (let a = 0; a < 6; a++) for (const b of bits(rt.side_show_viewers[a])) if (b > a) out.push([a, b]);
  return out;
}

export function decide(rt: TableRuntime, c: Ctx): Step {
  switch (rt.phase) {
    case PHASE.IDLE: {
      // Seats with a live grant must be revoked before a new hand (start_hand refuses).
      if (rt.grants !== 0) {
        const pairs: [number, number][] = [];
        for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if (((rt.grants >> a) & 1) && ((rt.grants >> b) & 1)) pairs.push([a, b]);
        return { kind: "revoke_views", pairs: pairs.length ? pairs : bits(rt.grants).map((s) => [s, (s + 1) % 6] as [number, number]) };
      }
      // Players who left must be able to cash out: get their final stack synced.
      if ((rt.departed & ~c.departedSynced) !== 0) return { kind: "commit_and_sync", reason: "departed" };
      const eligible = bits(rt.occupied).filter((s) => rt.stacks[s] >= rt.boot && rt.boot > 0n);
      if (rt.locked && eligible.length >= 2) {
        // The program refuses a start sooner than HAND_GAP_SECS after rt.last_hand_end.
        const gap = c.handGapSecs > 3n ? c.handGapSecs : 3n;
        if (c.nowSecs < rt.last_hand_end + gap) return { kind: "wait", why: "pause between hands" };
        return { kind: "start_hand" };
      }
      if (c.nowSecs >= c.lastCommitSecs + c.heartbeatSecs) return { kind: "commit_and_sync", reason: "heartbeat" };
      return { kind: "wait", why: eligible.length < 2 ? "fewer than 2 players with a stack" : "table not live" };
    }
    case PHASE.SALTS_PENDING:
      return c.nowSecs >= rt.salts_deadline ? { kind: "cancel_salts" } : { kind: "wait", why: "players submitting salts" };
    case PHASE.SALTS_DONE:
      return { kind: "request_shuffle" };
    case PHASE.VRF_PENDING:
      return c.slot >= rt.vrf_request_slot + VRF_TIMEOUT_SLOTS ? { kind: "cancel_hand" } : { kind: "wait", why: "VRF callback" };
    case PHASE.SEEDED:
      return { kind: "deal_hand", order: dealt(rt) };
    case PHASE.DEALT: {
      // An accepted Side Show: give the two players their view.
      const pending = viewerPairs(rt).find(([a, b]) => !(((rt.grants >> a) & 1) && ((rt.grants >> b) & 1)));
      if (pending) return { kind: "grant_view", a: pending[0], b: pending[1] };
      if (c.nowSecs >= rt.turn_deadline) return { kind: "timeout_turn", order: rt.game.order.slice(0, rt.game.n), seq: rt.action_seq };
      return { kind: "wait", why: "player to act" };
    }
    case PHASE.HAND_COMPLETE:
      return { kind: "reveal_hand", order: dealt(rt) };
    case PHASE.REVEALED:
      return { kind: "finish_hand", order: dealt(rt) };
    default:
      return { kind: "wait", why: `phase ${rt.phase}` };
  }
}
