//! CF-020/021: betting in the program. Real hands are dealt with `deal_hand`
//! in LiteSVM, then played with `act`. After every action the on-chain state
//! must equal the host `teen-patti-core` engine fed the same actions
//! (differential test), and misuse must fail without changing anything.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::instruction::{AccountMeta, Instruction},
        AccountDeserialize, AccountSerialize, InstructionData, Space, ToAccountMetas,
    },
    card_flex::table::*,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    teen_patti_core::game::{self, Action, HandOracle},
    teen_patti_core::HandRank,
};

const BOOT: u64 = 1_000;

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<u64, String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|m| m.compute_units_consumed)
        .map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs))
}

fn program_account(data: Vec<u8>) -> Account {
    Account {
        lamports: 10_000_000,
        data,
        owner: card_flex::id(),
        executable: false,
        rent_epoch: 0,
    }
}

struct Table {
    svm: LiteSVM,
    payer: Keypair,
    runtime: Pubkey,
    hand_log: Pubkey,
    hands: Vec<Pubkey>,
    sessions: Vec<Keypair>,
    wallets: Vec<Keypair>,
}

/// `HandLog` as `create_table` leaves it.
pub fn empty_hand_log(runtime: Pubkey, config: Pubkey, bump: u8) -> Vec<u8> {
    let log = HandLog {
        runtime,
        config,
        hand_no: 0,
        rules_version: 0,
        protocol_version: 0,
        dealing_count: 0,
        seats: [0; MAX_SEATS],
        wallets: [Pubkey::default(); MAX_SEATS],
        salts: [[0; 32]; MAX_SEATS],
        salt_commitments: [[0; 32]; MAX_SEATS],
        hand_ctx: [0; 32],
        roster_hash: [0; 32],
        vrf_caller_seed: [0; 32],
        vrf_output: [0; 32],
        merkle_root: [0; 32],
        revealed: false,
        boot: 0,
        rake_bps: 0,
        rake_cap: 0,
        start_stacks: [0; MAX_SEATS],
        end_reason: 0,
        winners: 0,
        payouts: [0; MAX_SEATS],
        rake: 0,
        bump,
    };
    let mut d = Vec::new();
    log.try_serialize(&mut d).unwrap();
    d.resize(HAND_LOG_LEN, 0);
    d
}

