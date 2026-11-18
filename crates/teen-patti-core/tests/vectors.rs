//! Frozen rules v1 test vectors (P4 exit: "rules vectors frozen").
//!
//! `docs/spec/vectors/teen-patti-rules-v1.json` is rendered from this file
//! and `scripts/check_rules_vectors.py` re-implements the rules from the spec
//! and must reproduce every value. Any change to ranking, betting or
//! settlement output fails this test. Only for an intentional rules change
//! (new `rules_version`), regenerate with:
//!
//!   CF_WRITE_VECTORS=1 cargo test -p teen-patti-core --test vectors

use card_types::{Card, Rank, Suit};
use teen_patti_core::game::*;
use teen_patti_core::{evaluate, HandRank};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

struct Ranks([HandRank; MAX_SEATS]);
impl HandOracle for Ranks {
    fn rank(&self, seat: u8) -> HandRank {
        self.0[seat as usize]
    }
}

fn card(rank: u8, suit: Suit) -> Card {
    Card::new(suit, Rank::new(rank).unwrap())
}

fn category_name(r: HandRank) -> &'static str {
    match r.key >> 24 {
        6 => "trail",
        5 => "pure_sequence",
        4 => "sequence",
        3 => "color",
        2 => "pair",
        _ => "high_card",
    }
}

