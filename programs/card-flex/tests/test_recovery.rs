//! CF-013 / ADR 0004: money skeleton and recovery on the base layer.
//! Buy-in into the vault, sync from committed runtime state (both the
//! delegated and the undelegated path), and emergency refund.

mod common;

use {
    anchor_lang::{
        prelude::{AccountMeta, Pubkey},
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    card_flex::table::*,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const TEE: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

struct T {
    svm: LiteSVM,
    authority: Keypair,
    config: Pubkey,
    runtime: Pubkey,
    vault: Pubkey,
    wallets: Vec<Keypair>,
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?}", e.err))
}

/// Instructions are built before the simulator is borrowed mutably.
fn send_ix(ixs: Vec<Instruction>, svm: &mut LiteSVM, signers: &[&Keypair]) -> Result<(), String> {
    send(svm, &ixs, signers)
}

fn code(err: card_flex::CardFlexError) -> String {
    format!("Custom({})", err as u32 + 6000)
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &card_flex::id()).0
}

fn ledger(t: &T, seat: u8) -> Pubkey {
    pda(&[LEDGER_SEED, t.config.as_ref(), &[seat]])
}

fn setup(seats: usize) -> T {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/card_flex.so"
    ));
    svm.add_program(card_flex::id(), bytes).unwrap();
    common::setup_global(&mut svm);
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    let table_id: u64 = 42;
    let config = pda(&[
        TABLE_SEED,
        authority.pubkey().as_ref(),
        &table_id.to_le_bytes(),
    ]);
    let runtime = pda(&[RUNTIME_SEED, config.as_ref()]);
    let hand_log = pda(&[HAND_LOG_SEED, runtime.as_ref()]);
    let vault = pda(&[VAULT_SEED, config.as_ref()]);
    let create = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CreateTable {
            table_id,
            max_seats: 6,
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
    send(&mut svm, &[create], &[&authority]).expect("create");
    let configure = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ConfigureTable {
            boot: 25_000,
            rake_bps: 0,
            rake_cap: 0,
            refund_timeout_secs: 60,
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
    send(&mut svm, &[configure], &[&authority]).expect("configure");
    let wallets: Vec<Keypair> = (0..seats)
        .map(|_| {
            let k = Keypair::new();
            svm.airdrop(&k.pubkey(), 2_000_000_000).unwrap();
            k
        })
        .collect();
    T {
        svm,
        authority,
        config,
        runtime,
        vault,
        wallets,
    }
}

fn buy_in_ix(t: &T, seat: u8, amount: u64, wallet: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::BuyIn {
            seat,
            amount,
            session_key: Pubkey::new_unique(),
        }
        .data(),
        card_flex::accounts::BuyIn {
            wallet: wallet.pubkey(),
            config: t.config,
            vault: t.vault,
            ledger: ledger(t, seat),
            global: common::global_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn buy_in(t: &mut T, seat: u8, amount: u64) -> Result<(), String> {
    let w = t.wallets[seat as usize].insecure_clone();
    let ix = buy_in_ix(t, seat, amount, &w);
    send_ix(vec![ix], &mut t.svm, &[&w])?;
    // ADR 0005: the seat enters the runtime with join_seat.
    let ix = common::join_seat_ix(&w.pubkey(), t.runtime, t.config, seat);
    send_ix(vec![ix], &mut t.svm, &[&w])
}

fn config(t: &T) -> TableConfig {
    TableConfig::try_deserialize(&mut t.svm.get_account(&t.config).unwrap().data.as_slice())
        .unwrap()
}

fn ledger_state(t: &T, seat: u8) -> SeatLedger {
    SeatLedger::try_deserialize(&mut t.svm.get_account(&ledger(t, seat)).unwrap().data.as_slice())
        .unwrap()
}

/// Rewrites the runtime as PER would after a commit.
fn commit(t: &mut T, seq: u64, phase_value: u8, stacks: [u64; MAX_SEATS]) {
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt.commit_seq = seq;
    rt.phase = phase_value;
    rt.stacks = stacks;
    let mut data = Vec::new();
    rt.try_serialize(&mut data).unwrap();
    data.resize(acc.data.len(), 0);
    acc.data = data;
    t.svm.set_account(t.runtime, acc).unwrap();
}

/// Puts the runtime under the delegation program with a delegation record
/// naming `validator` and `owner`, as `delegate_table` leaves it.
fn delegate(t: &mut T, validator: Pubkey, owner: Pubkey) -> Pubkey {
    let dp = ephemeral_rollups_sdk::id();
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    acc.owner = dp;
    t.svm.set_account(t.runtime, acc).unwrap();
    let (record, _) = Pubkey::find_program_address(&[b"delegation", t.runtime.as_ref()], &dp);
    let mut data = vec![0u8; 8 + 32 + 32 + 24];
    data[8..40].copy_from_slice(validator.as_ref());
    data[40..72].copy_from_slice(owner.as_ref());
    t.svm
        .set_account(
            record,
            Account {
                lamports: 1_000_000,
                data,
                owner: dp,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    // delegate_table also records the validator in TableConfig.
    let mut c = t.svm.get_account(&t.config).unwrap();
    let mut cfg = TableConfig::try_deserialize(&mut c.data.as_slice()).unwrap();
    cfg.validator = TEE.parse().unwrap();
    cfg.ever_delegated = true;
    let mut d = Vec::new();
    cfg.try_serialize(&mut d).unwrap();
    d.resize(c.data.len(), 0);
    c.data = d;
    t.svm.set_account(t.config, c).unwrap();
    record
}

fn sync_ix(t: &T, record: Pubkey, ledgers: &[Pubkey]) -> Instruction {
    let mut metas = card_flex::accounts::SyncHand {
        config: t.config,
        runtime: t.runtime,
        delegation_record: record,
    }
    .to_account_metas(None);
    metas.extend(ledgers.iter().map(|l| AccountMeta::new(*l, false)));
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::SyncHand {}.data(),
        metas,
    )
}

fn emergency_ix(t: &T, payer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::EmergencyRefund {}.data(),
        card_flex::accounts::EmergencyRefund {
            payer,
            config: t.config,
        }
        .to_account_metas(None),
    )
}

fn claim_ix(t: &T, payer: Pubkey, seat: u8, wallet: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ClaimRefund {}.data(),
        card_flex::accounts::ClaimRefund {
            payer,
            config: t.config,
            vault: t.vault,
            ledger: ledger(t, seat),
            wallet,
        }
        .to_account_metas(None),
    )
}

fn warp_secs(t: &mut T, secs: i64) {
    let mut clock: anchor_lang::prelude::Clock = t.svm.get_sysvar();
    clock.unix_timestamp += secs;
    t.svm.set_sysvar(&clock);
}

#[test]
fn buy_in_moves_lamports_into_the_vault_and_records_ledgers() {
    let mut t = setup(3);
    let before = t.svm.get_account(&t.vault).unwrap().lamports;
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 2, 2_500_000).unwrap();
    let after = t.svm.get_account(&t.vault).unwrap().lamports;
    assert_eq!(after - before, 3_500_000);
    assert_eq!(config(&t).seated, 0b101);
    let l = ledger_state(&t, 2);
    assert_eq!(
        (l.seat, l.buy_in, l.synced_stack, l.wallet),
        (2, 2_500_000, 2_500_000, t.wallets[2].pubkey())
    );
    let rt =
        TableRuntime::try_deserialize(&mut t.svm.get_account(&t.runtime).unwrap().data.as_slice())
            .unwrap();
    assert_eq!(rt.stacks[2], 2_500_000);
    // Limits, taken seat, duplicate wallet.
    assert!(buy_in(&mut t, 1, 999_999)
        .unwrap_err()
        .contains(&code(card_flex::CardFlexError::BadAmount)));
    assert!(
        buy_in(&mut t, 0, 5_000).is_err(),
        "seat 0 taken (ledger exists)"
    );
    let w0 = t.wallets[0].insecure_clone();
    let ix = buy_in_ix(&t, 1, 5_000_000, &w0);
    assert!(send_ix(vec![ix], &mut t.svm, &[&w0])
        .unwrap_err()
        .contains(&code(card_flex::CardFlexError::SeatTaken)));
    // Terms are frozen once someone has bought in.
    let a = t.authority.insecure_clone();
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ConfigureTable {
            boot: 1,
            rake_bps: 0,
            rake_cap: 0,
            refund_timeout_secs: 60,
        }
        .data(),
        card_flex::accounts::ConfigureTable {
            authority: a.pubkey(),
            config: t.config,
            runtime: t.runtime,
            global: common::global_address(),
        }
        .to_account_metas(None),
    );
    assert!(send_ix(vec![ix], &mut t.svm, &[&a])
        .unwrap_err()
        .contains(&code(card_flex::CardFlexError::TableLocked)));
}

