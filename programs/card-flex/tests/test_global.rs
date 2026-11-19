//! CF-030: GlobalConfig (ADR 0005 decision 7).

mod common;

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    card_flex::table::*,
    common::*,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn svm() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(
        card_flex::id(),
        include_bytes!(concat!(
            env!("CARGO_TARGET_TMPDIR"),
            "/../deploy/card_flex.so"
        )),
    )
    .unwrap();
    svm
}

fn funded(svm: &mut LiteSVM) -> Keypair {
    let k = Keypair::new();
    svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    k
}

fn global(svm: &LiteSVM) -> GlobalConfig {
    GlobalConfig::try_deserialize(&mut svm.get_account(&global_address()).unwrap().data.as_slice())
        .unwrap()
}

fn update_ix(authority: &Pubkey, treasury: Pubkey, max_rake_bps: u16, paused: bool) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::UpdateGlobal {
            treasury,
            max_rake_bps,
            paused,
        }
        .data(),
        card_flex::accounts::UpdateGlobal {
            authority: *authority,
            global: global_address(),
        }
        .to_account_metas(None),
    )
}

fn create_table_ix(authority: &Pubkey, table_id: u64) -> (Instruction, Pubkey, Pubkey) {
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &card_flex::id()).0;
    let config = pda(&[TABLE_SEED, authority.as_ref(), &table_id.to_le_bytes()]);
    let runtime = pda(&[RUNTIME_SEED, config.as_ref()]);
    let ix = Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::CreateTable {
            table_id,
            max_seats: 6,
        }
        .data(),
        card_flex::accounts::CreateTable {
            config,
            runtime,
            hand_log: pda(&[HAND_LOG_SEED, runtime.as_ref()]),
            vault: pda(&[VAULT_SEED, config.as_ref()]),
            authority: *authority,
            global: global_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    (ix, config, runtime)
}

fn configure_ix(authority: &Pubkey, config: Pubkey, runtime: Pubkey, rake_bps: u16) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::ConfigureTable {
            boot: 25_000,
            rake_bps,
            rake_cap: 10_000,
            refund_timeout_secs: 3_600,
        }
        .data(),
        card_flex::accounts::ConfigureTable {
            authority: *authority,
            config,
            runtime,
            global: global_address(),
        }
        .to_account_metas(None),
    )
}

#[test]
fn only_the_upgrade_authority_can_init_once() {
    let mut svm = svm();
    let admin = funded(&mut svm);
    let stranger = funded(&mut svm);
    set_upgrade_authority(&mut svm, &admin.pubkey());
    let e = send_one(
        &mut svm,
        init_global_ix(&stranger.pubkey(), stranger.pubkey(), 500),
        &[&stranger],
    )
    .unwrap_err();
    assert!(e.contains("NotUpgradeAuthority"), "{e}");
    let e = send_one(
        &mut svm,
        init_global_ix(&admin.pubkey(), admin.pubkey(), 1_001),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        e.contains("BadAmount"),
        "max rake above the program's 10% cap: {e}"
    );
    let treasury = Pubkey::new_unique();
    send_one(
        &mut svm,
        init_global_ix(&admin.pubkey(), treasury, 500),
        &[&admin],
    )
    .unwrap();
    let g = global(&svm);
    assert_eq!(
        (g.authority, g.treasury, g.max_rake_bps, g.paused),
        (admin.pubkey(), treasury, 500, false)
    );
    assert!(
        send_one(
            &mut svm,
            init_global_ix(&admin.pubkey(), admin.pubkey(), 100),
            &[&admin]
        )
        .is_err(),
        "only once"
    );
}

