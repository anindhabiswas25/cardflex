// The keeper's brain (CF-051): from a table's runtime state, decide the one
// permissionless step that moves it forward. Pure, so every phase is tested
// without a chain. Players' own steps (salts, bets) are never taken for them;
// the keeper only uses the program's timeouts when players don't act.
import { LEAVE_WINDOW_SECS, PHASE, SALT_SECS, SESSION_HAND_COMMITS, sessionCommits, type TableRuntime } from "@card-flex/client-sdk";

/** Must match programs/card-flex/src/table.rs VRF_TIMEOUT_SLOTS. */
export const VRF_TIMEOUT_SLOTS = 3_000n;

export type Step =
  | { kind: "start_hand" }
  | { kind: "join_waiting"; seats: number[] } // seat players who bought in mid-hand
  | { kind: "apply_top_ups"; seats: number[] } // CF-076: deposited top-ups into the stacks
  | { kind: "cancel_salts" }
  | { kind: "request_shuffle" }
  | { kind: "cancel_hand" }
  | { kind: "abort_lost_hand"; order: number[] } // CF-053: secret state lost, hand can't finish
  | { kind: "deal_hand"; order: number[] }
  | { kind: "grant_view"; a: number; b: number }
  | { kind: "timeout_turn"; order: number[]; seq: bigint }
  | { kind: "reveal_hand"; order: number[] }
  | { kind: "finish_hand"; order: number[] } // index, revoke views, commit, sync, next_hand
  | { kind: "revoke_views"; pairs: [number, number][] }
  | { kind: "commit_and_sync"; reason: "heartbeat" | "departed" }
  | { kind: "end_session" } // CF-084: the session's free hand commits are used: everyone leaves
  | { kind: "recycle" } // CF-084: close + reopen: a new session with fresh free commits
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
  /**
   * CF-053: the hand in progress hasn't changed for longer than any normal
   * wait (salt round, turn, VRF timeout). Its secret accounts may be lost;
   * they are private, so only the program can tell: try `abort_lost_hand`
   * (it fails harmlessly with NotLost if everything still exists).
   */
  stuck?: boolean;
  /**
   * Seats that bought in (base-layer TableConfig) but aren't seated in the
   * runtime yet; the keeper seats them between hands, before start_hand, so
   * a player who arrived mid-hand plays the very next hand.
   */
  waitingSeats?: number[];
  /**
   * CF-073: `TableConfig.seated` (seats holding a ledger: bought in, seated,
   * or left and not yet paid). 0 = nobody's money is at the table, so the
   * idle heartbeat is skipped: after MagicBlock's free commits each commit
   * costs the runtime 0.002 SOL. Unknown (undefined) = heartbeat as before.
   */
  ledgers?: number;
  /**
   * CF-076: seated seats whose ledger shows deposits (`buy_in`) not yet in
   * the stack (`credited`); applied between hands, before start_hand.
   */
  topUpSeats?: number[];
  /**
   * CF-084: this keeper holds the table's authority key (CARDFLEX_OPERATOR_KEY)
   * and so may close and reopen it between sessions.
   */
  canRecycle?: boolean;
  /** CF-084: a recycle this keeper started didn't finish (resume it first). */
  recycling?: boolean;
};

/**
 * CF-084 (ADR 0007): no keeper heartbeat in a session's last commits, so the
 * session's end (one commit with every leave, then the close) always fits in
 * the free budget. The refund timeout (1,800 s) is far longer than a hand.
 */
export const HEARTBEAT_STOP = SESSION_HAND_COMMITS - 2;

const IN_PROGRESS: number[] = [PHASE.SALTS_PENDING, PHASE.SALTS_DONE, PHASE.VRF_PENDING, PHASE.SEEDED, PHASE.DEALT, PHASE.HAND_COMPLETE];
export const inProgress = (rt: TableRuntime) => IN_PROGRESS.includes(rt.phase);

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
  if (c.recycling) return { kind: "recycle" };
  if (c.stuck && inProgress(rt)) return { kind: "abort_lost_hand", order: dealt(rt) };
  const step = phaseStep(rt, c);
  // CF-056: heartbeat during hands too. A hand can outlast the refund
  // timeout (pot limit 1,024 boots at up to 25 s per turn); without a sync
  // the table would become refundable mid-hand and anyone could void the
  // hand. A mid-hand sync refreshes the clock but copies no stacks.
  if (step.kind === "wait" && inProgress(rt) && sessionCommits(rt) < HEARTBEAT_STOP && c.nowSecs >= c.lastCommitSecs + c.heartbeatSecs) {
    return { kind: "commit_and_sync", reason: "heartbeat" };
  }
  return step;
}