#[test]
fn sync_accepts_only_newer_commits_from_the_right_validator() {
    let mut t = setup(2);
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 1_000_000).unwrap();
    let ledgers = [ledger(&t, 0), ledger(&t, 1)];
    let payer = t.authority.insecure_clone();
    let record = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());

    // Hand finished: stacks moved 30k from seat 1 to seat 0.
    let mut stacks = [0u64; MAX_SEATS];
    stacks[0] = 130_000;
    stacks[1] = 70_000;
    commit(&mut t, 1, phase::REVEALED, stacks);
    send_ix(vec![sync_ix(&t, record, &ledgers)], &mut t.svm, &[&payer]).expect("sync");
    assert_eq!(
        (
            ledger_state(&t, 0).synced_stack,
            ledger_state(&t, 1).synced_stack
        ),
        (130_000, 70_000)
    );
    // Same commit again: stale.
    let e = send_ix(vec![sync_ix(&t, record, &ledgers)], &mut t.svm, &[&payer]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::StaleCommit)),
        "{e}"
    );

    // Mid-hand commit: liveness refreshes, stacks do not.
    let mut mid = stacks;
    mid[0] = 1;
    commit(&mut t, 2, phase::DEALT, mid);
    let t_before = config(&t).last_sync_time;
    warp_secs(&mut t, 30);
    send_ix(vec![sync_ix(&t, record, &[])], &mut t.svm, &[&payer]).expect("mid-hand sync");
    assert!(config(&t).last_sync_time > t_before);
    assert_eq!(
        ledger_state(&t, 0).synced_stack,
        130_000,
        "unfinished bets never synced"
    );

    // Wrong validator or wrong owner in the delegation record: rejected.
    commit(&mut t, 3, phase::IDLE, stacks);
    let bad = delegate(&mut t, Pubkey::new_unique(), card_flex::id());
    let e = send_ix(vec![sync_ix(&t, bad, &ledgers)], &mut t.svm, &[&payer]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadRuntime)),
        "{e}"
    );
    let bad = delegate(&mut t, TEE.parse().unwrap(), Pubkey::new_unique());
    let e = send_ix(vec![sync_ix(&t, bad, &ledgers)], &mut t.svm, &[&payer]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadRuntime)),
        "{e}"
    );
    // Missing ledgers between hands: rejected.
    let good = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    let e = send_ix(
        vec![sync_ix(&t, good, &ledgers[..1])],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadLedger)),
        "{e}"
    );
}

#[test]
fn emergency_refund_then_each_seat_claims_exactly_its_synced_stack() {
    let mut t = setup(3);
    for (s, amt) in [(0u8, 1_000_000u64), (1, 2_000_000), (2, 3_000_000)] {
        buy_in(&mut t, s, amt).unwrap();
    }
    let payer = Keypair::new();
    t.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    let w: Vec<Pubkey> = t.wallets.iter().map(|k| k.pubkey()).collect();

    // Nothing can be claimed while the table is active.
    let e = send_ix(
        vec![claim_ix(&t, payer.pubkey(), 0, w[0])],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TableNotActive)),
        "{e}"
    );
    // Before the timeout: refused.
    let e = send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(e.contains(&code(card_flex::CardFlexError::TooEarly)), "{e}");

    warp_secs(&mut t, 61);
    send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .expect("refund starts");
    assert_eq!(config(&t).status, status::REFUNDED);
    // A wallet that isn't the recorded payout address: refused.
    let e = send_ix(
        vec![claim_ix(&t, payer.pubkey(), 1, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(e.contains("Custom(2001)"), "has_one wallet: {e}");

    let vault_before = t.svm.get_account(&t.vault).unwrap().lamports;
    for s in 0..3u8 {
        let before = t.svm.get_account(&w[s as usize]).unwrap().lamports;
        send_ix(
            vec![claim_ix(&t, payer.pubkey(), s, w[s as usize])],
            &mut t.svm,
            &[&payer],
        )
        .expect("claim");
        let after = t.svm.get_account(&w[s as usize]).unwrap().lamports;
        assert_eq!(
            after - before,
            [1_000_000, 2_000_000, 3_000_000][s as usize]
        );
        assert_eq!(ledger_state(&t, s).synced_stack, 0);
    }
    assert_eq!(
        vault_before - t.svm.get_account(&t.vault).unwrap().lamports,
        6_000_000
    );
    // Claiming twice pays nothing.
    let e = send_ix(
        vec![claim_ix(&t, payer.pubkey(), 0, w[0])],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::NothingToClaim)),
        "{e}"
    );
    // A second refund and a late commit can't move money.
    let e = send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TableNotActive)),
        "{e}"
    );
    let record = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    commit(&mut t, 9, phase::IDLE, [7; MAX_SEATS]);
    let ledgers: Vec<Pubkey> = (0..3).map(|s| ledger(&t, s)).collect();
    let e = send_ix(vec![sync_ix(&t, record, &ledgers)], &mut t.svm, &[&payer]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TableNotActive)),
        "late commit can't move money: {e}"
    );
}