/// A table with `seats` seats dealt by the real `deal_hand`, ready to bet.
fn dealt_table(seats: u8, stacks: [u64; MAX_SEATS], seed: [u8; 32], rake: (u16, u64)) -> Table {
    let mut svm = LiteSVM::new();
    svm.add_program(
        card_flex::id(),
        include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/card_flex.so"
        )),
    )
    .unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let config = Pubkey::new_unique();
    let (runtime, bump) =
        Pubkey::find_program_address(&[RUNTIME_SEED, config.as_ref()], &card_flex::id());
    let (dealer, _) =
        Pubkey::find_program_address(&[DEALER_SEED, runtime.as_ref()], &card_flex::id());
    let sessions: Vec<Keypair> = (0..seats).map(|_| Keypair::new()).collect();
    let wallets: Vec<Keypair> = (0..seats).map(|_| Keypair::new()).collect();
    let mut session_keys = [Pubkey::default(); MAX_SEATS];
    let mut wallet_keys = [Pubkey::default(); MAX_SEATS];
    let mut order = [0u8; MAX_SEATS];
    for s in 0..seats as usize {
        session_keys[s] = sessions[s].pubkey();
        wallet_keys[s] = wallets[s].pubkey();
        order[s] = s as u8;
    }
    let rt = TableRuntime {
        config,
        authority: Pubkey::new_unique(),
        max_seats: 6,
        occupied: (1u8 << seats) - 1,
        wallets: wallet_keys,
        session_keys,
        hand_no: 3,
        dealt: false,
        locked: true,
        grants: 0,
        phase: phase::SEEDED,
        hand_ctx: [0x3c; 32],
        roster_hash: [0; 32],
        salts_in: (1u8 << seats) - 1,
        dealing_order: order,
        dealing_count: seats,
        salt_commitments: [[0; 32]; MAX_SEATS],
        vrf_caller_seed: [0; 32],
        merkle_root: [0; 32],
        vrf_request_slot: 0,
        cancelled_hands: 0,
        stacks,
        commit_seq: 0,
        boot: BOOT,
        rake_bps: rake.0,
        rake_cap: rake.1,
        rake_owed: 0,
        action_seq: 0,
        game: Default::default(),
        side_show_viewers: [0; MAX_SEATS],
        side_show_hand_no: 0,
        turn_deadline: 0,
        button: 5,
        bump,
    };
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(8 + TableRuntime::INIT_SPACE, 0);
    svm.set_account(runtime, program_account(data)).unwrap();

    let mut d = vec![0u8; DEALER_LEN as usize];
    d[..8].copy_from_slice(DEALER_TAG);
    d[8..40].copy_from_slice(runtime.as_ref());
    d[40..48].copy_from_slice(&3u64.to_le_bytes());
    d[DEALER_SEED_OFFSET..DEALER_SEED_OFFSET + 32].copy_from_slice(&seed);
    svm.set_account(dealer, program_account(d)).unwrap();
    let (hand_log, log_bump) =
        Pubkey::find_program_address(&[HAND_LOG_SEED, runtime.as_ref()], &card_flex::id());
    svm.set_account(
        hand_log,
        program_account(empty_hand_log(runtime, config, log_bump)),
    )
    .unwrap();

    let hands: Vec<Pubkey> = (0..seats)
        .map(|s| {
            let (h, _) = Pubkey::find_program_address(
                &[SEAT_HAND_SEED, runtime.as_ref(), &[s]],
                &card_flex::id(),
            );
            let mut data = vec![0u8; SEAT_HAND_LEN as usize];
            data[..8].copy_from_slice(SEAT_HAND_TAG);
            data[8..40].copy_from_slice(runtime.as_ref());
            data[40] = s;
            svm.set_account(h, program_account(data)).unwrap();
            h
        })
        .collect();
    let mut metas = card_flex::accounts::DealHand {
        payer: payer.pubkey(),
        runtime,
        dealer,
    }
    .to_account_metas(None);
    metas.extend(hands.iter().map(|h| AccountMeta::new(*h, false)));
    let deal = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::DealHand {}.data(),
        metas,
    );
    let cu = Instruction::new_with_bytes(
        "ComputeBudget111111111111111111111111111111"
            .parse()
            .unwrap(),
        &[&[2u8][..], &1_400_000u32.to_le_bytes()].concat(),
        vec![],
    );
    send(&mut svm, &[cu, deal], &[&payer]).expect("deal");
    Table {
        svm,
        payer,
        runtime,
        hand_log,
        hands,
        sessions,
        wallets,
    }
}

impl Table {
    fn runtime(&self) -> TableRuntime {
        TableRuntime::try_deserialize(
            &mut self.svm.get_account(&self.runtime).unwrap().data.as_slice(),
        )
        .unwrap()
    }

    /// Ranks of the dealt hands, read the way only a test can (in PER these
    /// accounts are private).
    fn oracle(&self) -> Ranks {
        let mut ranks = [HandRank { key: 0 }; MAX_SEATS];
        for (s, h) in self.hands.iter().enumerate() {
            let d = self.svm.get_account(h).unwrap().data;
            let cards = [0, 1, 2].map(|j| card_types::Card::from_id(d[HAND_CARDS + j]).unwrap());
            ranks[s] = teen_patti_core::evaluate(cards);
        }
        Ranks(ranks)
    }

