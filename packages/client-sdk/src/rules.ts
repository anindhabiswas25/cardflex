// Teen Patti rules v1 in TypeScript (docs/spec/teen-patti-rules-v1.md §2–8).
// The program is the authority; this copy lets a client show only legal
// actions and replay a public action log. It must match the frozen vectors
// (test/rules.test.ts replays docs/spec/vectors/teen-patti-rules-v1.json).

import type { GameState } from "./accounts.ts";

export const MAX_SEATS = 6;
export type EndReason = "last_player" | "show" | "pot_limit";
export type RuleError =
  | "BadSetup" | "HandOver" | "NotYourTurn" | "NotActive" | "BadAmount" | "MustSee" | "InsufficientStack"
  | "CannotShow" | "CannotSideShow" | "SideShowPending" | "NoSideShowPending" | "BadEncoding" | "NotOver";
export class RulesError extends Error {
  readonly code: RuleError;
  readonly index?: number;
  constructor(code: RuleError, index?: number) {
    super(index === undefined ? code : `${code} at action ${index}`);
    this.code = code;
    this.index = index;
  }
}

export type Action =
  | { kind: "see" }
  | { kind: "chaal"; amount: bigint }
  | { kind: "pack" }
  | { kind: "show" }
  | { kind: "sideShow" }
  | { kind: "respond"; accept: boolean }
  | { kind: "timeout" };

export type Rules = { boot: bigint; rakeBps: number; rakeCap: bigint; chaalLimitBoots?: bigint; potLimitBoots?: bigint; maxBlindTurns?: number };
type Seat = { dealt: boolean; active: boolean; seen: boolean; blindTurns: number; stack: bigint; contributed: bigint };
export type Settlement = { reason: EndReason; winners: number[]; payouts: bigint[]; rake: bigint };

// ---- ranking (§2, §8 comparison key) ----
export const rankOf = (id: number) => (id % 13) + 2;
export const suitOf = (id: number) => Math.floor(id / 13);
export function handKey(cards: number[]): number {
  const r = cards.map(rankOf).sort((a, b) => b - a);
  const same = new Set(cards.map(suitOf)).size === 1;
  if (r[0] === r[1] && r[1] === r[2]) return ((6 << 24) | (r[0] << 16)) >>> 0;
  const strength = r[0] === 14 && r[1] === 13 && r[2] === 12 ? 15 : r[0] === 14 && r[1] === 3 && r[2] === 2 ? 14 : r[0] === r[1] + 1 && r[1] === r[2] + 1 ? r[0] : 0;
  if (strength) return (((same ? 5 : 4) << 24) | (strength << 16)) >>> 0;
  if (same) return ((3 << 24) | (r[0] << 16) | (r[1] << 8) | r[2]) >>> 0;
  if (r[0] === r[1]) return ((2 << 24) | (r[0] << 16) | (r[2] << 8)) >>> 0;
  if (r[1] === r[2]) return ((2 << 24) | (r[1] << 16) | (r[0] << 8)) >>> 0;
  return ((1 << 24) | (r[0] << 16) | (r[1] << 8) | r[2]) >>> 0;
}
export const CATEGORIES = ["", "high_card", "pair", "color", "sequence", "pure_sequence", "trail"] as const;
export const categoryOf = (cards: number[]) => CATEGORIES[handKey(cards) >>> 24];

/** Engine for one hand. Seat-indexed; `keys` = hand comparison keys (unknown opponents may be 0 for legality checks). */
export class Hand {
  boot: bigint; rakeBps: number; rakeCap: bigint; chaalLimit: bigint; potLimit: bigint; maxBlind: number;
  seats: Seat[]; order: number[]; turn = 0; stake: bigint; pot: bigint;
  pending: { requester: number; target: number } | null = null;
  over: Settlement | null = null;
  keys: number[];

  constructor(rules: Rules, stacks: bigint[], order: number[], keys: number[] = []) {
    const n = order.length;
    if (n < 2 || n > MAX_SEATS || new Set(order).size !== n || rules.boot === 0n) throw new RulesError("BadSetup");
    if (order.some((s) => s >= MAX_SEATS || stacks[s] < rules.boot)) throw new RulesError("BadSetup");
    this.boot = rules.boot; this.rakeBps = rules.rakeBps; this.rakeCap = rules.rakeCap;
    this.chaalLimit = (rules.chaalLimitBoots ?? 128n) * rules.boot;
    this.potLimit = (rules.potLimitBoots ?? 1_024n) * rules.boot;
    this.maxBlind = rules.maxBlindTurns ?? 4;
    this.seats = Array.from({ length: MAX_SEATS }, (_, i) => ({ dealt: false, active: false, seen: false, blindTurns: 0, stack: stacks[i] ?? 0n, contributed: 0n }));
    for (const s of order) Object.assign(this.seats[s], { dealt: true, active: true, stack: stacks[s] - rules.boot, contributed: rules.boot });
    this.order = [...order];
    this.stake = rules.boot;
    this.pot = rules.boot * BigInt(n);
    this.keys = Array.from({ length: MAX_SEATS }, (_, i) => keys[i] ?? 0);
  }

