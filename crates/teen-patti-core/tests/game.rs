//! Rules v1 betting state machine (docs/spec/teen-patti-rules-v1.md §3–5).

use card_types::{Card, Rank, Suit};
use teen_patti_core::game::*;
use teen_patti_core::{evaluate, HandRank};

/// Each seat holds a fixed hand.
struct Hands([HandRank; MAX_SEATS]);
impl HandOracle for Hands {
    fn rank(&self, seat: u8) -> HandRank {
        self.0[seat as usize]
    }
}

fn hand(ranks: [u8; 3], suits: [Suit; 3]) -> HandRank {
    let cards: [Card; 3] =
        core::array::from_fn(|i| Card::new(suits[i], Rank::new(ranks[i]).unwrap()));
    evaluate(cards)
}
fn high(r: [u8; 3]) -> HandRank {
    hand(r, [Suit::Clubs, Suit::Diamonds, Suit::Hearts])
}

const BOOT: u64 = 1_000;
fn rules() -> Rules {
    Rules::v1(BOOT, 0, 0)
}
fn stacks(v: u64) -> [u64; MAX_SEATS] {
    [v; MAX_SEATS]
}

/// Seat 0 weakest … seat 5 strongest.
fn ladder() -> Hands {
    Hands(core::array::from_fn(|i| high([9 + i as u8, 4, 2])))
}

#[test]
fn start_collects_boots_and_seat_left_of_button_acts_first() {
    let h = Hand::start(rules(), stacks(50_000), &[2, 3, 0]).unwrap();
    assert_eq!(h.pot, 3 * BOOT);
    assert_eq!(h.to_act(), 2);
    assert_eq!(h.seats[2].stack, 49_000);
    assert_eq!(h.seats[1].stack, 50_000, "seat not dealt keeps its stack");
    assert_eq!(h.stake, BOOT);
    assert!(
        Hand::start(rules(), stacks(500), &[0, 1]).is_err(),
        "stack below boot can't be dealt"
    );
    assert!(
        Hand::start(rules(), stacks(5_000), &[0]).is_err(),
        "needs two players"
    );
    assert!(
        Hand::start(rules(), stacks(5_000), &[0, 0]).is_err(),
        "no duplicate seats"
    );
}

#[test]
fn blind_and_seen_bet_amounts() {
    let o = ladder();
    let mut h = Hand::start(rules(), stacks(1_000_000), &[0, 1, 2]).unwrap();
    // Blind: 1x or 2x stake only.
    assert_eq!(
        h.apply(0, Action::Chaal { amount: 3 * BOOT }, &o),
        Err(RuleError::BadAmount)
    );
    h.apply(0, Action::Chaal { amount: 2 * BOOT }, &o).unwrap(); // stake -> 2,000
    assert_eq!(h.stake, 2 * BOOT);
    // Seen: 2x or 4x stake; seen bet sets stake to half of it.
    h.apply(1, Action::See, &o).unwrap();
    assert_eq!(
        h.apply(1, Action::Chaal { amount: 2 * BOOT }, &o),
        Err(RuleError::BadAmount)
    );
    h.apply(1, Action::Chaal { amount: 8 * BOOT }, &o).unwrap(); // 4x
    assert_eq!(h.stake, 4 * BOOT);
    assert_eq!(h.to_act(), 2);
    assert_eq!(h.min_bet(2), 4 * BOOT);
}

#[test]
fn errors_change_nothing() {
    let o = ladder();
    let mut h = Hand::start(rules(), stacks(100_000), &[0, 1, 2]).unwrap();
    let before = h;
    assert_eq!(
        h.apply(1, Action::Chaal { amount: BOOT }, &o),
        Err(RuleError::NotYourTurn)
    );
    assert_eq!(h.apply(0, Action::Show, &o), Err(RuleError::CannotShow));
    assert_eq!(
        h.apply(0, Action::SideShowRequest, &o),
        Err(RuleError::CannotSideShow)
    );
    assert_eq!(
        h.apply(0, Action::SideShowRespond { accept: true }, &o),
        Err(RuleError::NoSideShowPending)
    );
    assert_eq!(h.apply(4, Action::Pack, &o), Err(RuleError::NotActive));
    assert_eq!(h, before);
}