    fn act_ix(
        &self,
        signer: &Pubkey,
        action: u8,
        amount: u64,
        seq: u64,
        hands: &[Pubkey],
    ) -> Instruction {
        let mut metas = card_flex::accounts::Act {
            session: *signer,
            runtime: self.runtime,
            hand_log: self.hand_log,
        }
        .to_account_metas(None);
        metas.extend(hands.iter().map(|h| AccountMeta::new_readonly(*h, false)));
        Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::Act {
                action,
                amount,
                expected_seq: seq,
            }
            .data(),
            metas,
        )
    }

    fn act(&mut self, seat: u8, action: Action) -> Result<u64, String> {
        let (code, amount) = encode(action);
        let seq = self.runtime().action_seq;
        let ix = self.act_ix(
            &self.sessions[seat as usize].pubkey(),
            code,
            amount,
            seq,
            &self.hands.clone(),
        );
        let payer = self.payer.insecure_clone();
        let session = self.sessions[seat as usize].insecure_clone();
        send(&mut self.svm, &[ix], &[&payer, &session])
    }
}

struct Ranks([HandRank; MAX_SEATS]);
impl HandOracle for Ranks {
    fn rank(&self, seat: u8) -> HandRank {
        self.0[seat as usize]
    }
}

fn encode(a: Action) -> (u8, u64) {
    match a {
        Action::See => (0, 0),
        Action::Chaal { amount } => (1, amount),
        Action::Pack => (2, 0),
        Action::Show => (3, 0),
        Action::SideShowRequest => (4, 0),
        Action::SideShowRespond { accept } => (5, accept as u64),
        Action::Timeout => panic!("timeout is not a player action"),
    }
}

/// Random play: the program and the host engine agree after every action,
/// rejected actions change nothing, and settlement writes stacks + rake
/// that conserve lamports.
#[test]
fn program_matches_rules_engine_over_random_hands() {
    let mut x: u64 = 0x2545_f491_4f6c_dd1d;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut max_cu = 0u64;
    let mut reasons = [0u32; 3];
    let mut side_shows = 0u32;
    let mut hands_played = 0;
    for h in 0..24u64 {
        let seats = 2 + (h % 5) as u8;
        let mut stacks = [0u64; MAX_SEATS];
        for s in stacks.iter_mut().take(seats as usize) {
            *s = 20 * BOOT + rnd() % (200 * BOOT);
        }
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&h.to_le_bytes());
        let rake = ((rnd() % 600) as u16, 1 + rnd() % 5_000);
        let mut t = dealt_table(seats, stacks, seed, rake);
        let oracle = t.oracle();
        let order: Vec<u8> = (0..seats).collect();
        let mut host =
            game::Hand::start(game::Rules::v1(BOOT, rake.0, rake.1), stacks, &order).unwrap();
        assert_eq!(t.runtime().game, GameState::from_hand(&host), "after deal");
        let total: u64 = stacks.iter().sum();

        for _step in 0..400 {
            let seat = match host.phase {
                game::Phase::SideShow { target, .. } => target,
                game::Phase::Over => break,
                game::Phase::Betting => host.to_act(),
            };
            let action = match rnd() % 9 {
                0 => Action::Pack,
                1 | 2 => Action::See,
                3 => Action::Show,
                4 => Action::SideShowRequest,
                5 => Action::SideShowRespond {
                    accept: rnd() % 2 == 0,
                },
                6 => Action::Chaal {
                    amount: host.min_bet(seat) * 2,
                },
                _ => Action::Chaal {
                    amount: host.min_bet(seat),
                },
            };
            let before = t.runtime();
            let expect = host.clone().apply(seat, action, &oracle);
            let got = t.act(seat, action);
            match expect {
                Ok(_) => {
                    let cu = got.unwrap_or_else(|e| panic!("hand {h}: {action:?} by {seat}: {e}"));
                    max_cu = max_cu.max(cu);
                    if let Ok(game::Event::SideShowResolved { .. }) =
                        host.apply(seat, action, &oracle)
                    {
                        side_shows += 1;
                    }
                    let rt = t.runtime();
                    assert_eq!(rt.game, GameState::from_hand(&host), "hand {h}: {action:?}");
                    assert_eq!(rt.action_seq, before.action_seq + 1);
                }
                Err(_) => {
                    assert!(
                        got.is_err(),
                        "hand {h}: program accepted {action:?} the engine refused"
                    );
                    let rt = t.runtime();
                    assert_eq!((rt.game, rt.action_seq), (before.game, before.action_seq));
                }
            }
        }
        // Finish stuck hands by packing whoever is to act.
        while host.phase != game::Phase::Over {
            let seat = match host.phase {
                game::Phase::SideShow { target, .. } => {
                    host.apply(target, Action::SideShowRespond { accept: false }, &oracle)
                        .unwrap();
                    t.act(target, Action::SideShowRespond { accept: false })
                        .unwrap();
                    continue;
                }
                _ => host.to_act(),
            };
            host.apply(seat, Action::Pack, &oracle).unwrap();
            t.act(seat, Action::Pack).unwrap();
        }
        let rt = t.runtime();
        let st = host.settlement.unwrap();
        reasons[st.reason as usize] += 1;
        assert_eq!(rt.phase, phase::HAND_COMPLETE, "only the game ends a hand");
        assert_eq!(rt.rake_owed, st.rake);
        assert_eq!(
            rt.stacks.iter().sum::<u64>() + rt.rake_owed,
            total,
            "lamports conserved"
        );
        for s in 0..seats as usize {
            assert_eq!(rt.stacks[s], host.seats[s].stack);
        }
        // The public log replays to the same result (CF-021).
        let d = t.svm.get_account(&t.hand_log).unwrap().data;
        let (log_hand, count) = action_log_header(&d);
        assert_eq!(log_hand, rt.hand_no);
        assert_eq!(count as u64, rt.action_seq);
        let actions = &d[ACTION_LOG_ACTIONS..ACTION_LOG_ACTIONS + count as usize];
        let replayed = game::replay(
            game::Rules::v1(BOOT, rake.0, rake.1),
            stacks,
            &order,
            actions,
            &oracle,
        )
        .unwrap();
        assert_eq!(replayed, host, "hand {h}: log replays to the same hand");
        // The hand is over: no more actions.
        assert!(t.act(host.order[0], Action::Pack).is_err());
        hands_played += 1;
    }
    eprintln!("act: {hands_played} random hands, max {max_cu} CU per action; ends (last player, show, pot limit) = {reasons:?}; side shows resolved = {side_shows}");
    assert!(
        reasons[1] > 0 && side_shows > 0,
        "random play must reach Show and Side Show"
    );
    assert!(max_cu < 200_000);
}

