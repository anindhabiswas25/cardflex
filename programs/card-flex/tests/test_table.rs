//! CF-006 base-layer table instructions (seating via `buy_in` since CF-020). PER parts (permissions, ephemeral
//! accounts, deal) run on Devnet via `pnpm tablepoc`.

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    card_flex::table::{ephemeral_budget, TableRuntime, RUNTIME_SEED, TABLE_SEED},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

struct Table {
    svm: LiteSVM,
    authority: Keypair,
    config: Pubkey,
    runtime: Pubkey,
    vault: Pubkey,
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> bool {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    match svm.send_transaction(tx) {
        Ok(_) => true,
        Err(e) => {
            if std::env::var("CF_DEBUG").is_ok() {
                eprintln!("tx failed: {:?}\n{}", e.err, e.meta.logs.join("\n"));
            }
            false
        }
    }
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    k
}

fn create(max_seats: u8) -> (Table, bool) {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/card_flex.so"
    ));
    svm.add_program(card_flex::id(), bytes).unwrap();
    common::setup_global(&mut svm);
    // A realistic clock (LiteSVM starts near 0; HAND_GAP_SECS counts from 0).
    let mut c = svm.get_sysvar::<anchor_lang::prelude::Clock>();
    c.unix_timestamp = 1_800_000_000;
    svm.set_sysvar(&c);
    let authority = funded(&mut svm);
    let table_id: u64 = 7;
    let config = Pubkey::find_program_address(
        &[
            TABLE_SEED,
            authority.pubkey().as_ref(),
            &table_id.to_le_bytes(),
        ],
        &card_flex::id(),
    )
    .0;
    let runtime =
        Pubkey::find_program_address(&[RUNTIME_SEED, config.as_ref()], &card_flex::id()).0;
    let hand_log = Pubkey::find_program_address(
        &[card_flex::table::HAND_LOG_SEED, runtime.as_ref()],
        &card_flex::id(),
    )
    .0;
    let vault = Pubkey::find_program_address(
        &[card_flex::table::VAULT_SEED, config.as_ref()],
        &card_flex::id(),
    )
    .0;
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CreateTable {
            table_id,
            max_seats,
        }
        .data(),
        card_flex::accounts::CreateTable {
            config,
            runtime,
            hand_log,
            vault,
            authority: authority.pubkey(),
            system_program: system_program::ID,
            global: common::global_address(),
        }
        .to_account_metas(None),
    );
    let ok = send(&mut svm, ix, &authority);
    let configure = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ConfigureTable {
            boot: 25_000,
            rake_bps: 0,
            rake_cap: 0,
            refund_timeout_secs: 3_600,
        }
        .data(),
        card_flex::accounts::ConfigureTable {
            authority: authority.pubkey(),
            config,
            runtime,
            global: common::global_address(),
        }
        .to_account_metas(None),
    );
    let ok = ok && send(&mut svm, configure, &authority);
    (
        Table {
            svm,
            authority,
            config,
            runtime,
            vault,
        },
        ok,
    )
}

/// Takes a seat with the minimum buy-in (40 boots).
fn join(t: &mut Table, wallet: &Keypair, seat: u8, session_key: Pubkey) -> bool {
    let ledger = Pubkey::find_program_address(
        &[card_flex::table::LEDGER_SEED, t.config.as_ref(), &[seat]],
        &card_flex::id(),
    )
    .0;
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::BuyIn {
            seat,
            amount: 1_000_000,
            session_key,
        }
        .data(),
        card_flex::accounts::BuyIn {
            wallet: wallet.pubkey(),
            config: t.config,
            vault: t.vault,
            ledger,
            global: common::global_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut t.svm, ix, wallet)
        && send(
            &mut t.svm,
            common::join_seat_ix(&wallet.pubkey(), t.runtime, t.config, seat),
            wallet,
        )
}