#[test]
fn one_seat_claiming_is_independent_of_the_others() {
    let mut t = setup(2);
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 1_000_000).unwrap();
    let payer = Keypair::new();
    t.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    warp_secs(&mut t, 61);
    send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    // Seat 1 never claims; seat 0 still gets paid.
    let w0 = t.wallets[0].pubkey();
    let before = t.svm.get_account(&w0).unwrap().lamports;
    send_ix(
        vec![claim_ix(&t, payer.pubkey(), 0, w0)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(t.svm.get_account(&w0).unwrap().lamports - before, 1_000_000);
    assert_eq!(ledger_state(&t, 1).synced_stack, 1_000_000);
}

#[test]
fn a_recent_sync_postpones_the_refund() {
    let mut t = setup(2);
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 1_000_000).unwrap();
    let payer = t.authority.insecure_clone();
    let record = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    warp_secs(&mut t, 50);
    let mut stacks = [0u64; MAX_SEATS];
    stacks[0] = 1_000_000;
    stacks[1] = 1_000_000;
    commit(&mut t, 1, phase::IDLE, stacks);
    send_ix(
        vec![sync_ix(&t, record, &[ledger(&t, 0), ledger(&t, 1)])],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    warp_secs(&mut t, 30); // 80 s after creation, 30 s after the sync
    let e = send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(e.contains(&code(card_flex::CardFlexError::TooEarly)), "{e}");
    warp_secs(&mut t, 31);
    send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .expect("refund after timeout");
}

/// CF-073: an empty table isn't heartbeated by the keeper, so its refund clock
/// goes stale. It can't be refunded while empty, and its first buy-in restarts
/// the clock (later buy-ins don't).
#[test]
fn an_empty_table_is_not_refundable_and_the_first_buy_in_restarts_the_clock() {
    let mut t = setup(2);
    let payer = Keypair::new();
    t.svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();
    warp_secs(&mut t, 61 * 10); // long past the 60 s timeout, nobody seated
    let e = send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::NothingToRefund)),
        "{e}"
    );

    // First buy-in: the full timeout starts now, not at the stale sync.
    buy_in(&mut t, 0, 1_000_000).unwrap();
    let started = config(&t).last_sync_time;
    let e = send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(e.contains(&code(card_flex::CardFlexError::TooEarly)), "{e}");

    // A second buy-in doesn't push the clock (it would delay seat 0's refund).
    warp_secs(&mut t, 40);
    buy_in(&mut t, 1, 1_000_000).unwrap();
    assert_eq!(config(&t).last_sync_time, started);
    warp_secs(&mut t, 21); // 61 s after the first buy-in
    send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .expect("refund 61 s after the first buy-in");
}

#[test]
fn only_the_tee_validator_is_trusted() {
    let mut t = setup(1);
    buy_in(&mut t, 0, 1_000_000).unwrap();
    let payer = t.authority.insecure_clone();
    // A record naming an operator-chosen validator is never trusted, even if
    // TableConfig were somehow made to name it.
    let rogue = Pubkey::new_unique();
    let record = delegate(&mut t, rogue, card_flex::id());
    let mut c = t.svm.get_account(&t.config).unwrap();
    let mut cfg = TableConfig::try_deserialize(&mut c.data.as_slice()).unwrap();
    cfg.validator = rogue;
    let mut d = Vec::new();
    cfg.try_serialize(&mut d).unwrap();
    d.resize(c.data.len(), 0);
    c.data = d;
    t.svm.set_account(t.config, c).unwrap();
    commit(&mut t, 1, phase::IDLE, [5_000_000; MAX_SEATS]);
    let e = send_ix(
        vec![sync_ix(&t, record, &[ledger(&t, 0)])],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadRuntime)),
        "{e}"
    );
    assert_eq!(ledger_state(&t, 0).synced_stack, 1_000_000);
    assert!(card_flex::table::allowed_validator(&TEE.parse().unwrap()));
    assert!(!card_flex::table::allowed_validator(&rogue));
}

fn runtime_state(t: &T) -> TableRuntime {
    TableRuntime::try_deserialize(&mut t.svm.get_account(&t.runtime).unwrap().data.as_slice())
        .unwrap()
}

fn cancel_ix(t: &T, seat: u8, wallet: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CancelBuyIn { seat }.data(),
        card_flex::accounts::CancelBuyIn {
            payer: wallet.pubkey(),
            config: t.config,
            runtime: t.runtime,
            vault: t.vault,
            ledger: ledger(t, seat),
            wallet: wallet.pubkey(),
        }
        .to_account_metas(None),
    )
}

