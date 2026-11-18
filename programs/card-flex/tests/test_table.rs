//! CF-006 base-layer table instructions. PER parts (permissions, ephemeral
//! accounts, deal) run on Devnet via `pnpm tablepoc`.

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
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> bool {
    svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx).is_ok()
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
            authority: authority.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let ok = send(&mut svm, ix, &authority);
    (
        Table {
            svm,
            authority,
            config,
            runtime,
        },
        ok,
    )
}

fn join(t: &mut Table, wallet: &Keypair, seat: u8, session_key: Pubkey) -> bool {
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::PocJoin { seat, session_key }.data(),
        card_flex::accounts::PocJoin {
            wallet: wallet.pubkey(),
            runtime: t.runtime,
        }
        .to_account_metas(None),
    );
    send(&mut t.svm, ix, wallet)
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