#[test]
fn act_rejects_misuse_without_changing_state() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..3].copy_from_slice(&[100 * BOOT; 3]);
    let mut t = dealt_table(3, stacks, [7; 32], (0, 0));
    let before = t.runtime();
    let payer = t.payer.insecure_clone();
    let hands = t.hands.clone();
    let chaal = |t: &Table, signer: &Pubkey, seq: u64, hands: &[Pubkey]| {
        t.act_ix(signer, 1, BOOT, seq, hands)
    };

    // The seat's wallet is not its session key.
    let w0 = t.wallets[0].insecure_clone();
    let ix = chaal(&t, &w0.pubkey(), 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &w0])
        .unwrap_err()
        .contains("NotSeatOwner"));
    // A stranger.
    let x = Keypair::new();
    let ix = chaal(&t, &x.pubkey(), 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &x])
        .unwrap_err()
        .contains("NotSeatOwner"));
    // Another seat's session out of turn.
    let s1 = t.sessions[1].insecure_clone();
    let ix = chaal(&t, &s1.pubkey(), 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &s1])
        .unwrap_err()
        .contains("NotYourTurn"));
    // Stale sequence number.
    let s0 = t.sessions[0].insecure_clone();
    let ix = chaal(&t, &s0.pubkey(), 5, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &s0])
        .unwrap_err()
        .contains("StaleAction"));
    // Seat hands missing, in the wrong order, or a foreign account.
    for bad in [
        hands[..2].to_vec(),
        vec![hands[1], hands[0], hands[2]],
        vec![hands[0], hands[1], Pubkey::new_unique()],
    ] {
        let ix = chaal(&t, &s0.pubkey(), 0, &bad);
        assert!(send(&mut t.svm, &[ix], &[&payer, &s0]).is_err(), "{bad:?}");
    }
    // Unknown action code.
    let ix = t.act_ix(&s0.pubkey(), 9, 0, 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &s0])
        .unwrap_err()
        .contains("IllegalAction"));
    // Illegal amount.
    let ix = t.act_ix(&s0.pubkey(), 1, 3 * BOOT, 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &s0])
        .unwrap_err()
        .contains("BadBet"));
    let after = t.runtime();
    assert_eq!(
        (after.game, after.action_seq, after.phase),
        (before.game, before.action_seq, before.phase)
    );

    // A valid action works, and the same signed sequence can't be replayed.
    t.act(0, Action::Chaal { amount: BOOT }).unwrap();
    let ix = chaal(&t, &s0.pubkey(), 0, &hands);
    assert!(send(&mut t.svm, &[ix], &[&payer, &s0]).is_err());
}