#[test]
fn last_player_wins_the_pot_minus_rake() {
    let o = ladder();
    let r = Rules::v1(BOOT, 500, 10_000); // 5% rake, capped
    let mut h = Hand::start(r, stacks(100_000), &[0, 1, 2]).unwrap();
    let total = h.table_total();
    h.apply(0, Action::Chaal { amount: BOOT }, &o).unwrap();
    h.apply(1, Action::Pack, &o).unwrap();
    let ev = h.apply(2, Action::Pack, &o).unwrap();
    let Event::HandOver(s) = ev else {
        panic!("{ev:?}")
    };
    assert_eq!((s.reason, s.winners), (EndReason::LastPlayer, 1 << 0));
    assert_eq!(s.rake, 4 * BOOT * 5 / 100);
    assert_eq!(s.payouts[0], 4 * BOOT - s.rake);
    assert_eq!(h.table_total() + s.rake, total, "lamports conserved");
    assert_eq!(
        h.apply(0, Action::Chaal { amount: BOOT }, &o),
        Err(RuleError::HandOver)
    );
}

#[test]
fn blind_turn_limit_forces_see() {
    let o = ladder();
    let mut h = Hand::start(rules(), stacks(1_000_000), &[0, 1]).unwrap();
    for _ in 0..4 {
        h.apply(0, Action::Chaal { amount: BOOT }, &o).unwrap();
        h.apply(1, Action::See, &o).ok();
        h.apply(1, Action::Chaal { amount: 2 * BOOT }, &o).unwrap();
    }
    assert_eq!(
        h.apply(0, Action::Chaal { amount: BOOT }, &o),
        Err(RuleError::MustSee)
    );
    h.apply(0, Action::See, &o).unwrap();
    h.apply(0, Action::Chaal { amount: 2 * BOOT }, &o).unwrap();
}

#[test]
fn show_with_two_players() {
    let o = ladder(); // seat 1 beats seat 0
    let mut h = Hand::start(rules(), stacks(100_000), &[0, 1]).unwrap();
    h.apply(0, Action::See, &o).unwrap();
    h.apply(0, Action::Chaal { amount: 2 * BOOT }, &o).unwrap();
    // Blind seat 1 can't force Show on seen seat 0.
    assert_eq!(h.apply(1, Action::Show, &o), Err(RuleError::CannotShow));
    h.apply(1, Action::See, &o).unwrap();
    let pot_before = h.pot;
    let Event::HandOver(s) = h.apply(1, Action::Show, &o).unwrap() else {
        panic!()
    };
    assert_eq!((s.reason, s.winners), (EndReason::Show, 1 << 1));
    assert_eq!(
        s.payouts[1],
        pot_before + 2 * BOOT,
        "Show costs the normal (seen) bet"
    );
}

#[test]
fn exact_tie_at_show_splits_with_odd_lamport_to_first_in_order() {
    let same = high([14, 9, 7]);
    let o = Hands([same; MAX_SEATS]);
    let r = Rules::v1(1_001, 0, 0);
    let mut h = Hand::start(r, stacks(100_000), &[3, 1]).unwrap();
    h.apply(3, Action::Chaal { amount: 1_001 }, &o).unwrap();
    let Event::HandOver(s) = h.apply(1, Action::Show, &o).unwrap() else {
        panic!()
    };
    let pot = 4 * 1_001; // 2 boots + 2 bets
    assert_eq!(s.winners, (1 << 3) | (1 << 1));
    assert_eq!(
        s.payouts[3],
        pot / 2 + pot % 2,
        "seat 3 is first in dealing order"
    );
    assert_eq!(s.payouts[1], pot / 2);
}