  /** The on-chain GameState as an engine (opponents' ranks unknown). */
  static fromGameState(g: GameState, keys: number[] = []): Hand {
    const h = Object.create(Hand.prototype) as Hand;
    h.boot = g.boot; h.rakeBps = g.rake_bps; h.rakeCap = g.rake_cap;
    h.chaalLimit = g.chaal_limit_boots * g.boot; h.potLimit = g.pot_limit_boots * g.boot; h.maxBlind = g.max_blind_turns;
    h.seats = g.seats.map((s) => ({ dealt: s.dealt, active: s.active, seen: s.seen, blindTurns: s.blind_turns, stack: s.stack, contributed: s.contributed }));
    h.order = g.order.slice(0, g.n); h.turn = g.turn; h.stake = g.stake; h.pot = g.pot;
    h.pending = g.phase === 1 ? { requester: g.ss_requester, target: g.ss_target } : null;
    h.over = g.phase === 2 ? { reason: (["last_player", "show", "pot_limit"] as const)[g.end_reason], winners: h.order.filter((s) => (g.winners >> s) & 1), payouts: h.order.map((s) => g.payouts[s]), rake: g.rake } : null;
    h.keys = Array.from({ length: MAX_SEATS }, (_, i) => keys[i] ?? 0);
    return h;
  }

  clone(): Hand {
    const h = Object.create(Hand.prototype) as Hand;
    Object.assign(h, this, { seats: this.seats.map((s) => ({ ...s })), order: [...this.order], keys: [...this.keys], pending: this.pending && { ...this.pending }, over: this.over });
    return h;
  }

  toAct(): number { return this.pending ? this.pending.target : this.order[this.turn]; }
  activeCount(): number { return this.order.filter((s) => this.seats[s].active).length; }
  minBet(s: number): bigint { return this.seats[s].seen ? 2n * this.stake : this.stake; }

  private nextActiveAfter(i: number) {
    const n = this.order.length;
    for (let d = 1; d <= n; d++) if (this.seats[this.order[(i + d) % n]].active) return (i + d) % n;
    return i;
  }
  private prevActiveBefore(i: number) {
    const n = this.order.length;
    for (let d = 1; d < n; d++) if (this.seats[this.order[(i - d + n) % n]].active) return (i - d + n) % n;
    return i;
  }
  private pay(s: number, x: bigint) {
    if (x > this.chaalLimit) throw new RulesError("BadAmount");
    if (x > this.seats[s].stack) throw new RulesError("InsufficientStack");
    this.seats[s].stack -= x; this.seats[s].contributed += x; this.pot += x;
  }
  private best(seats: number[]) {
    const top = Math.max(...seats.map((s) => this.keys[s]));
    return seats.filter((s) => this.keys[s] === top);
  }
  private settle(reason: EndReason, winners: number[]) {
    const raw = (this.pot * BigInt(this.rakeBps)) / 10_000n;
    let rake = raw < this.rakeCap ? raw : this.rakeCap;
    if (rake > this.pot) rake = this.pot;
    const dist = this.pot - rake, k = BigInt(winners.length);
    const share = dist / k;
    let rem = dist % k;
    const payouts = Array<bigint>(MAX_SEATS).fill(0n);
    for (const s of this.order) if (winners.includes(s)) { payouts[s] = share + rem; rem = 0n; }
    payouts.forEach((p, i) => (this.seats[i].stack += p));
    this.pot = 0n;
    this.over = { reason, winners: this.order.filter((s) => winners.includes(s)), payouts: this.order.map((s) => payouts[s]), rake };
  }

  /** Applies one action (§8 check order). Throws RulesError; on error nothing changes. */
  apply(s: number, a: Action): void {
    const next = this.clone();
    next.applyInPlace(s, a);
    Object.assign(this, next);
  }