/// CF-031 (ADR 0005): buy-in only records a ledger with a new epoch;
/// join_seat seats exactly that epoch; sync never copies a stale stack into a
/// ledger that hasn't joined.
#[test]
fn buy_in_then_join_seat_with_epochs() {
    let mut t = setup(3);
    let w0 = t.wallets[0].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 0, 1_000_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    let l = ledger_state(&t, 0);
    assert_eq!((l.epoch, l.synced_stack, l.left), (1, 1_000_000, false));
    assert_eq!(config(&t).seat_epochs[0], 1);
    assert_eq!(runtime_state(&t).occupied, 0, "buy_in alone doesn't seat");
    // Byte offsets used by packages/probes/src/common.mjs (SL, SL5).
    let d = t.svm.get_account(&ledger(&t, 0)).unwrap().data;
    assert_eq!(
        u64::from_le_bytes(d[81..89].try_into().unwrap()),
        l.synced_stack
    );
    assert_eq!(
        u32::from_le_bytes(d[90..94].try_into().unwrap()),
        1,
        "epoch"
    );
    assert_eq!(&d[94..126], l.session_key.as_ref());
    assert_eq!(d[126], 0, "left");
    // join_seat seats epoch 1; a second join is refused.
    send_ix(
        vec![common::join_seat_ix(&w0.pubkey(), t.runtime, t.config, 0)],
        &mut t.svm,
        &[&w0],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!(
        (
            rt.occupied,
            rt.stacks[0],
            rt.seat_epoch[0],
            rt.wallets[0],
            rt.session_keys[0]
        ),
        (1, 1_000_000, 1, w0.pubkey(), l.session_key)
    );
    let e = send_ix(
        vec![common::join_seat_ix(&w0.pubkey(), t.runtime, t.config, 0)],
        &mut t.svm,
        &[&w0],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::SeatTaken)),
        "{e}"
    );
    // Seat 1: bought in, not joined. A commit that (wrongly) shows an old
    // stack at seat 1 must not reach its ledger: epochs differ.
    let w1 = t.wallets[1].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 1, 2_000_000, &w1)], &mut t.svm, &[&w1]).unwrap();
    let mut stacks = [0u64; MAX_SEATS];
    stacks[0] = 1_200_000;
    stacks[1] = 999;
    commit(&mut t, 1, phase::IDLE, stacks);
    let payer = t.authority.insecure_clone();
    let ledgers = [ledger(&t, 0), ledger(&t, 1)];
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(
        ledger_state(&t, 0).synced_stack,
        1_200_000,
        "joined seat synced"
    );
    assert_eq!(
        ledger_state(&t, 1).synced_stack,
        2_000_000,
        "unjoined ledger keeps its buy-in"
    );
    // join only between hands.
    commit(&mut t, 2, phase::DEALT, stacks);
    let e = send_ix(
        vec![common::join_seat_ix(&w1.pubkey(), t.runtime, t.config, 1)],
        &mut t.svm,
        &[&w1],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::WrongPhase)),
        "{e}"
    );
}

#[test]
fn join_refuses_a_ledger_of_the_wrong_epoch() {
    let mut t = setup(2);
    let w0 = t.wallets[0].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 0, 1_000_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    // Pretend the runtime already seated epoch 1 at seat 0 and the seat is
    // free again (the old player left but its ledger was never cashed out):
    // a ledger with epoch 1 must not join a second time.
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt.seat_epoch[0] = 1;
    let mut d = Vec::new();
    rt.try_serialize(&mut d).unwrap();
    d.resize(acc.data.len(), 0);
    acc.data = d;
    t.svm.set_account(t.runtime, acc).unwrap();
    let e = send_ix(
        vec![common::join_seat_ix(&w0.pubkey(), t.runtime, t.config, 0)],
        &mut t.svm,
        &[&w0],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadLedger)),
        "{e}"
    );
}

/// cancel_buy_in: only the recorded wallet, only for a ledger that never
/// joined, only on a table that was never delegated. A cancelled seat can
/// be bought and joined again (security review: it used to be bricked).
#[test]
fn cancel_buy_in_rules_and_the_seat_stays_usable() {
    let mut t = setup(3);
    let w1 = t.wallets[1].insecure_clone();
    let stranger = Keypair::new();
    t.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    buy_in(&mut t, 0, 1_000_000).unwrap(); // joined
    send_ix(vec![buy_in_ix(&t, 1, 2_000_000, &w1)], &mut t.svm, &[&w1]).unwrap(); // not joined
    let w0 = t.wallets[0].insecure_clone();
    let e = send_ix(vec![cancel_ix(&t, 0, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::SeatTaken)),
        "a joined seat can't cancel: {e}"
    );
    // A stranger can't cancel someone else's buy-in.
    let mut ix = cancel_ix(&t, 1, &w1);
    ix.accounts[0].pubkey = stranger.pubkey();
    ix.accounts[5].pubkey = stranger.pubkey();
    assert!(send_ix(vec![ix], &mut t.svm, &[&stranger]).is_err());
    let before = t.svm.get_balance(&w1.pubkey()).unwrap();
    let vault_before = t.svm.get_balance(&t.vault).unwrap();
    send_ix(vec![cancel_ix(&t, 1, &w1)], &mut t.svm, &[&w1]).unwrap();
    assert!(
        t.svm.get_balance(&w1.pubkey()).unwrap() + 10_000 >= before + 2_000_000,
        "buy-in plus ledger rent back"
    );
    assert_eq!(
        t.svm.get_balance(&t.vault).unwrap(),
        vault_before - 2_000_000
    );
    assert!(
        t.svm
            .get_account(&ledger(&t, 1))
            .map(|a| a.lamports == 0)
            .unwrap_or(true),
        "ledger closed"
    );
    assert_eq!(config(&t).seated & 0b10, 0);
    assert!(
        send_ix(vec![cancel_ix(&t, 1, &w1)], &mut t.svm, &[&w1]).is_err(),
        "only once"
    );
    // Regression: buy the seat again (epoch 2) and it still joins.
    send_ix(vec![buy_in_ix(&t, 1, 1_500_000, &w1)], &mut t.svm, &[&w1]).unwrap();
    assert_eq!(ledger_state(&t, 1).epoch, 2);
    send_ix(
        vec![common::join_seat_ix(&w1.pubkey(), t.runtime, t.config, 1)],
        &mut t.svm,
        &[&w1],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!((rt.seat_epoch[1], rt.stacks[1]), (2, 1_500_000));
    // Once the table was ever delegated, no cancel at all (PER may hold a
    // clone of the ledger), even after it comes back to the base layer.
    let w2 = t.wallets[2].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 2, 1_000_000, &w2)], &mut t.svm, &[&w2]).unwrap();
    delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    acc.owner = card_flex::id(); // undelegated again
    t.svm.set_account(t.runtime, acc).unwrap();
    let e = send_ix(vec![cancel_ix(&t, 2, &w2)], &mut t.svm, &[&w2]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TableLocked)),
        "{e}"
    );
}

