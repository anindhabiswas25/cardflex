//! Shared LiteSVM helpers for the program tests.
#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub const UPGRADEABLE_LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";

pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(
        &[card_flex::id().as_ref()],
        &UPGRADEABLE_LOADER.parse().unwrap(),
    )
    .0
}

pub fn global_address() -> Pubkey {
    Pubkey::find_program_address(&[card_flex::table::GLOBAL_SEED], &card_flex::id()).0
}

/// Sets the program's upgrade authority in LiteSVM's ProgramData account
/// (LiteSVM leaves it empty). Layout: u32 tag, u64 slot, Option<Pubkey>.
pub fn set_upgrade_authority(svm: &mut LiteSVM, authority: &Pubkey) {
    let pd = program_data_address();
    let mut acc = svm.get_account(&pd).expect("program data");
    acc.data[12] = 1;
    acc.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(pd, acc).unwrap();
}

pub fn init_global_ix(authority: &Pubkey, treasury: Pubkey, max_rake_bps: u16) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::InitGlobal {
            treasury,
            max_rake_bps,
        }
        .data(),
        card_flex::accounts::InitGlobal {
            authority: *authority,
            global: global_address(),
            program: card_flex::id(),
            program_data: program_data_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn send_one(svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let msg =
        Message::new_with_blockhash(&[ix], Some(&signers[0].pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| e.meta.logs.join("\n"))
}

/// Creates the GlobalConfig as the upgrade authority would (max rake 10%).
/// Returns the global authority.
pub fn setup_global(svm: &mut LiteSVM) -> Keypair {
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1_000_000_000).unwrap();
    set_upgrade_authority(svm, &admin.pubkey());
    send_one(
        svm,
        init_global_ix(&admin.pubkey(), admin.pubkey(), 1_000),
        &[&admin],
    )
    .expect("init_global");
    admin
}

/// `join_seat` on the base layer (no permissions yet: optional accounts None).
pub fn join_seat_ix(payer: &Pubkey, runtime: Pubkey, config: Pubkey, seat: u8) -> Instruction {
    let ledger = Pubkey::find_program_address(
        &[card_flex::table::LEDGER_SEED, config.as_ref(), &[seat]],
        &card_flex::id(),
    )
    .0;
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::JoinSeat { seat }.data(),
        card_flex::accounts::JoinSeat {
            payer: *payer,
            runtime,
            ledger,
            hand: None,
            hand_permission: None,
            runtime_permission: None,
            permission_program: None,
            ephemeral_vault: None,
            magic_program: None,
        }
        .to_account_metas(None),
    )
}