#[test]
fn side_show_accept_reject_tie_and_timeout() {
    let o = ladder(); // higher seat wins
                      // Accept: requester (seat 2) beats target (seat 1): target packs.
    let mut h = Hand::start(rules(), stacks(100_000), &[0, 1, 2]).unwrap();
    h.apply(0, Action::Chaal { amount: BOOT }, &o).unwrap();
    h.apply(1, Action::See, &o).unwrap();
    h.apply(1, Action::Chaal { amount: 2 * BOOT }, &o).unwrap();
    assert_eq!(
        h.apply(2, Action::SideShowRequest, &o),
        Err(RuleError::CannotSideShow),
        "requester must be seen"
    );
    h.apply(2, Action::See, &o).unwrap();
    h.apply(2, Action::SideShowRequest, &o).unwrap();
    assert_eq!(
        h.phase,
        Phase::SideShow {
            requester: 2,
            target: 1
        }
    );
    assert_eq!(
        h.apply(0, Action::Pack, &o),
        Err(RuleError::SideShowPending)
    );
    assert_eq!(
        h.apply(2, Action::SideShowRespond { accept: true }, &o),
        Err(RuleError::SideShowPending),
        "only the target responds"
    );
    assert_eq!(
        h.apply(1, Action::SideShowRespond { accept: true }, &o)
            .unwrap(),
        Event::SideShowResolved { packed: 1 }
    );
    assert!(!h.seats[1].active && h.to_act() == 0);

    // Reject (and Timeout counts as reject): nobody packs, turn moves on.
    let mut h = Hand::start(rules(), stacks(100_000), &[0, 1, 2]).unwrap();
    h.apply(0, Action::Chaal { amount: BOOT }, &o).unwrap();
    h.apply(1, Action::See, &o).unwrap();
    h.apply(1, Action::Chaal { amount: 2 * BOOT }, &o).unwrap();
    h.apply(2, Action::See, &o).unwrap();
    h.apply(2, Action::SideShowRequest, &o).unwrap();
    assert_eq!(h.apply(1, Action::Timeout, &o).unwrap(), Event::Continued);
    assert_eq!((h.active_count(), h.to_act()), (3, 0));

    // Tie: the requester packs.
    let same = Hands([high([14, 9, 7]); MAX_SEATS]);
    let mut h = Hand::start(rules(), stacks(100_000), &[0, 1, 2]).unwrap();
    h.apply(0, Action::Chaal { amount: BOOT }, &same).unwrap();
    h.apply(1, Action::See, &same).unwrap();
    h.apply(1, Action::Chaal { amount: 2 * BOOT }, &same)
        .unwrap();
    h.apply(2, Action::See, &same).unwrap();
    h.apply(2, Action::SideShowRequest, &same).unwrap();
    assert_eq!(
        h.apply(1, Action::SideShowRespond { accept: true }, &same)
            .unwrap(),
        Event::SideShowResolved { packed: 2 }
    );
}

#[test]
fn pot_limit_forces_showdown_of_all_active_players() {
    let o = ladder();
    let r = Rules {
        pot_limit_boots: 10,
        ..rules()
    };
    let mut h = Hand::start(r, stacks(1_000_000), &[0, 1, 2]).unwrap();
    let mut last = Event::Continued;
    for _ in 0..10 {
        let s = h.to_act();
        last = h
            .apply(
                s,
                Action::Chaal {
                    amount: 2 * h.stake,
                },
                &o,
            )
            .unwrap_or(Event::Continued);
        if matches!(last, Event::HandOver(_)) {
            break;
        }
    }
    let Event::HandOver(st) = last else {
        panic!("pot limit not reached")
    };
    assert_eq!((st.reason, st.winners), (EndReason::PotLimit, 1 << 2));
}

#[test]
fn stack_and_chaal_limits() {
    let o = ladder();
    let mut h = Hand::start(rules(), [2_500, 100_000, 0, 0, 0, 0], &[0, 1]).unwrap();
    // Seat 0 has 1,500 left: a 2,000 bet is refused (no all-in), it must pack.
    assert_eq!(
        h.apply(0, Action::Chaal { amount: 2 * BOOT }, &o),
        Err(RuleError::InsufficientStack)
    );
    let r = Rules {
        chaal_limit_boots: 2,
        ..rules()
    };
    let mut h = Hand::start(r, stacks(1_000_000), &[0, 1]).unwrap();
    h.apply(0, Action::See, &o).unwrap();
    assert_eq!(
        h.apply(0, Action::Chaal { amount: 4 * BOOT }, &o),
        Err(RuleError::BadAmount),
        "above chaal limit"
    );
}

#[test]
fn rake_is_capped() {
    let o = ladder();
    let mut h = Hand::start(Rules::v1(BOOT, 1_000, 150), stacks(100_000), &[0, 1]).unwrap();
    let Event::HandOver(s) = h.apply(0, Action::Pack, &o).unwrap() else {
        panic!()
    };
    assert_eq!(s.rake, 150, "10% of 2,000 = 200, capped at 150");
    assert_eq!(s.payouts[1], 2 * BOOT - 150);
}

