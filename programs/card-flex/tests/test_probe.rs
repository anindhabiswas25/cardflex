//! CF-004 probe instructions that run without MagicBlock (init and write).
//! Delegation, permissions and commits need the MagicBlock programs and are
//! exercised on Devnet by `pnpm roundtrip`.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

fn setup() -> (LiteSVM, Keypair, Pubkey) {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/card_flex.so"
    ));
    svm.add_program(card_flex::id(), bytes).unwrap();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 1_000_000_000).unwrap();
    let probe = Pubkey::find_program_address(
        &[card_flex::PROBE_SEED, authority.pubkey().as_ref()],
        &card_flex::id(),
    )
    .0;
    (svm, authority, probe)
}

fn send(svm: &mut LiteSVM, ix: Instruction, signer: &Keypair) -> bool {
    let msg = Message::new_with_blockhash(&[ix], Some(&signer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[signer]).unwrap();
    svm.send_transaction(tx).is_ok()
}

fn init_ix(authority: &Keypair, probe: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ProbeInit {}.data(),
        card_flex::accounts::ProbeInit {
            probe,
            authority: authority.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn write_ix(authority: Pubkey, probe: Pubkey, value: u64) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ProbeWrite { value }.data(),
        card_flex::accounts::ProbeWrite { authority, probe }.to_account_metas(None),
    )
}

fn read(svm: &LiteSVM, probe: Pubkey) -> card_flex::Probe {
    let acc = svm.get_account(&probe).unwrap();
    card_flex::Probe::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

#[test]
fn init_prefunds_permission_rent_and_write_updates_state() {
    let (mut svm, authority, probe) = setup();
    assert!(send(&mut svm, init_ix(&authority, probe), &authority));

    let state = read(&svm, probe);
    assert_eq!(state.authority, authority.pubkey());
    assert_eq!((state.value, state.writes), (0, 0));
    // Rent for the account itself plus the pre-funded permission rent.
    let lamports = svm.get_account(&probe).unwrap().lamports;
    let own_rent = svm.minimum_balance_for_rent_exemption(8 + 48);
    assert!(lamports > own_rent, "permission rent was not pre-funded");

    assert!(send(
        &mut svm,
        write_ix(authority.pubkey(), probe, 42),
        &authority
    ));
    assert!(send(
        &mut svm,
        write_ix(authority.pubkey(), probe, 43),
        &authority
    ));
    let state = read(&svm, probe);
    assert_eq!((state.value, state.writes), (43, 2));
}

#[test]
fn write_by_another_signer_is_rejected() {
    let (mut svm, authority, probe) = setup();
    assert!(send(&mut svm, init_ix(&authority, probe), &authority));

    let intruder = Keypair::new();
    svm.airdrop(&intruder.pubkey(), 1_000_000_000).unwrap();
    assert!(!send(
        &mut svm,
        write_ix(intruder.pubkey(), probe, 7),
        &intruder
    ));
    assert_eq!(read(&svm, probe).writes, 0);
}

#[test]
fn init_twice_is_rejected() {
    let (mut svm, authority, probe) = setup();
    assert!(send(&mut svm, init_ix(&authority, probe), &authority));
    svm.expire_blockhash();
    assert!(!send(&mut svm, init_ix(&authority, probe), &authority));
}