#[test]
fn no_betting_before_the_deal() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..2].copy_from_slice(&[100 * BOOT; 2]);
    let mut t = dealt_table(2, stacks, [1; 32], (0, 0));
    // Put the runtime back to SEEDED: acting must fail.
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt.phase = phase::SEEDED;
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
    assert!(t
        .act(0, Action::Chaal { amount: BOOT })
        .unwrap_err()
        .contains("WrongPhase"));
}

#[test]
fn pot_limit_forces_a_showdown_on_chain() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..3].copy_from_slice(&[1_000 * BOOT; 3]);
    let mut t = dealt_table(3, stacks, [42; 32], (250, 20_000));
    let oracle = t.oracle();
    let mut host =
        game::Hand::start(game::Rules::v1(BOOT, 250, 20_000), stacks, &[0, 1, 2]).unwrap();
    for s in 0..3u8 {
        host.apply(s, Action::See, &oracle).unwrap();
        t.act(s, Action::See).unwrap();
    }
    while host.phase != game::Phase::Over {
        let seat = host.to_act();
        let big = host.min_bet(seat) * 2;
        let amount = if big <= 128 * BOOT {
            big
        } else {
            host.min_bet(seat)
        };
        host.apply(seat, Action::Chaal { amount }, &oracle).unwrap();
        t.act(seat, Action::Chaal { amount }).unwrap();
    }
    let rt = t.runtime();
    assert_eq!(rt.game, GameState::from_hand(&host));
    assert_eq!((rt.game.end_reason, rt.phase), (2, phase::HAND_COMPLETE));
    assert_eq!(rt.rake_owed, 20_000, "2.5% of >1M pot, capped at 20,000");
    assert_eq!(rt.stacks.iter().sum::<u64>() + rt.rake_owed, 3_000 * BOOT);
}

/// Keeps `packages/probes/src/common.mjs` (RT, GAME) in sync with the layout.
#[test]
fn runtime_byte_offsets() {
    let mut t = dealt_table(2, [50 * BOOT, 60 * BOOT, 0, 0, 0, 0], [3; 32], (123, 456));
    t.act(0, Action::Chaal { amount: BOOT }).unwrap();
    let d = t.svm.get_account(&t.runtime).unwrap().data;
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    let rt = t.runtime();
    assert_eq!(u64_at(858), rt.commit_seq);
    assert_eq!(u64_at(866), BOOT);
    assert_eq!(u16::from_le_bytes([d[874], d[875]]), 123);
    assert_eq!(u64_at(876), 456);
    assert_eq!(u64_at(884), rt.rake_owed);
    assert_eq!(u64_at(892), 1, "action_seq");
    assert_eq!(u64_at(900), BOOT, "game.boot");
    // seat 0: dealt, active, seen, blind_turns, stack, contributed
    assert_eq!(&d[935..939], &[1, 1, 0, 1]);
    assert_eq!(u64_at(939), 50 * BOOT - 2 * BOOT);
    assert_eq!(u64_at(947), 2 * BOOT);
    assert_eq!(&d[1055..1057], &[0, 1], "order");
    assert_eq!((d[1061], d[1062]), (2, 1), "n, turn");
    assert_eq!(u64_at(1063), BOOT, "stake");
    assert_eq!(u64_at(1071), 3 * BOOT, "pot");
    assert_eq!(d[1079], 0, "phase betting");
    assert_eq!(d.len(), 8 + TableRuntime::INIT_SPACE);
    assert_eq!(&d[1140..1146], &rt.side_show_viewers);
    assert_eq!(u64_at(1146), rt.side_show_hand_no);
    assert_eq!(
        i64::from_le_bytes(d[1154..1162].try_into().unwrap()),
        rt.turn_deadline
    );
    assert_eq!(d[1162], rt.button);
    assert_eq!(d[1163], rt.bump, "bump follows button");
}