function phaseStep(rt: TableRuntime, c: Ctx): Step {
  switch (rt.phase) {
    case PHASE.IDLE: {
      // Seats with a live grant must be revoked before a new hand (start_hand refuses).
      if (rt.grants !== 0) {
        const pairs: [number, number][] = [];
        for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) if (((rt.grants >> a) & 1) && ((rt.grants >> b) & 1)) pairs.push([a, b]);
        return { kind: "revoke_views", pairs: pairs.length ? pairs : bits(rt.grants).map((s) => [s, (s + 1) % 6] as [number, number]) };
      }
      // CF-084 (ADR 0007): the session's free hand commits are used. Everyone
      // leaves (one commit carries all the leaves, then they're paid), then
      // the table closes and reopens with a fresh budget. Players who bought
      // in meanwhile are seated in the new session.
      if (sessionCommits(rt) >= SESSION_HAND_COMMITS) {
        if (rt.occupied !== 0) return { kind: "end_session" };
        if ((rt.departed & ~c.departedSynced) !== 0) return { kind: "commit_and_sync", reason: "departed" };
        return c.canRecycle ? { kind: "recycle" } : { kind: "wait", why: "session over: the table needs `cf-admin table recycle` (no operator key)" };
      }
      // Someone bought in during the last hand: seat them before the next one.
      if (c.waitingSeats?.length) return { kind: "join_waiting", seats: c.waitingSeats };
      // CF-076: chips a player added go in before the next deal.
      if (c.topUpSeats?.length) return { kind: "apply_top_ups", seats: c.topUpSeats };
      // Players who left must be able to cash out: get their final stack synced.
      if ((rt.departed & ~c.departedSynced) !== 0) return { kind: "commit_and_sync", reason: "departed" };
      const eligible = bits(rt.occupied).filter((s) => rt.stacks[s] >= rt.boot && rt.boot > 0n);
      if (rt.locked && eligible.length >= 2) {
        // The program refuses a start sooner than HAND_GAP_SECS after rt.last_hand_end.
        const gap = c.handGapSecs > 3n ? c.handGapSecs : 3n;
        if (c.nowSecs < rt.last_hand_end + gap) return { kind: "wait", why: "pause between hands" };
        return { kind: "start_hand" };
      }
      // CF-073: no heartbeat for an empty table. Safe: the program refuses
      // emergency_refund without a ledger and restarts the refund clock at
      // the first buy-in.
      const empty = c.ledgers === 0 && rt.occupied === 0;
      if (!empty && sessionCommits(rt) < HEARTBEAT_STOP && c.nowSecs >= c.lastCommitSecs + c.heartbeatSecs) return { kind: "commit_and_sync", reason: "heartbeat" };
      if (empty) return { kind: "wait", why: "empty table (no heartbeat needed)" };
      return { kind: "wait", why: eligible.length < 2 ? "fewer than 2 players with a stack" : "table not live" };
    }
    case PHASE.SALTS_PENDING:
    {
      // CF-077: a round waiting only on players who asked to leave ends at once.
      const missing = dealt(rt).filter((x) => ((rt.salts_in >> x) & 1) === 0);
      const onlyLeavers = missing.length > 0 && missing.every((x) => ((rt.leaving >> x) & 1) === 1);
      return c.nowSecs >= rt.salts_deadline || onlyLeavers ? { kind: "cancel_salts" } : { kind: "wait", why: "players submitting salts" };
    }
    case PHASE.SALTS_DONE:
      return { kind: "request_shuffle" };
    case PHASE.VRF_PENDING:
      return c.slot >= rt.vrf_request_slot + VRF_TIMEOUT_SLOTS ? { kind: "cancel_hand" } : { kind: "wait", why: "VRF callback" };
    case PHASE.SEEDED: {
      // CF-079: a leaver ends the hand at once (deal_hand cancels, no boot);
      // otherwise players get LEAVE_WINDOW_SECS from the start to leave for
      // free (+1 s for clock differences with the PER).
      const leaver = dealt(rt).some((x) => ((rt.leaving >> x) & 1) === 1);
      const dealAt = rt.salts_deadline - BigInt(SALT_SECS) + BigInt(LEAVE_WINDOW_SECS) + 1n;
      return leaver || c.nowSecs >= dealAt ? { kind: "deal_hand", order: dealt(rt) } : { kind: "wait", why: "players may still leave for free" };
    }
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