#[test]
fn only_the_global_authority_updates_and_pause_blocks_new_tables() {
    let mut svm = svm();
    let admin = setup_global(&mut svm);
    let stranger = funded(&mut svm);
    let e = send_one(
        &mut svm,
        update_ix(&stranger.pubkey(), stranger.pubkey(), 1_000, true),
        &[&stranger],
    )
    .unwrap_err();
    assert!(
        e.contains("ConstraintHasOne") || e.contains("has one"),
        "{e}"
    );
    let treasury = Pubkey::new_unique();
    send_one(
        &mut svm,
        update_ix(&admin.pubkey(), treasury, 300, true),
        &[&admin],
    )
    .unwrap();
    assert_eq!(
        (
            global(&svm).treasury,
            global(&svm).max_rake_bps,
            global(&svm).paused
        ),
        (treasury, 300, true)
    );
    let owner = funded(&mut svm);
    let (ix, _, _) = create_table_ix(&owner.pubkey(), 1);
    assert!(send_one(&mut svm, ix, &[&owner])
        .unwrap_err()
        .contains("Paused"));
    send_one(
        &mut svm,
        update_ix(&admin.pubkey(), treasury, 300, false),
        &[&admin],
    )
    .unwrap();
    let (ix, config, runtime) = create_table_ix(&owner.pubkey(), 1);
    send_one(&mut svm, ix, &[&owner]).unwrap();
    // Rake above the global cap (300) is refused; at the cap it's accepted.
    let e = send_one(
        &mut svm,
        configure_ix(&owner.pubkey(), config, runtime, 301),
        &[&owner],
    )
    .unwrap_err();
    assert!(e.contains("BadAmount"), "{e}");
    send_one(
        &mut svm,
        configure_ix(&owner.pubkey(), config, runtime, 300),
        &[&owner],
    )
    .unwrap();
}

fn sync_authority_ix(authority: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::SyncGlobalAuthority {}.data(),
        card_flex::accounts::SyncGlobalAuthority {
            authority: *authority,
            global: global_address(),
            program: card_flex::id(),
            program_data: program_data_address(),
        }
        .to_account_metas(None),
    )
}

/// CF-055: the settings follow the upgrade authority (Squads handover, CF-056).
#[test]
fn settings_authority_follows_the_upgrade_authority() {
    let mut svm = svm();
    let admin = setup_global(&mut svm);
    let multisig = funded(&mut svm);
    let stranger = funded(&mut svm);
    // Nobody but the current upgrade authority can take over the settings.
    for k in [&stranger, &multisig] {
        let e = send_one(&mut svm, sync_authority_ix(&k.pubkey()), &[k]).unwrap_err();
        assert!(e.contains("NotUpgradeAuthority"), "{e}");
    }
    assert_eq!(global(&svm).authority, admin.pubkey());
    // Upgrade authority moves to the multisig, which then syncs the settings.
    set_upgrade_authority(&mut svm, &multisig.pubkey());
    send_one(
        &mut svm,
        sync_authority_ix(&multisig.pubkey()),
        &[&multisig],
    )
    .unwrap();
    assert_eq!(global(&svm).authority, multisig.pubkey());
    // The old key has lost control; the new one has it.
    let e = send_one(
        &mut svm,
        update_ix(&admin.pubkey(), admin.pubkey(), 100, true),
        &[&admin],
    )
    .unwrap_err();
    assert!(
        e.contains("ConstraintHasOne") || e.contains("has one"),
        "{e}"
    );
    let treasury = Pubkey::new_unique();
    send_one(
        &mut svm,
        update_ix(&multisig.pubkey(), treasury, 100, false),
        &[&multisig],
    )
    .unwrap();
    assert_eq!(global(&svm).treasury, treasury);
}

fn buy_in_ix(config: Pubkey, seat: u8, amount: u64, wallet: &Pubkey) -> Instruction {
    let pda = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &card_flex::id()).0;
    Instruction::new_with_bytes(
        card_flex::id(),
        &card_flex::instruction::BuyIn {
            seat,
            amount,
            session_key: Pubkey::new_unique(),
        }
        .data(),
        card_flex::accounts::BuyIn {
            wallet: *wallet,
            config,
            vault: pda(&[VAULT_SEED, config.as_ref()]),
            ledger: pda(&[LEDGER_SEED, config.as_ref(), &[seat]]),
            global: global_address(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// CF-055: no buy-in before the table has terms; afterwards it works.
#[test]
fn buy_in_needs_a_configured_table() {
    let mut svm = svm();
    let _admin = setup_global(&mut svm);
    let owner = funded(&mut svm);
    let player = funded(&mut svm);
    let (ix, config, runtime) = create_table_ix(&owner.pubkey(), 7);
    send_one(&mut svm, ix, &[&owner]).unwrap();
    let e = send_one(
        &mut svm,
        buy_in_ix(config, 0, 1_000_000, &player.pubkey()),
        &[&player],
    )
    .unwrap_err();
    assert!(e.contains("NotConfigured"), "{e}");
    send_one(
        &mut svm,
        configure_ix(&owner.pubkey(), config, runtime, 100),
        &[&owner],
    )
    .unwrap();
    send_one(
        &mut svm,
        buy_in_ix(config, 0, 1_000_000, &player.pubkey()),
        &[&player],
    )
    .unwrap();
}
