//! CF-013 / ADR 0004: money skeleton and recovery on the base layer.
//! Buy-in into the vault, sync from committed runtime state (both the
//! delegated and the undelegated path), and emergency refund.

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
            runtime: t.runtime,
            vault: t.vault,
            ledger: ledger(t, seat),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn buy_in(t: &mut T, seat: u8, amount: u64) -> Result<(), String> {
    let w = t.wallets[seat as usize].insecure_clone();
    let ix = buy_in_ix(t, seat, amount, &w);
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
