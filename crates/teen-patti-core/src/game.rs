//! Betting state machine and settlement, rules v1
//! (docs/spec/teen-patti-rules-v1.md §3–5).
//!
//! Deterministic and allocation-free. Hand comparisons go through
//! [`HandOracle`], so the program (reading private seat hands) and the
//! verifier (rebuilding the deck) run the same rules.

use crate::rank::HandRank;

pub const MAX_SEATS: usize = 6;

/// Table parameters for one hand. All amounts in lamports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub boot: u64,
    /// Largest single bet, in boots (v1: 128).
    pub chaal_limit_boots: u64,
    /// Pot size that forces a showdown, in boots (v1: 1,024).
    pub pot_limit_boots: u64,
    /// Blind bets allowed before a player must See (v1: 4).
    pub max_blind_turns: u8,
    /// Rake on the won pot, basis points, capped at `rake_cap`.
    pub rake_bps: u16,
    pub rake_cap: u64,
}

impl Rules {
    pub const fn v1(boot: u64, rake_bps: u16, rake_cap: u64) -> Rules {
        Rules {
            boot,
            chaal_limit_boots: 128,
            pot_limit_boots: 1_024,
            max_blind_turns: 4,
            rake_bps,
            rake_cap,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Seat {
    /// Dealt into this hand.
    pub dealt: bool,
    /// Dealt and not packed.
    pub active: bool,
    pub seen: bool,
    pub blind_turns: u8,
    pub stack: u64,
    /// Put into the pot this hand (boot included).
    pub contributed: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Betting,
    /// `requester` asked `target` for a Side Show; `target` must respond.
    SideShow {
        requester: u8,
        target: u8,
    },
    Over,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndReason {
    LastPlayer,
    Show,
    PotLimit,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub reason: EndReason,
    /// Bit i set = seat i won (several = split pot).
    pub winners: u8,
    /// Credited to each seat's stack from the pot.
    pub payouts: [u64; MAX_SEATS],
    pub rake: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Look at one's cards (blind → seen). Any time, doesn't use the turn.
    See,
    /// Bet `amount`: blind 1× or 2× stake; seen 2× or 4× stake.
    Chaal {
        amount: u64,
    },
    Pack,
    /// Only with two players left; costs the normal bet.
    Show,
    /// Seen player asks the previous active seen player to compare.
    SideShowRequest,
    SideShowRespond {
        accept: bool,
    },
    /// Turn deadline passed: packs the player to act (or rejects a pending
    /// Side Show for its target).
    Timeout,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Continued,
    /// A Side Show was accepted and resolved; `packed` lost and packed.
    SideShowResolved {
        packed: u8,
    },
    HandOver(Settlement),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleError {
    BadSetup,
    HandOver,
    NotYourTurn,
    NotActive,
    BadAmount,
    /// Blind turns used up: the player must See before betting again.
    MustSee,
    /// Stack can't cover the bet (no all-in in v1: the player must pack).
    InsufficientStack,
    CannotShow,
    CannotSideShow,
    SideShowPending,
    NoSideShowPending,
}

/// Ranks the hand dealt to a seat.
pub trait HandOracle {
    fn rank(&self, seat: u8) -> HandRank;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hand {
    pub rules: Rules,
    pub seats: [Seat; MAX_SEATS],
    /// Seat indices in dealing order; the turn moves in this order.
    pub order: [u8; MAX_SEATS],
    pub n: u8,
    /// Index into `order` of the seat to act.
    pub turn: u8,
    /// Current stake in blind terms: a blind player pays 1× or 2×, a seen
    /// player 2× or 4×.
    pub stake: u64,
    pub pot: u64,
    pub phase: Phase,
    pub settlement: Option<Settlement>,
}

impl Hand {
    /// Starts a hand: collects the boot from every seat in `order` (dealing
    /// order, first to act first). `stacks` is indexed by seat.
    pub fn start(rules: Rules, stacks: [u64; MAX_SEATS], order: &[u8]) -> Result<Hand, RuleError> {
        if order.len() < 2 || order.len() > MAX_SEATS || rules.boot == 0 {
            return Err(RuleError::BadSetup);
        }
        let mut seats = [Seat::default(); MAX_SEATS];
        let mut ord = [0u8; MAX_SEATS];
        let mut pot = 0u64;
        for (k, &s) in order.iter().enumerate() {
            let i = s as usize;
            if i >= MAX_SEATS || seats[i].dealt || stacks[i] < rules.boot {
                return Err(RuleError::BadSetup);
            }
            seats[i] = Seat {
                dealt: true,
                active: true,
                seen: false,
                blind_turns: 0,
                stack: stacks[i] - rules.boot,
                contributed: rules.boot,
            };
            pot += rules.boot;
            ord[k] = s;
        }
        for (i, seat) in seats.iter_mut().enumerate() {
            if !seat.dealt {
                seat.stack = stacks[i];
            }
        }
        Ok(Hand {
            rules,
            seats,
            order: ord,
            n: order.len() as u8,
            turn: 0,
            stake: rules.boot,
            pot,
            phase: Phase::Betting,
            settlement: None,
        })
    }

    pub fn to_act(&self) -> u8 {
        self.order[self.turn as usize]
    }

    pub fn active_count(&self) -> usize {
        self.order[..self.n as usize]
            .iter()
            .filter(|&&s| self.seats[s as usize].active)
            .count()
    }

    /// Lowest legal bet for `seat` now.
    pub fn min_bet(&self, seat: u8) -> u64 {
        if self.seats[seat as usize].seen {
            2 * self.stake
        } else {
            self.stake
        }
    }

    fn index_of(&self, seat: u8) -> usize {
        self.order[..self.n as usize]
            .iter()
            .position(|&s| s == seat)
            .unwrap_or(usize::MAX)
    }

    fn next_active_after(&self, idx: usize) -> usize {
        let n = self.n as usize;
        (1..=n)
            .map(|d| (idx + d) % n)
            .find(|&j| self.seats[self.order[j] as usize].active)
            .unwrap_or(idx)
    }

    fn prev_active_before(&self, idx: usize) -> usize {
        let n = self.n as usize;
        (1..n)
            .map(|d| (idx + n - d) % n)
            .find(|&j| self.seats[self.order[j] as usize].active)
            .unwrap_or(idx)
    }

    fn pay(&mut self, seat: u8, amount: u64) -> Result<(), RuleError> {
        if amount > self.rules.chaal_limit_boots.saturating_mul(self.rules.boot) {
            return Err(RuleError::BadAmount);
        }
        let s = &mut self.seats[seat as usize];
        if amount > s.stack {
            return Err(RuleError::InsufficientStack);
        }
        s.stack -= amount;
        s.contributed += amount;
        self.pot += amount;
        Ok(())
    }

    fn settle(&mut self, reason: EndReason, winners: u8) -> Event {
        let raw = (self.pot as u128 * self.rules.rake_bps as u128 / 10_000) as u64;
        let rake = raw.min(self.rules.rake_cap).min(self.pot);
        let dist = self.pot - rake;
        let k = winners.count_ones() as u64;
        let mut payouts = [0u64; MAX_SEATS];
        let (share, mut rem) = (dist / k, dist % k);
        // Odd lamports go to the first winner in dealing order (first seat
        // clockwise from the button).
        for &s in &self.order[..self.n as usize] {
            if winners & (1 << s) != 0 {
                payouts[s as usize] = share + rem;
                rem = 0;
            }
        }
        for (i, p) in payouts.iter().enumerate() {
            self.seats[i].stack += p;
        }
        self.pot = 0;
        let st = Settlement {
            reason,
            winners,
            payouts,
            rake,
        };
        self.settlement = Some(st);
        self.phase = Phase::Over;
        Event::HandOver(st)
    }

    /// Winners among active seats with the best rank.
    fn best_of(&self, oracle: &impl HandOracle, seats: &[u8]) -> u8 {
        let best = seats
            .iter()
            .map(|&s| oracle.rank(s))
            .max()
            .expect("non-empty");
        seats
            .iter()
            .filter(|&&s| oracle.rank(s) == best)
            .fold(0u8, |m, &s| m | (1 << s))
    }

    fn after_bet(&mut self, oracle: &impl HandOracle, idx: usize) -> Event {
        if self.pot >= self.rules.pot_limit_boots.saturating_mul(self.rules.boot) {
            let active: [u8; MAX_SEATS] = self.order;
            let list: heapless::Seats = active[..self.n as usize]
                .iter()
                .copied()
                .filter(|&s| self.seats[s as usize].active)
                .collect();
            let w = self.best_of(oracle, list.as_slice());
            return self.settle(EndReason::PotLimit, w);
        }
        self.turn = self.next_active_after(idx) as u8;
        Event::Continued
    }

    /// Applies one action by `seat`. On error nothing changes.
    pub fn apply(
        &mut self,
        seat: u8,
        action: Action,
        oracle: &impl HandOracle,
    ) -> Result<Event, RuleError> {
        if self.phase == Phase::Over {
            return Err(RuleError::HandOver);
        }
        if (seat as usize) >= MAX_SEATS || !self.seats[seat as usize].active {
            return Err(RuleError::NotActive);
        }
        if action == Action::See {
            let s = &mut self.seats[seat as usize];
            if s.seen {
                return Err(RuleError::BadAmount);
            }
            s.seen = true;
            return Ok(Event::Continued);
        }
        if let Phase::SideShow { requester, target } = self.phase {
            let accept = match action {
                Action::SideShowRespond { accept } if seat == target => accept,
                Action::Timeout if seat == target => false,
                _ => return Err(RuleError::SideShowPending),
            };
            self.phase = Phase::Betting;
            let req_idx = self.index_of(requester);
            if !accept {
                self.turn = self.next_active_after(req_idx) as u8;
                return Ok(Event::Continued);
            }
            // Lower hand packs; on a tie the requester packs.
            let packed = if oracle.rank(requester) > oracle.rank(target) {
                target
            } else {
                requester
            };
            self.seats[packed as usize].active = false;
            self.turn = self.next_active_after(req_idx) as u8;
            return Ok(Event::SideShowResolved { packed });
        }
        if matches!(action, Action::SideShowRespond { .. }) {
            return Err(RuleError::NoSideShowPending);
        }
        let idx = self.turn as usize;
        if self.to_act() != seat {
            return Err(RuleError::NotYourTurn);
        }
        match action {
            Action::Chaal { amount } => {
                let s = self.seats[seat as usize];
                let new_stake = if s.seen {
                    if amount != 2 * self.stake && amount != 4 * self.stake {
                        return Err(RuleError::BadAmount);
                    }
                    amount / 2
                } else {
                    if s.blind_turns >= self.rules.max_blind_turns {
                        return Err(RuleError::MustSee);
                    }
                    if amount != self.stake && amount != 2 * self.stake {
                        return Err(RuleError::BadAmount);
                    }
                    amount
                };
                self.pay(seat, amount)?;
                if !s.seen {
                    self.seats[seat as usize].blind_turns += 1;
                }
                self.stake = new_stake;
                Ok(self.after_bet(oracle, idx))
            }
            Action::Pack | Action::Timeout => {
                self.seats[seat as usize].active = false;
                if self.active_count() == 1 {
                    let last = self.order[..self.n as usize]
                        .iter()
                        .copied()
                        .find(|&s| self.seats[s as usize].active)
                        .unwrap();
                    return Ok(self.settle(EndReason::LastPlayer, 1 << last));
                }
                self.turn = self.next_active_after(idx) as u8;
                Ok(Event::Continued)
            }
            Action::Show => {
                if self.active_count() != 2 {
                    return Err(RuleError::CannotShow);
                }
                let opp = self.order[self.next_active_after(idx)];
                let me = self.seats[seat as usize];
                if !me.seen && self.seats[opp as usize].seen {
                    return Err(RuleError::CannotShow);
                }
                self.pay(seat, self.min_bet(seat))?;
                let w = self.best_of(oracle, &[seat, opp]);
                Ok(self.settle(EndReason::Show, w))
            }
            Action::SideShowRequest => {
                if !self.seats[seat as usize].seen || self.active_count() < 3 {
                    return Err(RuleError::CannotSideShow);
                }
                let target = self.order[self.prev_active_before(idx)];
                if !self.seats[target as usize].seen {
                    return Err(RuleError::CannotSideShow);
                }
                self.pay(seat, 2 * self.stake)?;
                self.phase = Phase::SideShow {
                    requester: seat,
                    target,
                };
                Ok(Event::Continued)
            }
            Action::See | Action::SideShowRespond { .. } => unreachable!(),
        }
    }

    /// Total lamports on the table: stacks plus pot (constant during a hand).
    pub fn table_total(&self) -> u64 {
        self.seats.iter().map(|s| s.stack).sum::<u64>() + self.pot
    }
}

/// Tiny fixed-capacity list so the crate stays allocation-free.
mod heapless {
    use super::MAX_SEATS;
    pub struct Seats {
        items: [u8; MAX_SEATS],
        len: usize,
    }
    impl Seats {
        pub fn as_slice(&self) -> &[u8] {
            &self.items[..self.len]
        }
    }
    impl FromIterator<u8> for Seats {
        fn from_iter<I: IntoIterator<Item = u8>>(iter: I) -> Self {
            let mut s = Seats {
                items: [0; MAX_SEATS],
                len: 0,
            };
            for x in iter {
                s.items[s.len] = x;
                s.len += 1;
            }
            s
        }
    }
}

/// Upper bound on logged actions in one hand. Every bet, Show and Side Show
/// request adds at least one boot to the pot and the pot limit ends the hand
/// at 1,024 boots, so there are at most ~1,022 of them, ≤ 511 Side Show
/// responses, and ≤ 12 Sees and Packs/Timeouts. 1,600 leaves margin.
pub const MAX_ACTIONS: usize = 1_600;

/// One-byte action encoding for the public hand log (rules v1 §7):
/// `seat << 4 | code << 1 | flag`. Codes: 0 See, 1 Chaal, 2 Pack, 3 Show,
/// 4 Side Show request, 5 Side Show response, 6 Timeout. `flag` is 1 for a
/// Chaal of twice the minimum bet, or for an accepted Side Show. Encode
/// against the state *before* the action is applied.
pub fn encode_action(seat: u8, action: Action, h: &Hand) -> Option<u8> {
    if seat as usize >= MAX_SEATS {
        return None;
    }
    let (code, flag) = match action {
        Action::See => (0, 0),
        Action::Chaal { amount } if amount == h.min_bet(seat) => (1, 0),
        Action::Chaal { amount } if amount == 2 * h.min_bet(seat) => (1, 1),
        Action::Chaal { .. } => return None,
        Action::Pack => (2, 0),
        Action::Show => (3, 0),
        Action::SideShowRequest => (4, 0),
        Action::SideShowRespond { accept } => (5, accept as u8),
        Action::Timeout => (6, 0),
    };
    Some(seat << 4 | code << 1 | flag)
}

/// Inverse of [`encode_action`], against the state before the action.
pub fn decode_action(b: u8, h: &Hand) -> Option<(u8, Action)> {
    let (seat, code, flag) = (b >> 4, (b >> 1) & 7, b & 1);
    if seat as usize >= MAX_SEATS || b & 0x80 != 0 {
        return None;
    }
    let action = match (code, flag) {
        (0, 0) => Action::See,
        (1, f) => Action::Chaal {
            amount: h.min_bet(seat) << f,
        },
        (2, 0) => Action::Pack,
        (3, 0) => Action::Show,
        (4, 0) => Action::SideShowRequest,
        (5, f) => Action::SideShowRespond { accept: f == 1 },
        (6, 0) => Action::Timeout,
        _ => return None,
    };
    Some((seat, action))
}

/// Replays a logged hand from its starting stacks (seat-indexed), dealing
/// order and actions. Every action must be legal and the hand must end.
pub fn replay(
    rules: Rules,
    stacks: [u64; MAX_SEATS],
    order: &[u8],
    actions: &[u8],
    oracle: &impl HandOracle,
) -> Result<Hand, ReplayError> {
    let mut h = Hand::start(rules, stacks, order).map_err(|e| ReplayError {
        index: None,
        error: Some(e),
    })?;
    for (i, &b) in actions.iter().enumerate() {
        let (seat, action) = decode_action(b, &h).ok_or(ReplayError {
            index: Some(i),
            error: None,
        })?;
        h.apply(seat, action, oracle).map_err(|e| ReplayError {
            index: Some(i),
            error: Some(e),
        })?;
    }
    if h.phase != Phase::Over {
        return Err(ReplayError {
            index: None,
            error: None,
        });
    }
    Ok(h)
}

/// Why a replay failed: which action (`None` = setup or "hand not over"),
/// and the rule error (`None` = undecodable byte or unfinished hand).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplayError {
    pub index: Option<usize>,
    pub error: Option<RuleError>,
}