/// Random play: lamports are conserved, every hand ends, errors change nothing.
#[test]
fn random_hands_conserve_lamports_and_terminate() {
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for _ in 0..20_000 {
        let n = 2 + (rnd() % 5) as usize;
        let order: Vec<u8> = (0..n as u8).collect();
        let ranks: [HandRank; MAX_SEATS] = core::array::from_fn(|_| {
            let r = 2 + (rnd() % 13) as u8;
            high([r.max(4), r.max(4) - 1, 2])
        });
        let o = Hands(ranks);
        let r = Rules::v1(100, (rnd() % 600) as u16, 1 + rnd() % 400);
        let st: [u64; MAX_SEATS] = core::array::from_fn(|_| 100 + rnd() % 50_000);
        let mut h = Hand::start(r, st, &order).unwrap();
        let total = h.table_total();
        let mut steps = 0;
        loop {
            steps += 1;
            assert!(steps < 5_000, "hand did not terminate");
            let seat = match h.phase {
                Phase::SideShow { target, .. } => target,
                _ => h.to_act(),
            };
            let action = match rnd() % 9 {
                0 => Action::Pack,
                1 => Action::See,
                2 => Action::Show,
                3 => Action::SideShowRequest,
                4 => Action::SideShowRespond {
                    accept: rnd() % 2 == 0,
                },
                5 => Action::Timeout,
                6 => Action::Chaal {
                    amount: h.min_bet(seat) * 2,
                },
                _ => Action::Chaal {
                    amount: h.min_bet(seat),
                },
            };
            let before = h;
            match h.apply(seat, action, &o) {
                Ok(Event::HandOver(s)) => {
                    assert_eq!(
                        h.table_total() + s.rake,
                        total,
                        "conservation at settlement"
                    );
                    assert!(s.winners != 0);
                    break;
                }
                Ok(_) => assert_eq!(h.table_total(), total, "conservation during the hand"),
                Err(_) => assert_eq!(h, before, "errors change nothing"),
            }
            // A stuck player (can't afford, can't see) is packed by timeout.
            if steps % 50 == 0 && h.phase == Phase::Betting {
                let s = h.to_act();
                if let Ok(Event::HandOver(st)) = h.apply(s, Action::Timeout, &o) {
                    assert_eq!(h.table_total() + st.rake, total);
                    break;
                }
            }
        }
    }
}

/// Encoding round-trips, and replaying the log rebuilds the same hand.
#[test]
fn action_log_round_trips_and_replays() {
    let mut x: u64 = 0xdead_beef_1234_5678;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for _ in 0..5_000 {
        let n = 2 + (rnd() % 5) as usize;
        let order: Vec<u8> = (0..n as u8).collect();
        let o = Hands(core::array::from_fn(|_| {
            let r = 4 + (rnd() % 11) as u8;
            high([r, r - 1, 2])
        }));
        let r = Rules::v1(100, (rnd() % 600) as u16, 1 + rnd() % 400);
        let st: [u64; MAX_SEATS] = core::array::from_fn(|_| 100 + rnd() % 50_000);
        let mut h = Hand::start(r, st, &order).unwrap();
        let mut log = Vec::new();
        while h.phase != Phase::Over {
            let seat = match h.phase {
                Phase::SideShow { target, .. } => target,
                _ => h.to_act(),
            };
            let action = match rnd() % 8 {
                0 => Action::Pack,
                1 => Action::See,
                2 => Action::Show,
                3 => Action::SideShowRequest,
                4 => Action::SideShowRespond {
                    accept: rnd() % 2 == 0,
                },
                5 => Action::Timeout,
                6 => Action::Chaal {
                    amount: h.min_bet(seat) * 2,
                },
                _ => Action::Chaal {
                    amount: h.min_bet(seat),
                },
            };
            let b = encode_action(seat, action, &h).unwrap();
            assert_eq!(decode_action(b, &h), Some((seat, action)));
            if h.apply(seat, action, &o).is_ok() {
                log.push(b);
            }
            if log.len() > 300 {
                let s = h.to_act();
                if h.phase == Phase::Betting {
                    log.push(encode_action(s, Action::Timeout, &h).unwrap());
                    h.apply(s, Action::Timeout, &o).unwrap();
                }
            }
        }
        assert!(log.len() <= MAX_ACTIONS);
        let replayed = replay(r, st, &order, &log, &o).unwrap();
        assert_eq!(replayed, h);
        // A truncated log is not a finished hand; a corrupted byte fails.
        assert!(replay(r, st, &order, &log[..log.len() - 1], &o).is_err());
    }
    let h = Hand::start(rules(), stacks(10_000), &[0, 1]).unwrap();
    assert_eq!(
        encode_action(0, Action::Chaal { amount: 3 * BOOT }, &h),
        None
    );
    assert_eq!(decode_action(0x80, &h), None);
    assert_eq!(decode_action(6 << 4, &h), None, "seat 6 doesn't exist");
    assert_eq!(decode_action(0b1110, &h), None, "code 7");
}
