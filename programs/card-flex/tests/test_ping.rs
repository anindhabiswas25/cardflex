use {
    anchor_lang::{solana_program::instruction::Instruction, InstructionData, ToAccountMetas},
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

#[test]
fn ping_runs_and_logs_protocol_version() {
    let program_id = card_flex::id();
    let payer = Keypair::new();

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/card_flex.so"
    ));
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&payer.pubkey(), 1_000_000_000).unwrap();

    let ix = Instruction::new_with_bytes(
        program_id,
        &card_flex::instruction::Ping {}.data(),
        card_flex::accounts::Ping {}.to_account_metas(None),
    );
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();

    let meta = svm.send_transaction(tx).expect("ping should succeed");
    let expected = format!("card-flex protocol v{}", card_flex::PROTOCOL_VERSION);
    assert!(
        meta.logs.iter().any(|l| l.contains(&expected)),
        "missing version log in {:?}",
        meta.logs
    );
}