fn runtime(t: &Table) -> TableRuntime {
    let acc = t.svm.get_account(&t.runtime).unwrap();
    TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

#[test]
fn create_table_funds_ephemeral_budget() {
    let (t, ok) = create(6);
    assert!(ok);
    let rt = runtime(&t);
    assert_eq!(rt.config, t.config);
    assert_eq!(rt.authority, t.authority.pubkey());
    assert_eq!(
        (rt.max_seats, rt.occupied, rt.hand_no, rt.dealt),
        (6, 0, 0, false)
    );
    let lamports = t.svm.get_account(&t.runtime).unwrap().lamports;
    let own_rent = t
        .svm
        .minimum_balance_for_rent_exemption(t.svm.get_account(&t.runtime).unwrap().data.len());
    assert_eq!(lamports, own_rent + ephemeral_budget());
}

#[test]
fn create_table_rejects_bad_seat_counts() {
    assert!(!create(1).1);
    assert!(!create(7).1);
}

#[test]
fn six_players_join_and_bad_joins_fail() {
    let (mut t, ok) = create(6);
    assert!(ok);
    let wallets: Vec<Keypair> = (0..7).map(|_| funded(&mut t.svm)).collect();
    let sessions: Vec<Pubkey> = (0..7).map(|_| Pubkey::new_unique()).collect();

    for seat in 0..6u8 {
        assert!(join(
            &mut t,
            &wallets[seat as usize],
            seat,
            sessions[seat as usize]
        ));
    }
    let rt = runtime(&t);
    assert_eq!(rt.occupied, 0b11_1111);
    assert_eq!(rt.session_keys[3], sessions[3]);
    assert_eq!(rt.wallets[5], wallets[5].pubkey());

    // Taken seat, out-of-range seat.
    assert!(!join(&mut t, &wallets[6], 2, sessions[6]));
    assert!(!join(&mut t, &wallets[6], 6, sessions[6]));
}

#[test]
fn same_wallet_cannot_take_two_seats() {
    let (mut t, _) = create(4);
    let w = funded(&mut t.svm);
    assert!(join(&mut t, &w, 0, Pubkey::new_unique()));
    assert!(!join(&mut t, &w, 1, Pubkey::new_unique()));
}

#[test]
fn default_build_has_test_deck_disabled() {
    // CI builds without `poc-test-deck`; the guard must be compiled out of
    // the allowed path. (poc_deal itself needs PER and is tested on Devnet.)
    assert!(!cfg!(feature = "poc-test-deck"));
}

#[test]
fn session_key_cannot_be_authority_or_any_wallet() {
    let (mut t, _) = create(6);
    let a = funded(&mut t.svm);
    let b = funded(&mut t.svm);
    let authority = t.authority.pubkey();
    // Security review: these would let the operator or a wallet become a reader.
    assert!(!join(&mut t, &a, 0, authority));
    assert!(!join(&mut t, &a, 0, a.pubkey()));
    assert!(!join(&mut t, &a, 0, Pubkey::default()));
    let runtime_key = t.runtime;
    assert!(!join(&mut t, &a, 0, runtime_key));
    let session_a = Pubkey::new_unique();
    assert!(join(&mut t, &a, 0, session_a));
    assert!(!join(&mut t, &b, 1, a.pubkey()), "another seat's wallet");
    assert!(
        !join(&mut t, &b, 1, session_a),
        "another seat's session key"
    );
    assert!(join(&mut t, &b, 1, Pubkey::new_unique()));
}

/// CF-022 security fix: a seat whose hand reader grant is still live (a Side
/// Show viewer from the last hand) blocks `start_hand`, or the old viewer
/// could read the new cards.
#[test]
fn start_hand_refuses_a_live_reader_grant() {
    use anchor_lang::AccountSerialize;
    let (mut t, ok) = create(2);
    assert!(ok);
    let wallets: Vec<Keypair> = (0..2).map(|_| funded(&mut t.svm)).collect();
    for (s, w) in wallets.iter().enumerate() {
        assert!(join(&mut t, w, s as u8, Pubkey::new_unique()));
    }
    let set = |t: &mut Table, grants: u8| {
        let mut acc = t.svm.get_account(&t.runtime).unwrap();
        let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
        rt.locked = true; // as delegate_table leaves it
        rt.grants = grants;
        let mut data = Vec::new();
        rt.try_serialize(&mut data).unwrap();
        data.resize(acc.data.len(), 0);
        acc.data = data;
        t.svm.set_account(t.runtime, acc).unwrap();
    };
    let start = |t: &mut Table| {
        let ix = Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::StartHand {}.data(),
            card_flex::accounts::StartHand {
                payer: t.authority.pubkey(),
                config: t.config,
                runtime: t.runtime,
            }
            .to_account_metas(None),
        );
        t.svm.expire_blockhash();
        let a = t.authority.insecure_clone();
        let msg = Message::new_with_blockhash(&[ix], Some(&a.pubkey()), &t.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&a]).unwrap();
        t.svm
            .send_transaction(tx)
            .map_err(|e| e.meta.logs.join("\n"))
    };
    set(&mut t, 1 << 1);
    let e = start(&mut t).unwrap_err();
    assert!(e.contains("GrantActive"), "{e}");
    set(&mut t, 0);
    start(&mut t).expect("no live grant: the hand starts");
    assert_eq!(runtime(&t).phase, card_flex::table::phase::SALTS_PENDING);
}