fn ids(c: &[Card]) -> String {
    c.iter()
        .map(|c| c.id().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn list<T: ToString>(v: impl IntoIterator<Item = T>) -> String {
    v.into_iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn quoted(v: impl IntoIterator<Item = u64>) -> String {
    v.into_iter()
        .map(|x| format!("\"{x}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn error_name(e: Option<RuleError>) -> &'static str {
    match e {
        None => "BadEncoding",
        Some(RuleError::BadSetup) => "BadSetup",
        Some(RuleError::HandOver) => "HandOver",
        Some(RuleError::NotYourTurn) => "NotYourTurn",
        Some(RuleError::NotActive) => "NotActive",
        Some(RuleError::BadAmount) => "BadAmount",
        Some(RuleError::MustSee) => "MustSee",
        Some(RuleError::InsufficientStack) => "InsufficientStack",
        Some(RuleError::CannotShow) => "CannotShow",
        Some(RuleError::CannotSideShow) => "CannotSideShow",
        Some(RuleError::SideShowPending) => "SideShowPending",
        Some(RuleError::NoSideShowPending) => "NoSideShowPending",
    }
}

// ---------------------------------------------------------------- ranking

fn ranking_cases() -> Vec<(String, [Card; 3])> {
    use Suit::{Clubs as C, Diamonds as D, Hearts as H, Spades as S};
    let mut v: Vec<(String, [Card; 3])> = vec![
        ("trail AAA".into(), [card(14, C), card(14, D), card(14, H)]),
        ("trail 222".into(), [card(2, C), card(2, D), card(2, S)]),
        (
            "pure sequence A-K-Q".into(),
            [card(14, S), card(13, S), card(12, S)],
        ),
        (
            "pure sequence A-2-3".into(),
            [card(14, H), card(2, H), card(3, H)],
        ),
        (
            "pure sequence K-Q-J".into(),
            [card(13, D), card(12, D), card(11, D)],
        ),
        (
            "pure sequence 4-3-2".into(),
            [card(4, C), card(3, C), card(2, C)],
        ),
        (
            "sequence A-K-Q".into(),
            [card(14, S), card(13, H), card(12, D)],
        ),
        (
            "sequence A-2-3".into(),
            [card(3, S), card(14, H), card(2, D)],
        ),
        (
            "sequence K-Q-J".into(),
            [card(11, S), card(13, H), card(12, D)],
        ),
        (
            "sequence 4-3-2".into(),
            [card(2, S), card(4, H), card(3, D)],
        ),
        (
            "no wrap K-A-2".into(),
            [card(13, S), card(14, H), card(2, D)],
        ),
        (
            "no wrap Q-K-A-ish color".into(),
            [card(12, C), card(14, C), card(2, C)],
        ),
        (
            "color A-K-J".into(),
            [card(14, D), card(13, D), card(11, D)],
        ),
        ("color 5-3-2".into(), [card(5, H), card(3, H), card(2, H)]),
        ("pair A-A-K".into(), [card(14, S), card(14, D), card(13, C)]),
        ("pair A-A-2".into(), [card(14, H), card(2, D), card(14, C)]),
        ("pair 2-2-A".into(), [card(2, S), card(14, D), card(2, C)]),
        ("pair 2-2-3".into(), [card(2, H), card(3, D), card(2, D)]),
        ("high A-K-J".into(), [card(14, S), card(13, H), card(11, S)]),
        (
            "high A-K-J other suits".into(),
            [card(14, D), card(13, C), card(11, H)],
        ),
        ("high 5-3-2".into(), [card(5, S), card(3, H), card(2, D)]),
        ("high 7-5-4".into(), [card(7, S), card(5, H), card(4, D)]),
    ];
    let mut rng = Rng(0x5eed_0001_cafe_f00d);
    for i in 0..200 {
        let mut deck: Vec<u8> = (0..52).collect();
        let mut h = [0u8; 3];
        for slot in h.iter_mut() {
            let j = rng.below(deck.len() as u64) as usize;
            *slot = deck.swap_remove(j);
        }
        v.push((format!("random {i}"), h.map(|x| Card::from_id(x).unwrap())));
    }
    v
}

fn category_counts() -> [usize; 7] {
    let mut counts = [0usize; 7];
    for a in 0..52u8 {
        for b in a + 1..52 {
            for c in b + 1..52 {
                let h = [a, b, c].map(|i| Card::from_id(i).unwrap());
                counts[(evaluate(h).key >> 24) as usize] += 1;
            }
        }
    }
    counts
}

// ------------------------------------------------------------------ games

struct GameCase {
    name: String,
    rules: Rules,
    stacks: [u64; MAX_SEATS],
    order: Vec<u8>,
    hands: [[Card; 3]; MAX_SEATS],
    actions: Vec<u8>,
    /// Ok(final hand) or Err((index, error name)); index None = not finished.
    result: Result<Hand, (Option<usize>, &'static str)>,
}

fn deal(rng: &mut Rng, order: &[u8], ties: bool) -> [[Card; 3]; MAX_SEATS] {
    let mut hands = [[Card::from_id(0).unwrap(); 3]; MAX_SEATS];
    if ties {
        // Same ranks in different suits: exact ties (rules v1: no suit ranking).
        let ranks = [14u8, 9, 7];
        for (k, &s) in order.iter().enumerate() {
            let suits = [
                Suit::ALL[k % 4],
                Suit::ALL[(k + 1) % 4],
                Suit::ALL[(k + 2) % 4],
            ];
            hands[s as usize] = [
                card(ranks[0], suits[0]),
                card(ranks[1], suits[1]),
                card(ranks[2], suits[2]),
            ];
        }
        return hands;
    }
    let mut deck: Vec<u8> = (0..52).collect();
    for &s in order {
        for j in 0..3 {
            let i = rng.below(deck.len() as u64) as usize;
            hands[s as usize][j] = Card::from_id(deck.swap_remove(i)).unwrap();
        }
    }
    hands
}

fn oracle(hands: &[[Card; 3]; MAX_SEATS]) -> Ranks {
    Ranks(hands.map(evaluate))
}

fn play(rng: &mut Rng, h: &mut Hand, o: &Ranks, aggressive: bool) -> Vec<u8> {
    let mut log = Vec::new();
    for step in 0..600 {
        if h.phase == Phase::Over {
            break;
        }
        let seat = match h.phase {
            Phase::SideShow { target, .. } => target,
            _ => h.to_act(),
        };
        let action = if step > 400 {
            Action::Timeout
        } else if aggressive {
            match rng.below(10) {
                0 => Action::See,
                1 => Action::Chaal {
                    amount: h.min_bet(seat),
                },
                _ => Action::Chaal {
                    amount: 2 * h.min_bet(seat),
                },
            }
        } else {
            match rng.below(12) {
                0 => Action::Pack,
                1 | 2 => Action::See,
                3 => Action::Show,
                4 => Action::SideShowRequest,
                5 => Action::SideShowRespond {
                    accept: rng.below(2) == 0,
                },
                6 => Action::Timeout,
                7 | 8 => Action::Chaal {
                    amount: 2 * h.min_bet(seat),
                },
                _ => Action::Chaal {
                    amount: h.min_bet(seat),
                },
            }
        };
        let b = encode_action(seat, action, h).unwrap();
        if h.apply(seat, action, o).is_ok() {
            log.push(b);
        } else if aggressive {
            // A capped bet: fall back to the minimum, then to packing.
            for a in [
                Action::Chaal {
                    amount: h.min_bet(seat),
                },
                Action::See,
                Action::Pack,
            ] {
                let b = encode_action(seat, a, h).unwrap();
                if h.apply(seat, a, o).is_ok() {
                    log.push(b);
                    break;
                }
            }
        }
    }
    log
}

fn game_cases() -> Vec<GameCase> {
    let mut rng = Rng(0x7ee7_9a77_1000_0001);
    let mut out = Vec::new();
    let mut covered = std::collections::BTreeSet::new();
    for i in 0..60u64 {
        let n = 2 + (i % 5) as usize;
        let first = (i % 6) as u8;
        let order: Vec<u8> = (0..n as u8).map(|k| (first + k) % 6).collect();
        let boot = [100u64, 1_000, 25_000][(i % 3) as usize];
        let aggressive = i % 5 == 4;
        let ties = i % 7 == 3;
        let rules = Rules::v1(boot, rng.below(1_001) as u16, rng.below(50 * boot));
        let mut stacks = [0u64; MAX_SEATS];
        for &s in &order {
            stacks[s as usize] = if aggressive {
                boot * (1_500 + rng.below(500))
            } else {
                boot * (1 + rng.below(80))
            };
        }
        let hands = deal(&mut rng, &order, ties);
        let o = oracle(&hands);
        let mut h = Hand::start(rules, stacks, &order).unwrap();
        let actions = play(&mut rng, &mut h, &o, aggressive);
        let name = format!(
            "game {i}: {n} players{}{}",
            if aggressive { ", aggressive" } else { "" },
            if ties { ", tied hands" } else { "" }
        );
        out.push(GameCase {
            name,
            rules,
            stacks,
            order: order.clone(),
            hands,
            actions: actions.clone(),
            result: Ok(h),
        });

        // Invalid logs derived from this game: stop at a random point and
        // append a byte that the rules (or the encoding) refuse there. Every
        // byte is tried; an error kind not yet covered is preferred, so the
        // vectors pin each rule check, not just "not your turn".
        if i % 2 == 0 && actions.len() > 1 {
            let mut cut = 1 + rng.below(actions.len() as u64 - 1) as usize;
            if !covered.contains("SideShowPending") {
                // Prefer a point where a Side Show waits for its target.
                if let Some(k) = (1..actions.len()).find(|&k| {
                    matches!(
                        replay_prefix(rules, stacks, &order, &actions[..k], &o).phase,
                        Phase::SideShow { .. }
                    )
                }) {
                    cut = k;
                }
            }
            let prefix = &actions[..cut];
            let at = replay_prefix(rules, stacks, &order, prefix, &o);
            let mut by_kind: Vec<(&'static str, u8)> = Vec::new();
            for b in 0..=255u8 {
                let kind = match decode_action(b, &at) {
                    None => Some("BadEncoding"),
                    Some((seat, a)) => at
                        .clone()
                        .apply(seat, a, &o)
                        .err()
                        .map(|e| error_name(Some(e))),
                };
                if let Some(k) = kind {
                    if !by_kind.iter().any(|(x, _)| *x == k) {
                        by_kind.push((k, b));
                    }
                }
            }
            let fresh: Vec<&(&str, u8)> = by_kind
                .iter()
                .filter(|(k, _)| !covered.contains(k))
                .collect();
            let pending = fresh.iter().find(|(k, _)| *k == "SideShowPending").copied();
            let &(kind, b) = if let Some(p) = pending {
                p
            } else if fresh.is_empty() {
                &by_kind[rng.below(by_kind.len() as u64) as usize]
            } else {
                fresh[rng.below(fresh.len() as u64) as usize]
            };
            covered.insert(kind);
            let mut log = prefix.to_vec();
            log.push(b);
            out.push(GameCase {
                name: format!("game {i}: illegal action at {cut} ({kind})"),
                rules,
                stacks,
                order: order.clone(),
                hands,
                actions: log,
                result: Err((Some(cut), kind)),
            });
            out.push(GameCase {
                name: format!("game {i}: log stops after {cut} actions"),
                rules,
                stacks,
                order: order.clone(),
                hands,
                actions: prefix.to_vec(),
                result: Err((None, "NotOver")),
            });
        }
        // A log that goes on after the hand ended.
        if i % 10 == 1 {
            let mut log = actions.clone();
            log.push(encode_action(order[0], Action::Pack, &h).unwrap());
            out.push(GameCase {
                name: format!("game {i}: action after the hand ended"),
                rules,
                stacks,
                order: order.clone(),
                hands,
                actions: log,
                result: Err((Some(actions.len()), "HandOver")),
            });
        }
    }
    // Scripted cases that pin specific rules by name.
    let script = |name: &str,
                  rules: Rules,
                  hands: [[Card; 3]; MAX_SEATS],
                  steps: &[(u8, Action)],
                  bad: Option<(u8, Action)>| {
        let order: Vec<u8> = (0..3).collect();
        let mut stacks = [0u64; MAX_SEATS];
        stacks[..3].copy_from_slice(&[100 * rules.boot; 3]);
        let o = oracle(&hands);
        let mut h = Hand::start(rules, stacks, &order).unwrap();
        let mut log = Vec::new();
        for &(seat, a) in steps {
            log.push(encode_action(seat, a, &h).unwrap());
            h.apply(seat, a, &o)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
        }
        let result = match bad {
            Some((seat, a)) => {
                let e = h.clone().apply(seat, a, &o).unwrap_err();
                let at = log.len();
                log.push(encode_action(seat, a, &h).unwrap());
                Err((Some(at), error_name(Some(e))))
            }
            None if h.phase == Phase::Over => Ok(h),
            None => Err((None, "NotOver")),
        };
        GameCase {
            name: name.into(),
            rules,
            stacks,
            order,
            hands,
            actions: log,
            result,
        }
    };
    let opening: [(u8, Action); 5] = [
        (0, Action::Chaal { amount: 1_000 }),
        (1, Action::See),
        (1, Action::Chaal { amount: 2_000 }),
        (2, Action::See),
        (2, Action::SideShowRequest),
    ];
    let mixed = deal(&mut rng, &[0, 1, 2], false);
    let tied = deal(&mut rng, &[0, 1, 2], true);
    out.push(script(
        "script: only the Side Show target may act",
        Rules::v1(1_000, 0, 0),
        mixed,
        &opening,
        Some((0, Action::Pack)),
    ));
    let mut steps = opening.to_vec();
    steps.push((1, Action::SideShowRespond { accept: true }));
    steps.push((0, Action::Pack));
    out.push(script(
        "script: tied Side Show, the requester packs",
        Rules::v1(1_000, 0, 0),
        tied,
        &steps,
        None,
    ));
    let mut steps = opening.to_vec();
    steps.push((1, Action::SideShowRespond { accept: false }));
    steps.push((0, Action::Pack));
    steps.push((1, Action::Show));
    out.push(script(
        "script: rejected Side Show, then a tied Show splits (odd lamport first)",
        Rules::v1(1_001, 1, 100),
        tied,
        &steps
            .iter()
            .map(|&(s, a)| match a {
                Action::Chaal { amount } => (
                    s,
                    Action::Chaal {
                        amount: amount / 1_000 * 1_001,
                    },
                ),
                x => (s, x),
            })
            .collect::<Vec<_>>(),
        None,
    ));

    // A setup the rules refuse: a dealt seat below the boot.
    let order = vec![0u8, 1];
    let mut stacks = [0u64; MAX_SEATS];
    stacks[0] = 1_000;
    stacks[1] = 999;
    let hands = deal(&mut rng, &order, false);
    out.push(GameCase {
        name: "setup: seat 1 below the boot".into(),
        rules: Rules::v1(1_000, 0, 0),
        stacks,
        order,
        hands,
        actions: vec![],
        result: Err((None, "BadSetup")),
    });
    out
}

fn replay_prefix(
    rules: Rules,
    stacks: [u64; MAX_SEATS],
    order: &[u8],
    log: &[u8],
    o: &Ranks,
) -> Hand {
    let mut h = Hand::start(rules, stacks, order).unwrap();
    for &b in log {
        let (s, a) = decode_action(b, &h).unwrap();
        h.apply(s, a, o).unwrap();
    }
    h
}

/// Checks each case against `replay` (the function the verifier uses).
fn check_case(c: &GameCase) {
    let o = oracle(&c.hands);
    let got = replay(c.rules, c.stacks, &c.order, &c.actions, &o);
    match (&c.result, got) {
        (Ok(want), Ok(h)) => assert_eq!(&h, want, "{}", c.name),
        (Err((idx, name)), Err(e)) => {
            assert_eq!(e.index, *idx, "{}", c.name);
            let got_name = match (e.index, e.error) {
                (None, None) => "NotOver",
                (_, err) => error_name(err),
            };
            assert_eq!(got_name, *name, "{}", c.name);
        }
        (want, got) => panic!(
            "{}: expected {:?}, got {got:?}",
            c.name,
            want.as_ref().err()
        ),
    }
}

// ------------------------------------------------------------------ render

fn render() -> String {
    let mut out = String::new();
    out.push_str("{\n  \"rules\": \"teen-patti\",\n  \"rules_version\": 1,\n");
    out.push_str("  \"note\": \"Generated by crates/teen-patti-core/tests/vectors.rs; checked independently by scripts/check_rules_vectors.py. Card id = suit * 13 + (rank - 2), suits clubs, diamonds, hearts, spades; rank 14 = ace. Spec: docs/spec/teen-patti-rules-v1.md.\",\n");
    let counts = category_counts();
    out.push_str(&format!(
        "  \"category_counts\": {{\"high_card\": {}, \"pair\": {}, \"color\": {}, \"sequence\": {}, \"pure_sequence\": {}, \"trail\": {}}},\n",
        counts[1], counts[2], counts[3], counts[4], counts[5], counts[6]
    ));
    out.push_str("  \"ranking\": [\n");
    let rc = ranking_cases();
    for (i, (name, cards)) in rc.iter().enumerate() {
        let r = evaluate(*cards);
        out.push_str(&format!(
            "    {{\"name\": \"{name}\", \"cards\": [{}], \"category\": \"{}\", \"key\": {}}}{}\n",
            ids(cards),
            category_name(r),
            r.key,
            if i + 1 < rc.len() { "," } else { "" }
        ));
    }
    out.push_str("  ],\n  \"games\": [\n");
    let gc = game_cases();
    for (i, c) in gc.iter().enumerate() {
        check_case(c);
        let hands = c
            .order
            .iter()
            .map(|&s| format!("[{}]", ids(&c.hands[s as usize])))
            .collect::<Vec<_>>()
            .join(", ");
        let expect = match &c.result {
            Ok(h) => {
                let st = h.settlement.unwrap();
                let winners: Vec<u8> = c
                    .order
                    .iter()
                    .copied()
                    .filter(|s| st.winners & (1 << s) != 0)
                    .collect();
                format!(
                    "{{\"end_reason\": \"{}\", \"winners\": [{}], \"payouts\": [{}], \"rake\": \"{}\", \"final_stacks\": [{}]}}",
                    ["last_player", "show", "pot_limit"][st.reason as usize],
                    list(winners),
                    quoted(c.order.iter().map(|&s| st.payouts[s as usize])),
                    st.rake,
                    quoted(c.order.iter().map(|&s| h.seats[s as usize].stack)),
                )
            }
            Err((idx, name)) => format!(
                "{{\"error\": \"{name}\", \"error_index\": {}}}",
                idx.map(|x| x.to_string()).unwrap_or_else(|| "null".into())
            ),
        };
        out.push_str(&format!(
            "    {{\"name\": \"{}\", \"boot\": \"{}\", \"rake_bps\": {}, \"rake_cap\": \"{}\", \"order\": [{}], \"stacks\": [{}], \"hands\": [{hands}], \"actions\": \"{}\", \"expect\": {expect}}}{}\n",
            c.name,
            c.rules.boot,
            c.rules.rake_bps,
            c.rules.rake_cap,
            list(c.order.iter().copied()),
            quoted(c.order.iter().map(|&s| c.stacks[s as usize])),
            hex(&c.actions),
            if i + 1 < gc.len() { "," } else { "" }
        ));
    }
    out.push_str("  ]\n}\n");
    out
}

#[test]
fn rules_vectors_are_frozen() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/spec/vectors/teen-patti-rules-v1.json"
    );
    let rendered = render();
    if std::env::var("CF_WRITE_VECTORS").as_deref() == Ok("1") {
        std::fs::write(path, &rendered).unwrap();
        return;
    }
    let committed =
        std::fs::read_to_string(path).expect("vectors file missing; run with CF_WRITE_VECTORS=1");
    assert!(
        committed == rendered,
        "Teen Patti rules v1 output changed. If intentional, bump rules_version and regenerate."
    );
}

/// The vectors must exercise every ending and the main error kinds, or they
/// would freeze too little.
#[test]
fn vectors_cover_every_ending_and_error() {
    let gc = game_cases();
    let mut endings = [0usize; 3];
    let mut errors = std::collections::BTreeSet::new();
    let mut split = 0;
    for c in &gc {
        match &c.result {
            Ok(h) => {
                let st = h.settlement.unwrap();
                endings[st.reason as usize] += 1;
                if st.winners.count_ones() > 1 {
                    split += 1;
                }
            }
            Err((_, name)) => {
                errors.insert(*name);
            }
        }
    }
    assert!(
        endings.iter().all(|&e| e > 0),
        "endings (last player, show, pot limit) = {endings:?}"
    );
    assert!(split > 0, "a split pot");
    for e in [
        "NotOver",
        "BadSetup",
        "HandOver",
        "NotYourTurn",
        "NotActive",
        "BadAmount",
        "MustSee",
        "InsufficientStack",
        "CannotShow",
        "CannotSideShow",
        "SideShowPending",
        "NoSideShowPending",
        "BadEncoding",
    ] {
        assert!(errors.contains(e), "missing error {e}: {errors:?}");
    }
    eprintln!("endings {endings:?}, split pots {split}, errors {errors:?}");
}