  private applyInPlace(s: number, a: Action): void {
    if (this.over) throw new RulesError("HandOver");
    if (s >= MAX_SEATS || !this.seats[s].active) throw new RulesError("NotActive");
    const st = this.seats[s];
    if (a.kind === "see") {
      if (st.seen) throw new RulesError("BadAmount");
      st.seen = true;
      return;
    }
    if (this.pending) {
      const { requester, target } = this.pending;
      let accept: boolean;
      if (s === target && a.kind === "respond") accept = a.accept;
      else if (s === target && a.kind === "timeout") accept = false;
      else throw new RulesError("SideShowPending");
      this.pending = null;
      const ri = this.order.indexOf(requester);
      if (accept) this.seats[this.keys[requester] > this.keys[target] ? target : requester].active = false;
      this.turn = this.nextActiveAfter(ri);
      return;
    }
    if (a.kind === "respond") throw new RulesError("NoSideShowPending");
    const idx = this.turn;
    if (this.order[idx] !== s) throw new RulesError("NotYourTurn");
    switch (a.kind) {
      case "chaal": {
        let ns: bigint;
        if (st.seen) {
          if (a.amount !== 2n * this.stake && a.amount !== 4n * this.stake) throw new RulesError("BadAmount");
          ns = a.amount / 2n;
        } else {
          if (st.blindTurns >= this.maxBlind) throw new RulesError("MustSee");
          if (a.amount !== this.stake && a.amount !== 2n * this.stake) throw new RulesError("BadAmount");
          ns = a.amount;
        }
        this.pay(s, a.amount);
        if (!st.seen) st.blindTurns++;
        this.stake = ns;
        if (this.pot >= this.potLimit) this.settle("pot_limit", this.best(this.order.filter((p) => this.seats[p].active)));
        else this.turn = this.nextActiveAfter(idx);
        return;
      }
      case "pack":
      case "timeout": {
        st.active = false;
        if (this.activeCount() === 1) this.settle("last_player", this.order.filter((p) => this.seats[p].active));
        else this.turn = this.nextActiveAfter(idx);
        return;
      }
      case "show": {
        if (this.activeCount() !== 2) throw new RulesError("CannotShow");
        const opp = this.order[this.nextActiveAfter(idx)];
        if (!st.seen && this.seats[opp].seen) throw new RulesError("CannotShow");
        this.pay(s, this.minBet(s));
        this.settle("show", this.best([s, opp]));
        return;
      }
      case "sideShow": {
        if (!st.seen || this.activeCount() < 3) throw new RulesError("CannotSideShow");
        const target = this.order[this.prevActiveBefore(idx)];
        if (!this.seats[target].seen) throw new RulesError("CannotSideShow");
        this.pay(s, 2n * this.stake);
        this.pending = { requester: s, target };
        return;
      }
    }
  }
}

/** What `seat` may do now, with exact amounts (for enabling buttons). */
export function legalActions(h: Hand, seat: number) {
  const ok = (a: Action) => { try { h.clone().apply(seat, a); return true; } catch { return false; } };
  const m = h.minBet(seat);
  return {
    see: ok({ kind: "see" }),
    chaal: ok({ kind: "chaal", amount: m }) ? m : null,
    chaalDouble: ok({ kind: "chaal", amount: 2n * m }) ? 2n * m : null,
    pack: ok({ kind: "pack" }),
    show: ok({ kind: "show" }),
    sideShow: ok({ kind: "sideShow" }),
    respond: ok({ kind: "respond", accept: true }),
  };
}

// ---- action log encoding (§7) ----
export function encodeAction(seat: number, a: Action, h: Hand): number {
  const m = h.minBet(seat);
  const [code, flag] =
    a.kind === "see" ? [0, 0] : a.kind === "chaal" ? (a.amount === m ? [1, 0] : a.amount === 2n * m ? [1, 1] : [-1, 0])
      : a.kind === "pack" ? [2, 0] : a.kind === "show" ? [3, 0] : a.kind === "sideShow" ? [4, 0]
        : a.kind === "respond" ? [5, a.accept ? 1 : 0] : [6, 0];
  if (code < 0 || seat >= MAX_SEATS) throw new RulesError("BadEncoding");
  return (seat << 4) | (code << 1) | flag;
}

export function decodeAction(b: number, h: Hand): [number, Action] {
  const seat = b >> 4, code = (b >> 1) & 7, flag = b & 1;
  if (b & 0x80 || seat >= MAX_SEATS) throw new RulesError("BadEncoding");
  if (code === 1) {
    const base = h.seats[seat].seen ? 2n * h.stake : h.stake;
    return [seat, { kind: "chaal", amount: flag ? 2n * base : base }];
  }
  if (code === 5) return [seat, { kind: "respond", accept: flag === 1 }];
  const plain: Record<number, Action> = { 0: { kind: "see" }, 2: { kind: "pack" }, 3: { kind: "show" }, 4: { kind: "sideShow" }, 6: { kind: "timeout" } };
  if (flag === 0 && plain[code]) return [seat, plain[code]];
  throw new RulesError("BadEncoding");
}

/** Replays a logged hand; throws RulesError (with the failing index) or returns the settled hand. */
export function replay(rules: Rules, stacks: bigint[], order: number[], actions: Uint8Array, keys: number[]): Hand {
  const h = new Hand(rules, stacks, order, keys);
  actions.forEach((b, i) => {
    let d: [number, Action];
    try { d = decodeAction(b, h); } catch { throw new RulesError("BadEncoding", i); }
    try { h.apply(d[0], d[1]); } catch (e) { throw new RulesError((e as RulesError).code, i); }
  });
  if (!h.over) throw new RulesError("NotOver");
  return h;
}