fn patch_runtime(t: &mut Table, f: impl FnOnce(&mut TableRuntime)) {
    use anchor_lang::AccountSerialize;
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    f(&mut rt);
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
}

fn send_signed(t: &mut Table, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    t.svm.expire_blockhash();
    let msg =
        Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &t.svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    t.svm
        .send_transaction(tx)
        .map(|_| ())
        .map_err(|e| e.meta.logs.join("\n"))
}

fn advance(t: &mut Table, secs: i64) {
    let mut c = t.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    c.unix_timestamp += secs;
    c.slot += 1;
    t.svm.set_sysvar(&c);
}

fn start_hand_ix(t: &Table) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::StartHand {}.data(),
        card_flex::accounts::StartHand {
            payer: t.authority.pubkey(),
            config: t.config,
            runtime: t.runtime,
        }
        .to_account_metas(None),
    )
}

fn next_hand_ix(t: &Table, payer: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::NextHand {}.data(),
        card_flex::accounts::NextHand {
            payer: payer.pubkey(),
            runtime: t.runtime,
        }
        .to_account_metas(None),
    )
}

/// CF-024: the button moves every hand; dealing starts left of it; seats
/// below the boot sit out; `next_hand` needs a revealed hand.
#[test]
fn button_moves_and_dealing_order_follows_it() {
    use card_flex::table::phase;
    let (mut t, _) = create(4);
    let wallets: Vec<Keypair> = (0..3).map(|_| funded(&mut t.svm)).collect();
    for (s, w) in wallets.iter().enumerate() {
        assert!(join(&mut t, w, s as u8, Pubkey::new_unique()));
    }
    patch_runtime(&mut t, |rt| rt.locked = true);
    let a = t.authority.insecure_clone();
    let anyone = funded(&mut t.svm);
    let order = |t: &Table| {
        let rt = runtime(t);
        rt.dealing_order[..rt.dealing_count as usize].to_vec()
    };
    assert_eq!(runtime(&t).button, 3, "new table: button on the last seat");
    {
        let ix = start_hand_ix(&t);
        send_signed(&mut t, ix, &[&a]).unwrap();
    }
    assert_eq!(order(&t), vec![0, 1, 2], "first hand deals from seat 0");
    // next_hand only after the reveal.
    let e = {
        let ix = next_hand_ix(&t, &anyone);
        send_signed(&mut t, ix, &[&anyone]).unwrap_err()
    };
    assert!(e.contains("WrongPhase"), "{e}");
    for (want_button, want_order, hand_no) in [
        (0u8, vec![1u8, 2, 0], 1u64),
        (1, vec![2, 0, 1], 2),
        (2, vec![0, 1, 2], 3),
    ] {
        patch_runtime(&mut t, |rt| {
            rt.phase = phase::REVEALED;
            rt.side_show_viewers[0] = 0b10;
        });
        {
            let ix = next_hand_ix(&t, &anyone);
            send_signed(&mut t, ix, &[&anyone]).unwrap();
        }
        let rt = runtime(&t);
        assert_eq!(
            (rt.button, rt.hand_no, rt.phase, rt.salts_in),
            (want_button, hand_no, phase::IDLE, 0)
        );
        assert_eq!(rt.side_show_viewers, [0; 6], "viewers don't carry over");
        advance(&mut t, card_flex::table::HAND_GAP_SECS);
        {
            let ix = start_hand_ix(&t);
            send_signed(&mut t, ix, &[&a]).unwrap();
        }
        assert_eq!(order(&t), want_order);
    }
    // Seat 1 drops below the boot: it sits out, and its salt is refused.
    patch_runtime(&mut t, |rt| {
        rt.phase = phase::REVEALED;
        rt.stacks[1] = 24_999;
    });
    {
        let ix = next_hand_ix(&t, &anyone);
        send_signed(&mut t, ix, &[&anyone]).unwrap();
    }
    advance(&mut t, card_flex::table::HAND_GAP_SECS);
    {
        let ix = start_hand_ix(&t);
        send_signed(&mut t, ix, &[&a]).unwrap();
    }
    assert_eq!(order(&t), vec![2, 0], "button on 0: seat 1 skipped");
    let rt = runtime(&t);
    let session1 = Keypair::new();
    patch_runtime(&mut t, |r| r.session_keys[1] = session1.pubkey());
    let salt = Pubkey::find_program_address(
        &[card_flex::table::SALT_SEED, t.runtime.as_ref(), &[1]],
        &card_flex::id(),
    )
    .0;
    let mut d = vec![0u8; card_flex::table::SALT_LEN as usize];
    d[..8].copy_from_slice(card_flex::table::SALT_TAG);
    d[8..40].copy_from_slice(t.runtime.as_ref());
    d[40] = 1;
    t.svm
        .set_account(
            salt,
            solana_account::Account {
                lamports: 10_000_000,
                data: d,
                owner: card_flex::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::SubmitSalt {
            seat: 1,
            salt: [7; 32],
        }
        .data(),
        card_flex::accounts::SubmitSalt {
            session: session1.pubkey(),
            runtime: t.runtime,
            salt,
        }
        .to_account_metas(None),
    );
    t.svm.airdrop(&session1.pubkey(), 1_000_000_000).unwrap();
    let e = send_signed(&mut t, ix, &[&session1]).unwrap_err();
    assert!(
        e.contains("SeatEmpty"),
        "a seat that isn't dealt can't submit a salt: {e}"
    );
    assert_eq!(runtime(&t).salts_in, rt.salts_in);
}

/// CF-050 liveness: anyone starts a hand (not sooner than HAND_GAP_SECS after
/// the last one); a stalled salt round is cancelled by anyone after SALT_SECS;
/// a player who misses salt rounds is made to leave only after
/// MAX_MISSED_SALTS in a row (security review: no eviction for one slow
/// moment); submitting resets the count; nothing is ever charged.
#[test]
fn stalled_salt_rounds_cancel_and_three_strikes_make_a_seat_leave() {
    use card_flex::table::{
        phase, HAND_GAP_SECS, MAX_MISSED_SALTS, SALT_LEN, SALT_SECS, SALT_SEED, SALT_TAG,
    };
    let (mut t, _) = create(4);
    let wallets: Vec<Keypair> = (0..3).map(|_| funded(&mut t.svm)).collect();
    for (s, w) in wallets.iter().enumerate() {
        assert!(join(&mut t, w, s as u8, Pubkey::new_unique()));
    }
    let session0 = Keypair::new();
    t.svm.airdrop(&session0.pubkey(), 1_000_000_000).unwrap();
    patch_runtime(&mut t, |rt| {
        rt.locked = true;
        rt.session_keys[0] = session0.pubkey();
    });
    let before = runtime(&t);
    let stranger = funded(&mut t.svm);
    let salt =
        Pubkey::find_program_address(&[SALT_SEED, t.runtime.as_ref(), &[0]], &card_flex::id()).0;
    let mut d = vec![0u8; SALT_LEN as usize];
    d[..8].copy_from_slice(SALT_TAG);
    d[8..40].copy_from_slice(t.runtime.as_ref());
    t.svm
        .set_account(
            salt,
            solana_account::Account {
                lamports: 10_000_000,
                data: d,
                owner: card_flex::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let start = |t: &Table| {
        Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::StartHand {}.data(),
            card_flex::accounts::StartHand {
                payer: stranger.pubkey(),
                config: t.config,
                runtime: t.runtime,
            }
            .to_account_metas(None),
        )
    };
    let cancel = |t: &Table| {
        Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::CancelSalts {}.data(),
            card_flex::accounts::CancelSalts {
                payer: stranger.pubkey(),
                runtime: t.runtime,
            }
            .to_account_metas(None),
        )
    };
    let submit0 = |t: &Table| {
        Instruction::new_with_bytes(
            card_flex::id(),
            &card_flex::instruction::SubmitSalt {
                seat: 0,
                salt: [9; 32],
            }
            .data(),
            card_flex::accounts::SubmitSalt {
                session: session0.pubkey(),
                runtime: t.runtime,
                salt,
            }
            .to_account_metas(None),
        )
    };
    for round in 1..=MAX_MISSED_SALTS {
        // A stranger (not the table authority) starts the hand.
        {
            let ix = start(&t);
            send_signed(&mut t, ix, &[&stranger]).expect("start_hand is permissionless");
        }
        let now = t
            .svm
            .get_sysvar::<anchor_lang::prelude::Clock>()
            .unix_timestamp;
        assert_eq!(
            (runtime(&t).phase, runtime(&t).salts_deadline),
            (phase::SALTS_PENDING, now + SALT_SECS)
        );
        // Seat 0 submits; seats 1 and 2 don't.
        {
            let ix = submit0(&t);
            send_signed(&mut t, ix, &[&session0]).unwrap();
        }
        let e = {
            let ix = cancel(&t);
            send_signed(&mut t, ix, &[&stranger]).unwrap_err()
        };
        assert!(e.contains("TooEarly"), "{e}");
        advance(&mut t, SALT_SECS);
        {
            let ix = cancel(&t);
            send_signed(&mut t, ix, &[&stranger]).unwrap();
        }
        let rt = runtime(&t);
        assert_eq!(rt.phase, phase::IDLE);
        assert_eq!(
            rt.hand_no,
            before.hand_no + round as u64,
            "new hand number each time"
        );
        assert_eq!(rt.missed_salts[..3], [0, round, round]);
        assert_eq!(rt.stacks, before.stacks, "nothing charged");
        if round < MAX_MISSED_SALTS {
            assert_eq!(
                (rt.occupied, rt.departed),
                (0b111, 0),
                "round {round}: still seated"
            );
            // Too soon after the cancel: refused; after the gap: allowed.
            let e = {
                let ix = start(&t);
                send_signed(&mut t, ix, &[&stranger]).unwrap_err()
            };
            assert!(e.contains("TooEarly"), "{e}");
            advance(&mut t, HAND_GAP_SECS);
        } else {
            assert_eq!(
                (rt.occupied, rt.departed),
                (0b001, 0b110),
                "3 misses in a row: seats 1 and 2 leave"
            );
        }
    }
    assert_eq!(
        runtime(&t).cancelled_hands,
        before.cancelled_hands + MAX_MISSED_SALTS as u32
    );
    let e = {
        let ix = cancel(&t);
        send_signed(&mut t, ix, &[&stranger]).unwrap_err()
    };
    assert!(e.contains("WrongPhase"), "{e}");
}