/// Keeps `HL` in `packages/probes/src/common.mjs` in sync with `HandLog`.
#[test]
fn hand_log_byte_offsets() {
    assert_eq!(ACTION_LOG_OFFSET, 953);
    assert_eq!(ACTION_LOG_ACTIONS, 963);
    assert_eq!(HAND_LOG_LEN, 2563);
    let mut d = empty_hand_log(Pubkey::new_unique(), Pubkey::new_unique(), 7);
    let mut log = HandLog::try_deserialize(&mut d.as_slice()).unwrap();
    log.revealed = true;
    log.boot = 0x0101_0101;
    log.rake_bps = 0x0202;
    log.rake_cap = 0x0303;
    log.start_stacks[0] = 0x0404;
    log.end_reason = 5;
    log.winners = 6;
    log.payouts[0] = 0x0707;
    log.rake = 0x0808;
    let mut out = Vec::new();
    log.try_serialize(&mut out).unwrap();
    d[..out.len()].copy_from_slice(&out);
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    assert_eq!(d[827], 1, "revealed");
    assert_eq!(u64_at(828), 0x0101_0101);
    assert_eq!(u16::from_le_bytes([d[836], d[837]]), 0x0202);
    assert_eq!(u64_at(838), 0x0303);
    assert_eq!(u64_at(846), 0x0404);
    assert_eq!((d[894], d[895]), (5, 6));
    assert_eq!(u64_at(896), 0x0707);
    assert_eq!(u64_at(944), 0x0808);
    assert_eq!(d[952], 7, "bump");
}

fn ssv(t: &mut Table, a: u8, b: u8, grant: bool) -> Result<u64, String> {
    let ix = side_show_view_ix(t, a, b, grant);
    let payer = t.payer.insecure_clone();
    send(&mut t.svm, &[ix], &[&payer])
}

fn side_show_view_ix(t: &Table, a: u8, b: u8, grant: bool) -> Instruction {
    let perm = |h: &Pubkey| {
        Pubkey::find_program_address(
            &[
                ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED,
                h.as_ref(),
            ],
            &ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID,
        )
        .0
    };
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::SideShowView {
            seat_a: a,
            seat_b: b,
            grant,
        }
        .data(),
        card_flex::accounts::SideShowView {
            payer: t.payer.pubkey(),
            runtime: t.runtime,
            hand_a: t.hands[a as usize],
            permission_a: perm(&t.hands[a as usize]),
            hand_b: t.hands[b as usize],
            permission_b: perm(&t.hands[b as usize]),
            permission_program: ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID,
            ephemeral_vault: ephemeral_rollups_sdk::consts::EPHEMERAL_VAULT_ID,
            magic_program: ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID,
        }
        .to_account_metas(None),
    )
}