/// A refunded (zeroed) ledger can't be seated (security review: stale PER
/// clones must not create money).
#[test]
fn join_refuses_a_zeroed_ledger() {
    let mut t = setup(2);
    let w0 = t.wallets[0].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 0, 1_000_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    let mut acc = t.svm.get_account(&ledger(&t, 0)).unwrap();
    acc.data[81..89].copy_from_slice(&0u64.to_le_bytes()); // synced_stack = 0 (claimed)
    t.svm.set_account(ledger(&t, 0), acc).unwrap();
    let e = send_ix(
        vec![common::join_seat_ix(&w0.pubkey(), t.runtime, t.config, 0)],
        &mut t.svm,
        &[&w0],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadLedger)),
        "{e}"
    );
}

#[test]
fn pause_blocks_buy_in_but_not_refunds() {
    let mut t = setup(2);
    // setup_global's admin is not kept here; take over the global authority.
    let mut acc = t.svm.get_account(&common::global_address()).unwrap();
    let admin = Keypair::new();
    t.svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    acc.data[8..40].copy_from_slice(admin.pubkey().as_ref());
    t.svm.set_account(common::global_address(), acc).unwrap();
    let w1 = t.wallets[1].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 1, 1_000_000, &w1)], &mut t.svm, &[&w1]).unwrap();
    let pause = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::UpdateGlobal {
            treasury: admin.pubkey(),
            max_rake_bps: 1_000,
            paused: true,
        }
        .data(),
        card_flex::accounts::UpdateGlobal {
            authority: admin.pubkey(),
            global: common::global_address(),
        }
        .to_account_metas(None),
    );
    send_ix(vec![pause], &mut t.svm, &[&admin]).unwrap();
    let w0 = t.wallets[0].insecure_clone();
    let e = send_ix(vec![buy_in_ix(&t, 0, 1_000_000, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(e.contains(&code(card_flex::CardFlexError::Paused)), "{e}");
    // Withdrawing an unjoined buy-in still works while paused.
    send_ix(vec![cancel_ix(&t, 1, &w1)], &mut t.svm, &[&w1]).unwrap();
}

fn leave_ix(t: &T, seat: u8, signer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::LeaveSeat { seat }.data(),
        card_flex::accounts::LeaveSeat {
            signer,
            runtime: t.runtime,
        }
        .to_account_metas(None),
    )
}

fn cash_out_ix(t: &T, seat: u8, payer: Pubkey, wallet: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CashOut { seat }.data(),
        card_flex::accounts::CashOut {
            payer,
            config: t.config,
            vault: t.vault,
            ledger: ledger(t, seat),
            wallet,
        }
        .to_account_metas(None),
    )
}

/// CF-032 (ADR 0005): leave -> commit + sync marks the ledger left -> one
/// cash-out to the recorded wallet; then a new player can take the seat.
#[test]
fn leave_sync_cash_out_once_then_the_seat_is_reused() {
    let mut t = setup(3);
    let payer = t.authority.insecure_clone();
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 2_000_000).unwrap();
    let w0 = t.wallets[0].insecure_clone();
    let stranger = Keypair::new();
    t.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let e = send_ix(
        vec![leave_ix(&t, 0, stranger.pubkey())],
        &mut t.svm,
        &[&stranger],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::NotSeatOwner)),
        "{e}"
    );
    // Seat 0 won 300,000 last hand (as committed), then leaves between hands.
    let mut stacks = [0u64; MAX_SEATS];
    stacks[0] = 1_300_000;
    stacks[1] = 1_700_000;
    commit(&mut t, 1, phase::IDLE, stacks);
    send_ix(vec![leave_ix(&t, 0, w0.pubkey())], &mut t.svm, &[&w0]).unwrap();
    let rt = runtime_state(&t);
    assert_eq!(
        (rt.occupied, rt.departed, rt.leaving, rt.stacks[0]),
        (0b10, 0b01, 0, 1_300_000)
    );
    // No cash-out before a sync has seen the leave.
    let e = send_ix(
        vec![cash_out_ix(&t, 0, payer.pubkey(), w0.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(e.contains(&code(card_flex::CardFlexError::NotLeft)), "{e}");
    commit(&mut t, 2, phase::IDLE, stacks);
    let ledgers = [ledger(&t, 0), ledger(&t, 1)];
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    let l0 = ledger_state(&t, 0);
    assert_eq!((l0.left, l0.synced_stack), (true, 1_300_000));
    assert!(!ledger_state(&t, 1).left);
    // Only to the recorded wallet.
    let e = send_ix(
        vec![cash_out_ix(&t, 0, payer.pubkey(), stranger.pubkey())],
        &mut t.svm,
        &[&payer],
    );
    assert!(e.is_err(), "wrong wallet");
    let (wb, vb) = (
        t.svm.get_balance(&w0.pubkey()).unwrap(),
        t.svm.get_balance(&t.vault).unwrap(),
    );
    send_ix(
        vec![cash_out_ix(&t, 0, payer.pubkey(), w0.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert!(t.svm.get_balance(&w0.pubkey()).unwrap() >= wb + 1_300_000);
    assert_eq!(
        t.svm.get_balance(&t.vault).unwrap(),
        vb - 1_300_000,
        "exactly the final stack"
    );
    assert!(
        send_ix(
            vec![cash_out_ix(&t, 0, payer.pubkey(), w0.pubkey())],
            &mut t.svm,
            &[&payer]
        )
        .is_err(),
        "no double cash-out"
    );
    assert_eq!(config(&t).seated & 1, 0);
    // A new player takes seat 0: epoch 2, its own buy-in, departed cleared.
    let w2 = t.wallets[2].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 0, 1_500_000, &w2)], &mut t.svm, &[&w2]).unwrap();
    assert_eq!(ledger_state(&t, 0).epoch, 2);
    send_ix(
        vec![common::join_seat_ix(&w2.pubkey(), t.runtime, t.config, 0)],
        &mut t.svm,
        &[&w2],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!(
        (
            rt.occupied,
            rt.departed,
            rt.stacks[0],
            rt.wallets[0],
            rt.seat_epoch[0]
        ),
        (0b11, 0, 1_500_000, w2.pubkey(), 2)
    );
    // A later sync updates the new ledger, never the closed old one.
    stacks[0] = 1_400_000;
    commit(&mut t, 3, phase::IDLE, stacks);
    let ledgers = [ledger(&t, 0), ledger(&t, 1)];
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(
        (ledger_state(&t, 0).synced_stack, ledger_state(&t, 0).left),
        (1_400_000, false)
    );
}

/// A leave asked during a hand waits for the hand to end (`next_hand`).
#[test]
fn leave_during_a_hand_applies_at_next_hand() {
    let mut t = setup(3);
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 1_000_000).unwrap();
    let w1 = t.wallets[1].insecure_clone();
    commit(&mut t, 1, phase::DEALT, [1_000_000, 1_000_000, 0, 0, 0, 0]);
    send_ix(vec![leave_ix(&t, 1, w1.pubkey())], &mut t.svm, &[&w1]).unwrap();
    let rt = runtime_state(&t);
    assert_eq!(
        (rt.occupied, rt.leaving, rt.departed),
        (0b11, 0b10, 0),
        "still in the hand"
    );
    commit(&mut t, 2, phase::REVEALED, [1_100_000, 900_000, 0, 0, 0, 0]);
    let payer = t.authority.insecure_clone();
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::NextHand {}.data(),
        card_flex::accounts::NextHand {
            payer: payer.pubkey(),
            runtime: t.runtime,
        }
        .to_account_metas(None),
    );
    send_ix(vec![ix], &mut t.svm, &[&payer]).unwrap();
    let rt = runtime_state(&t);
    assert_eq!(
        (rt.occupied, rt.leaving, rt.departed, rt.stacks[1]),
        (0b01, 0, 0b10, 900_000)
    );
}

fn sweep_ix(t: &T, payer: Pubkey, treasury: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::SweepRake {}.data(),
        card_flex::accounts::SweepRake {
            payer,
            config: t.config,
            vault: t.vault,
            global: common::global_address(),
            treasury,
        }
        .to_account_metas(None),
    )
}