/// CF-022: only an accepted Side Show creates a viewer pair; nothing else
/// (no request alone, no reject, no other pair) can be granted, and revoking
/// waits until the hand is no longer being played. The permission CPI itself
/// runs on Devnet (privacy suite); here we check state and every guard.
#[test]
fn side_show_viewers_come_only_from_an_accepted_side_show() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..4].copy_from_slice(&[100 * BOOT; 4]);
    let mut t = dealt_table(4, stacks, [9; 32], (0, 0));
    let err = |r: Result<u64, String>, name: &str| {
        let e = r.unwrap_err();
        assert!(e.contains(name), "expected {name}: {e}");
    };
    // Nothing granted yet.
    err(ssv(&mut t, 1, 2, true), "NoSideShowPending");
    // Revoke while the hand is being played is refused.
    err(ssv(&mut t, 1, 2, false), "WrongPhase");
    // Seat 0 bets; seats 1 and 2 see and bet; seat 2 asks seat 1; seat 1 rejects.
    t.act(0, Action::Chaal { amount: BOOT }).unwrap();
    t.act(1, Action::See).unwrap();
    t.act(1, Action::Chaal { amount: 2 * BOOT }).unwrap();
    t.act(2, Action::See).unwrap();
    t.act(2, Action::SideShowRequest).unwrap();
    assert_eq!(
        t.runtime().side_show_viewers,
        [0; MAX_SEATS],
        "a request alone grants nothing"
    );
    t.act(1, Action::SideShowRespond { accept: false }).unwrap();
    assert_eq!(
        t.runtime().side_show_viewers,
        [0; MAX_SEATS],
        "a rejected Side Show grants nothing"
    );
    err(ssv(&mut t, 1, 2, true), "NoSideShowPending");
    // Next round: seat 3 bets, seat 0 packs, seat 1 bets, seat 2 asks again, seat 1 accepts.
    t.act(3, Action::Chaal { amount: BOOT * 2 }).unwrap();
    t.act(0, Action::Pack).unwrap();
    let stake = t.runtime().game.stake;
    t.act(1, Action::Chaal { amount: 2 * stake }).unwrap();
    t.act(2, Action::SideShowRequest).unwrap();
    t.act(1, Action::SideShowRespond { accept: true }).unwrap();
    let rt = t.runtime();
    assert_eq!(rt.side_show_viewers[1], 1 << 2);
    assert_eq!(rt.side_show_viewers[2], 1 << 1);
    assert_eq!(rt.side_show_hand_no, rt.hand_no);
    assert_eq!((rt.side_show_viewers[0], rt.side_show_viewers[3]), (0, 0));
    // Only that pair: other pairs and the operator's choice are refused.
    err(ssv(&mut t, 1, 3, true), "NoSideShowPending");
    err(ssv(&mut t, 0, 2, true), "NoSideShowPending");
    err(ssv(&mut t, 2, 2, true), "BadReaders");
    // The granting pair passes every guard and reaches the permission CPI
    // (absent in LiteSVM, so the call fails there, not on a guard).
    let e = ssv(&mut t, 1, 2, true).unwrap_err();
    assert!(
        !e.contains("NoSideShowPending") && !e.contains("BadReaders") && !e.contains("WrongPhase"),
        "{e}"
    );
}

fn now(t: &Table) -> i64 {
    t.svm
        .get_sysvar::<anchor_lang::prelude::Clock>()
        .unix_timestamp
}

fn warp_to(t: &mut Table, unix: i64) {
    let mut c = t.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    c.unix_timestamp = unix;
    c.slot += 1;
    t.svm.set_sysvar(&c);
}

fn timeout(t: &mut Table) -> Result<u64, String> {
    let seq = t.runtime().action_seq;
    let mut metas = card_flex::accounts::TimeoutTurn {
        payer: t.payer.pubkey(),
        runtime: t.runtime,
        hand_log: t.hand_log,
    }
    .to_account_metas(None);
    metas.extend(t.hands.iter().map(|h| AccountMeta::new_readonly(*h, false)));
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::TimeoutTurn { expected_seq: seq }.data(),
        metas,
    );
    let payer = t.payer.insecure_clone();
    send(&mut t.svm, &[ix], &[&payer])
}

/// CF-023: the turn timer. Too early fails; after 25 s anyone times out the
/// player to act (= Pack) or a Side Show target (= reject); See doesn't
/// reset the timer; the last timeout ends the hand like a Pack would.
#[test]
fn turn_timeout_packs_or_rejects_after_the_deadline() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..3].copy_from_slice(&[100 * BOOT; 3]);
    let mut t = dealt_table(3, stacks, [5; 32], (0, 0));
    let rt = t.runtime();
    let start = now(&t);
    assert_eq!(
        rt.turn_deadline,
        start + TURN_SECS,
        "timer starts at the deal"
    );
    assert!(timeout(&mut t).unwrap_err().contains("TooEarly"));
    warp_to(&mut t, start + TURN_SECS - 1);
    assert!(timeout(&mut t).unwrap_err().contains("TooEarly"));
    // See by the player to act doesn't buy time.
    t.act(0, Action::See).unwrap();
    assert_eq!(t.runtime().turn_deadline, start + TURN_SECS);
    warp_to(&mut t, start + TURN_SECS);
    timeout(&mut t).unwrap();
    let rt = t.runtime();
    assert!(!rt.game.seats[0].active, "timeout = pack");
    assert_eq!(rt.game.to_hand().to_act(), 1);
    let t1 = now(&t);
    assert_eq!(
        rt.turn_deadline,
        t1 + TURN_SECS,
        "next player gets a fresh 25 s"
    );
    // A stale sequence number fails even after the deadline.
    warp_to(&mut t, t1 + TURN_SECS);
    let seq = t.runtime().action_seq;
    let mut metas = card_flex::accounts::TimeoutTurn {
        payer: t.payer.pubkey(),
        runtime: t.runtime,
        hand_log: t.hand_log,
    }
    .to_account_metas(None);
    metas.extend(t.hands.iter().map(|h| AccountMeta::new_readonly(*h, false)));
    let stale = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::TimeoutTurn {
            expected_seq: seq + 1,
        }
        .data(),
        metas,
    );
    let payer = t.payer.insecure_clone();
    assert!(send(&mut t.svm, &[stale], &[&payer])
        .unwrap_err()
        .contains("StaleAction"));
    // Seat 1 times out too: seat 2 is the last player and wins.
    timeout(&mut t).unwrap();
    let rt = t.runtime();
    assert_eq!(rt.phase, phase::HAND_COMPLETE);
    assert_eq!((rt.game.end_reason, rt.game.winners), (0, 1 << 2));
    // The log shows two Timeouts (code 6) after the See.
    let d = t.svm.get_account(&t.hand_log).unwrap().data;
    let (_, n) = action_log_header(&d);
    let log = &d[ACTION_LOG_ACTIONS..ACTION_LOG_ACTIONS + n as usize];
    assert_eq!(
        log.iter().map(|b| (b >> 1) & 7).collect::<Vec<_>>(),
        vec![0, 6, 6]
    );
    assert!(timeout(&mut t).unwrap_err().contains("WrongPhase"));
}

#[test]
fn timeout_rejects_a_pending_side_show_for_its_target() {
    let mut stacks = [0u64; MAX_SEATS];
    stacks[..3].copy_from_slice(&[100 * BOOT; 3]);
    let mut t = dealt_table(3, stacks, [6; 32], (0, 0));
    t.act(0, Action::Chaal { amount: BOOT }).unwrap();
    t.act(1, Action::See).unwrap();
    t.act(1, Action::Chaal { amount: 2 * BOOT }).unwrap();
    t.act(2, Action::See).unwrap();
    t.act(2, Action::SideShowRequest).unwrap();
    assert_eq!(t.runtime().game.phase, 1);
    let deadline = t.runtime().turn_deadline;
    warp_to(&mut t, deadline);
    timeout(&mut t).unwrap();
    let rt = t.runtime();
    assert_eq!(rt.game.phase, 0, "Side Show rejected");
    assert_eq!(rt.side_show_viewers, [0; MAX_SEATS], "no view on a timeout");
    assert!(
        rt.game.seats.iter().take(3).all(|s| s.active),
        "nobody packed"
    );
    assert_eq!(
        rt.game.to_hand().to_act(),
        0,
        "turn passes after the requester"
    );
}