fn set_rake_owed(t: &mut T, rake: u64) {
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    let mut rt = TableRuntime::try_deserialize(&mut acc.data.as_slice()).unwrap();
    rt.rake_owed = rake;
    let mut d = Vec::new();
    rt.try_serialize(&mut d).unwrap();
    d.resize(acc.data.len(), 0);
    acc.data = d;
    t.svm.set_account(t.runtime, acc).unwrap();
}

/// CF-033: rake reaches the treasury only from synced, settled hands, each
/// lamport once, and the vault then matches ADR 0005's formula exactly.
#[test]
fn rake_is_swept_once_and_only_from_synced_results() {
    let mut t = setup(2);
    let payer = t.authority.insecure_clone();
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 1_000_000).unwrap();
    let treasury = GlobalConfig::try_deserialize(
        &mut t
            .svm
            .get_account(&common::global_address())
            .unwrap()
            .data
            .as_slice(),
    )
    .unwrap()
    .treasury;
    let ledgers = [ledger(&t, 0), ledger(&t, 1)];
    // Mid-hand commit: neither stacks nor rake may sync.
    commit(&mut t, 1, phase::DEALT, [1_190_000, 800_000, 0, 0, 0, 0]);
    set_rake_owed(&mut t, 10_000);
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(config(&t).synced_rake, 0);
    let e = send_ix(
        vec![sweep_ix(&t, payer.pubkey(), treasury)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::NothingToClaim)),
        "{e}"
    );
    // Settled: rake syncs, then sweeps once, only to the treasury.
    commit(&mut t, 2, phase::REVEALED, [1_190_000, 800_000, 0, 0, 0, 0]);
    set_rake_owed(&mut t, 10_000);
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(config(&t).synced_rake, 10_000);
    assert!(
        send_ix(
            vec![sweep_ix(&t, payer.pubkey(), Pubkey::new_unique())],
            &mut t.svm,
            &[&payer]
        )
        .is_err(),
        "not the treasury"
    );
    let (tb, vb) = (
        t.svm.get_balance(&treasury).unwrap_or(0),
        t.svm.get_balance(&t.vault).unwrap(),
    );
    send_ix(
        vec![sweep_ix(&t, payer.pubkey(), treasury)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(t.svm.get_balance(&treasury).unwrap(), tb + 10_000);
    assert_eq!(t.svm.get_balance(&t.vault).unwrap(), vb - 10_000);
    assert!(
        send_ix(
            vec![sweep_ix(&t, payer.pubkey(), treasury)],
            &mut t.svm,
            &[&payer]
        )
        .is_err(),
        "only once"
    );
    // Vault invariant (ADR 0005 decision 8), to the lamport.
    let c = config(&t);
    let vault = t.svm.get_account(&t.vault).unwrap();
    let rent = t.svm.minimum_balance_for_rent_exemption(vault.data.len());
    let stacks: u64 = (0..2).map(|s| ledger_state(&t, s).synced_stack).sum();
    assert_eq!(
        vault.lamports,
        rent + stacks + (c.synced_rake - c.rake_swept)
    );
    // Rake of the next hand adds up.
    commit(&mut t, 3, phase::REVEALED, [1_180_000, 795_000, 0, 0, 0, 0]);
    set_rake_owed(&mut t, 25_000);
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    send_ix(
        vec![sweep_ix(&t, payer.pubkey(), treasury)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_eq!(t.svm.get_balance(&treasury).unwrap(), tb + 25_000);
    // TableConfig byte offsets used by packages/probes/src/common.mjs (TC).
    let d = t.svm.get_account(&t.config).unwrap().data;
    let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    let c = config(&t);
    assert_eq!(d[135], c.seated);
    assert_eq!(u64_at(144), c.last_synced_seq);
    assert_eq!(
        u32::from_le_bytes(d[153..157].try_into().unwrap()),
        c.seat_epochs[0]
    );
    assert_eq!(&d[177..209], c.wallets[0].as_ref());
    assert_eq!(&d[369..401], c.sessions[0].as_ref());
    assert_eq!(d[561], c.ever_delegated as u8);
    assert_eq!((u64_at(562), u64_at(570)), (c.synced_rake, c.rake_swept));
}

fn check_vault_ix(t: &T, strict: bool) -> Instruction {
    let c = config(t);
    let mut metas = card_flex::accounts::CheckVault {
        config: t.config,
        vault: t.vault,
    }
    .to_account_metas(None);
    metas.extend(
        (0..MAX_SEATS as u8)
            .filter(|s| c.seated & (1 << s) != 0)
            .map(|s| AccountMeta::new_readonly(ledger(t, s), false)),
    );
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CheckVault { strict }.data(),
        metas,
    )
}

fn assert_reconciles(t: &mut T, step: &str) {
    let payer = t.authority.insecure_clone();
    let ix = check_vault_ix(t, true);
    send_ix(vec![ix], &mut t.svm, &[&payer])
        .unwrap_or_else(|e| panic!("vault doesn't reconcile after {step}: {e}"));
}

/// CF-034: the vault reconciles exactly after every money step of a table's
/// life (ADR 0005 decision 8); a surplus fails only the strict check, a
/// shortfall fails both.
#[test]
fn vault_reconciles_after_every_money_step() {
    let mut t = setup(3);
    let payer = t.authority.insecure_clone();
    assert_reconciles(&mut t, "create");
    buy_in(&mut t, 0, 1_000_000).unwrap();
    buy_in(&mut t, 1, 2_000_000).unwrap();
    let w2 = t.wallets[2].insecure_clone();
    send_ix(vec![buy_in_ix(&t, 2, 1_500_000, &w2)], &mut t.svm, &[&w2]).unwrap(); // unjoined
    assert_reconciles(&mut t, "buy-ins");
    // A hand moves 200,000 from seat 1 to seat 0 with 5,000 rake.
    commit(
        &mut t,
        1,
        phase::REVEALED,
        [1_195_000, 1_800_000, 0, 0, 0, 0],
    );
    set_rake_owed(&mut t, 5_000);
    let ledgers = [ledger(&t, 0), ledger(&t, 1), ledger(&t, 2)];
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_reconciles(&mut t, "sync");
    let treasury = GlobalConfig::try_deserialize(
        &mut t
            .svm
            .get_account(&common::global_address())
            .unwrap()
            .data
            .as_slice(),
    )
    .unwrap()
    .treasury;
    send_ix(
        vec![sweep_ix(&t, payer.pubkey(), treasury)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_reconciles(&mut t, "sweep");
    // Seat 0 leaves and cashes out.
    let w0 = t.wallets[0].insecure_clone();
    commit(&mut t, 2, phase::IDLE, [1_195_000, 1_800_000, 0, 0, 0, 0]);
    set_rake_owed(&mut t, 5_000);
    send_ix(vec![leave_ix(&t, 0, w0.pubkey())], &mut t.svm, &[&w0]).unwrap();
    commit(&mut t, 3, phase::IDLE, [1_195_000, 1_800_000, 0, 0, 0, 0]);
    set_rake_owed(&mut t, 5_000);
    send_ix(
        vec![sync_ix(&t, Pubkey::new_unique(), &ledgers)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    send_ix(
        vec![cash_out_ix(&t, 0, payer.pubkey(), w0.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_reconciles(&mut t, "cash-out");
    // Seat 2 takes its unjoined buy-in back.
    send_ix(vec![cancel_ix(&t, 2, &w2)], &mut t.svm, &[&w2]).unwrap();
    assert_reconciles(&mut t, "cancel");
    // A donation: solvent, but the strict check reports the surplus.
    let donor = Keypair::new();
    t.svm.airdrop(&donor.pubkey(), 1_000_000_000).unwrap();
    let mut acc = t.svm.get_account(&t.vault).unwrap();
    acc.lamports += 7;
    t.svm.set_account(t.vault, acc).unwrap();
    let e = send_ix(vec![check_vault_ix(&t, true)], &mut t.svm, &[&payer]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::VaultSurplus)),
        "{e}"
    );
    send_ix(vec![check_vault_ix(&t, false)], &mut t.svm, &[&payer]).unwrap();
    // A shortfall fails both.
    let mut acc = t.svm.get_account(&t.vault).unwrap();
    acc.lamports -= 8;
    t.svm.set_account(t.vault, acc).unwrap();
    for strict in [true, false] {
        let e = send_ix(vec![check_vault_ix(&t, strict)], &mut t.svm, &[&payer]).unwrap_err();
        assert!(
            e.contains(&code(card_flex::CardFlexError::VaultShort)),
            "{e}"
        );
    }
    let mut acc = t.svm.get_account(&t.vault).unwrap();
    acc.lamports += 1;
    t.svm.set_account(t.vault, acc).unwrap();
    assert_reconciles(&mut t, "restored");
    // Refund: the remaining seat claims; the vault still reconciles.
    warp_secs(&mut t, 3_600);
    send_ix(
        vec![emergency_ix(&t, payer.pubkey())],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    let w1 = t.wallets[1].pubkey();
    send_ix(
        vec![claim_ix(&t, payer.pubkey(), 1, w1)],
        &mut t.svm,
        &[&payer],
    )
    .unwrap();
    assert_reconciles(&mut t, "refund claim");
    // Missing or foreign ledgers are refused.
    let mut ix = check_vault_ix(&t, true);
    ix.accounts.pop();
    assert!(send_ix(vec![ix], &mut t.svm, &[&payer]).is_err());
}

// ---- CF-076: top-ups ----

fn top_up_ix(t: &T, seat: u8, amount: u64, wallet: &Keypair) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::TopUp { seat, amount }.data(),
        card_flex::accounts::TopUp {
            wallet: wallet.pubkey(),
            global: common::global_address(),
            config: t.config,
            vault: t.vault,
            ledger: ledger(t, seat),
            runtime: t.runtime,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn apply_ix(t: &T, seat: u8, payer: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ApplyTopUp { seat }.data(),
        card_flex::accounts::ApplyTopUp {
            payer,
            runtime: t.runtime,
            ledger: ledger(t, seat),
        }
        .to_account_metas(None),
    )
}

/// A top-up is payable the moment it is deposited, reaches the stack once
/// (between hands), and a sync never drops one that hasn't reached it yet.
#[test]
fn top_up_is_payable_at_once_applied_once_and_kept_by_sync() {
    let mut t = setup(2);
    let (w0, w1) = (t.wallets[0].insecure_clone(), t.wallets[1].insecure_clone());
    let anyone = t.authority.insecure_clone();
    buy_in(&mut t, 0, 1_000_000).unwrap();
    // Seat 1 buys in but isn't seated yet; it tops up before joining.
    send_ix(vec![buy_in_ix(&t, 1, 1_000_000, &w1)], &mut t.svm, &[&w1]).unwrap();

    // Limits: at least one boot (25,000); stack may not pass 200 boots (5,000,000).
    let e = send_ix(vec![top_up_ix(&t, 0, 24_999, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::BadAmount)),
        "{e}"
    );
    let e = send_ix(vec![top_up_ix(&t, 0, 4_000_001, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TopUpTooLarge)),
        "{e}"
    );
    // Only the seat's own wallet.
    assert!(send_ix(vec![top_up_ix(&t, 0, 500_000, &w1)], &mut t.svm, &[&w1]).is_err());

    send_ix(vec![top_up_ix(&t, 0, 500_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    let l0 = ledger_state(&t, 0);
    assert_eq!(
        (l0.buy_in, l0.synced_stack),
        (1_500_000, 1_500_000),
        "payable at once"
    );
    assert_reconciles(&mut t, "top-up");

    // Applied once, between hands.
    send_ix(
        vec![apply_ix(&t, 0, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!((rt.stacks[0], rt.credited[0]), (1_500_000, 1_500_000));
    let e = send_ix(
        vec![apply_ix(&t, 0, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::NothingToApply)),
        "{e}"
    );

    // Seat 1: a top-up before joining is part of the stack it joins with.
    send_ix(vec![top_up_ix(&t, 1, 200_000, &w1)], &mut t.svm, &[&w1]).unwrap();
    send_ix(
        vec![common::join_seat_ix(&w1.pubkey(), t.runtime, t.config, 1)],
        &mut t.svm,
        &[&w1],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!((rt.stacks[1], rt.credited[1]), (1_200_000, 1_200_000));
    assert_reconciles(&mut t, "join after top-up");

    // Never during a hand.
    send_ix(vec![top_up_ix(&t, 0, 300_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    let stacks = rt.stacks;
    commit(&mut t, 0, card_flex::table::phase::DEALT, stacks);
    let e = send_ix(
        vec![apply_ix(&t, 0, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::WrongPhase)),
        "{e}"
    );

    // The hand ends (seat 0 lost 300,000 to seat 1) and is synced before the
    // 300,000 top-up reached the stack: the sync keeps it payable.
    let record = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    let mut s = [0u64; MAX_SEATS];
    s[0] = 1_200_000;
    s[1] = 1_500_000;
    commit(&mut t, 1, card_flex::table::phase::IDLE, s);
    send_ix(
        vec![sync_ix(&t, record, &[ledger(&t, 0), ledger(&t, 1)])],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    assert_eq!(
        ledger_state(&t, 0).synced_stack,
        1_500_000,
        "1,200,000 stack + 300,000 pending"
    );
    assert_eq!(ledger_state(&t, 1).synced_stack, 1_500_000);
    assert_reconciles(&mut t, "sync with a pending top-up");

    // Refund: everyone gets exactly what they're owed, top-ups included.
    warp_secs(&mut t, 61);
    send_ix(
        vec![emergency_ix(&t, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    let before = (
        t.svm.get_balance(&w0.pubkey()).unwrap(),
        t.svm.get_balance(&w1.pubkey()).unwrap(),
    );
    send_ix(
        vec![claim_ix(&t, anyone.pubkey(), 0, w0.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    send_ix(
        vec![claim_ix(&t, anyone.pubkey(), 1, w1.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    assert_eq!(
        t.svm.get_balance(&w0.pubkey()).unwrap() - before.0,
        1_500_000
    );
    assert_eq!(
        t.svm.get_balance(&w1.pubkey()).unwrap() - before.1,
        1_500_000
    );
    // No top-ups on a refunded table.
    let e = send_ix(vec![top_up_ix(&t, 0, 100_000, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TableNotActive)),
        "{e}"
    );
}

/// A table whose runtime predates `credited` refuses top-ups until migrated
/// (a sync there couldn't see a pending one).
#[test]
fn top_up_needs_the_migrated_runtime() {
    let mut t = setup(1);
    let w0 = t.wallets[0].insecure_clone();
    buy_in(&mut t, 0, 1_000_000).unwrap();
    let mut acc = t.svm.get_account(&t.runtime).unwrap();
    acc.data.truncate(1_284);
    t.svm.set_account(t.runtime, acc).unwrap();
    let e = send_ix(vec![top_up_ix(&t, 0, 100_000, &w0)], &mut t.svm, &[&w0]).unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::RuntimeNotMigrated)),
        "{e}"
    );
}

/// The live stack can be above the last synced one (won since the sync):
/// a top-up never takes it past the table's maximum buy-in (200 boots); the
/// rest stays pending, payable on leaving, never playable.
#[test]
fn top_up_never_takes_the_live_stack_past_the_maximum_buy_in() {
    let mut t = setup(1);
    let w0 = t.wallets[0].insecure_clone();
    let anyone = t.authority.insecure_clone();
    buy_in(&mut t, 0, 1_000_000).unwrap();
    // Won since the last sync: live 4,800,000 (max 5,000,000), synced 1,000,000.
    let mut s = [0u64; MAX_SEATS];
    s[0] = 4_800_000;
    commit(&mut t, 0, phase::IDLE, s);
    // The base layer only knows the synced stack, so 4,000,000 is accepted...
    send_ix(vec![top_up_ix(&t, 0, 4_000_000, &w0)], &mut t.svm, &[&w0]).unwrap();
    // ...but only 200,000 reaches the live stack.
    send_ix(
        vec![apply_ix(&t, 0, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    let rt = runtime_state(&t);
    assert_eq!(rt.stacks[0], 5_000_000, "capped at 200 boots");
    assert_eq!(rt.credited[0], 1_200_000);
    // At the cap nothing more applies.
    let e = send_ix(
        vec![apply_ix(&t, 0, anyone.pubkey())],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap_err();
    assert!(
        e.contains(&code(card_flex::CardFlexError::TopUpTooLarge)),
        "{e}"
    );
    // The 3,800,000 that didn't fit is still the player's money.
    let record = delegate(&mut t, TEE.parse().unwrap(), card_flex::id());
    commit(&mut t, 1, phase::IDLE, rt.stacks);
    send_ix(
        vec![sync_ix(&t, record, &[ledger(&t, 0)])],
        &mut t.svm,
        &[&anyone],
    )
    .unwrap();
    assert_eq!(ledger_state(&t, 0).synced_stack, 5_000_000 + 3_800_000);
    // (No vault reconciliation here: the 3,800,000 "won" above was written
    // straight into the runtime, with no losing player behind it.)
}
