//! Card Flex on-chain program.
//!
//! Contents:
//! - `ping`: proves the pinned toolchain builds, deploys and runs (CF-001).
//! - Table (CF-006/007, `table.rs`): ADR 0002 account layout, permissions,
//!   Side Show readers, session rotation.
//! - Fairness (CF-009..011): salt round, MagicBlock VRF, shuffle, deal and
//!   Merkle commitment per CF-Fairness v2.
//! - `poc_deal`: P1 test deck, only with the `poc-test-deck` feature.
//!
//! The CF-004 `probe_*` scaffolding was removed after its results were
//! recorded (docs/findings/cf-004, cf-006-a1; last present in commit e017823).

pub mod table;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        structs::{
            EphemeralMembersArgs, Member, PERMISSION_SEED, TX_BALANCES_FLAG, TX_LOGS_FLAG,
            TX_MESSAGE_FLAG,
        },
    },
    anchor::ephemeral,
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    ephemeral_accounts::EphemeralAccount,
};

use table::*;

declare_id!("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");

/// Bumped whenever an on-chain account layout or instruction changes.
pub const PROTOCOL_VERSION: u16 = 0;

#[ephemeral]
#[program]
pub mod card_flex {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("card-flex protocol v{}", PROTOCOL_VERSION);
        Ok(())
    }

    // ---------- CF-006 table (base layer) ----------

    /// Creates `TableConfig` and `TableRuntime` and pre-funds the runtime
    /// with the ephemeral rent it will spend inside PER.
    /// Creates the program-wide settings once (ADR 0005). Only the program's
    /// upgrade authority can sign it.
    pub fn init_global(
        ctx: Context<InitGlobal>,
        treasury: Pubkey,
        max_rake_bps: u16,
    ) -> Result<()> {
        require!(max_rake_bps <= MAX_RAKE_BPS, CardFlexError::BadAmount);
        let g = &mut ctx.accounts.global;
        g.authority = ctx.accounts.authority.key();
        g.treasury = treasury;
        g.max_rake_bps = max_rake_bps;
        g.paused = false;
        g.bump = ctx.bumps.global;
        Ok(())
    }

    /// Changes treasury, rake cap or pause. A lower rake cap applies to
    /// tables configured afterwards; pausing never blocks withdrawals.
    pub fn update_global(
        ctx: Context<UpdateGlobal>,
        treasury: Pubkey,
        max_rake_bps: u16,
        paused: bool,
    ) -> Result<()> {
        require!(max_rake_bps <= MAX_RAKE_BPS, CardFlexError::BadAmount);
        let g = &mut ctx.accounts.global;
        g.treasury = treasury;
        g.max_rake_bps = max_rake_bps;
        g.paused = paused;
        Ok(())
    }

    /// CF-055: makes the program's CURRENT upgrade authority the settings
    /// authority. Without it `GlobalConfig.authority` could never change, so
    /// moving control to a Squads multisig (CF-056) was impossible. The
    /// handover is: `solana program set-upgrade-authority` to the multisig,
    /// then the multisig sends this once. Only that key can sign it.
    pub fn sync_global_authority(ctx: Context<SyncGlobalAuthority>) -> Result<()> {
        ctx.accounts.global.authority = ctx.accounts.authority.key();
        Ok(())
    }

    pub fn create_table(ctx: Context<CreateTable>, table_id: u64, max_seats: u8) -> Result<()> {
        require!(!ctx.accounts.global.paused, CardFlexError::Paused);
        require!(
            (2..=MAX_SEATS as u8).contains(&max_seats),
            CardFlexError::BadSeat
        );
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.runtime.to_account_info(),
                },
            ),
            ephemeral_budget(),
        )?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.table_id = table_id;
        config.max_seats = max_seats;
        config.runtime = ctx.accounts.runtime.key();
        config.bump = ctx.bumps.config;
        config.status = status::ACTIVE;
        config.refund_timeout_secs = REFUND_TIMEOUT_DEFAULT_SECS;
        // A payout below the rent-exempt minimum could fail for an empty
        // wallet, so stacks never start below it (security review).
        config.min_buy_in = Rent::get()?.minimum_balance(0);
        config.max_buy_in = u64::MAX;
        config.last_sync_time = Clock::get()?.unix_timestamp;
        config.vault_bump = ctx.bumps.vault;
        let runtime = &mut ctx.accounts.runtime;
        runtime.config = config.key();
        runtime.authority = config.authority;
        runtime.max_seats = max_seats;
        runtime.button = max_seats - 1;
        runtime.bump = ctx.bumps.runtime;
        let hand_log = &mut ctx.accounts.hand_log;
        hand_log.runtime = runtime.key();
        hand_log.config = config.key();
        hand_log.bump = ctx.bumps.hand_log;
        Ok(())
    }

    // ---------- CF-013 money skeleton and recovery (ADR 0004) ----------

    /// Sets buy-in limits and the refund timeout. Only before anyone has
    /// bought in, so players always see the terms they joined under.
    pub fn configure_table(
        ctx: Context<ConfigureTable>,
        boot: u64,
        rake_bps: u16,
        rake_cap: u64,
        refund_timeout_secs: u32,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(config.seated == 0, CardFlexError::TableLocked);
        require!(boot > 0, CardFlexError::BadAmount);
        require!(
            rake_bps <= MAX_RAKE_BPS && rake_bps <= ctx.accounts.global.max_rake_bps,
            CardFlexError::BadAmount
        );
        require!(
            (REFUND_TIMEOUT_MIN_SECS..=REFUND_TIMEOUT_MAX_SECS).contains(&refund_timeout_secs),
            CardFlexError::BadTimeout
        );
        // Rules v1 §6: 40–200 boots, never below the rent-exempt minimum.
        let min_buy_in = boot
            .checked_mul(MIN_BUY_IN_BOOTS)
            .ok_or(CardFlexError::Overflow)?
            .max(Rent::get()?.minimum_balance(0));
        let max_buy_in = boot
            .checked_mul(MAX_BUY_IN_BOOTS)
            .ok_or(CardFlexError::Overflow)?;
        require!(min_buy_in <= max_buy_in, CardFlexError::BadAmount);
        config.min_buy_in = min_buy_in;
        config.max_buy_in = max_buy_in;
        config.refund_timeout_secs = refund_timeout_secs;
        let runtime = &mut ctx.accounts.runtime;
        runtime.boot = boot;
        runtime.rake_bps = rake_bps;
        runtime.rake_cap = rake_cap;
        Ok(())
    }

    /// A wallet takes a seat and moves its buy-in into the table vault.
    /// Base layer, before delegation (the runtime must still be owned by this
    /// program, which Anchor checks). P6 adds re-buys and cash-out.
    pub fn buy_in(ctx: Context<BuyIn>, seat: u8, amount: u64, session_key: Pubkey) -> Result<()> {
        require!(!ctx.accounts.global.paused, CardFlexError::Paused);
        let config = &mut ctx.accounts.config;
        let wallet = ctx.accounts.wallet.key();
        require!(
            config.status == status::ACTIVE,
            CardFlexError::TableNotActive
        );
        // CF-055: no buy-in before `configure_table` set the terms (it is
        // refused once anyone has bought in, so the table would be stuck).
        require!(config.max_buy_in != u64::MAX, CardFlexError::NotConfigured);
        require!(seat < config.max_seats, CardFlexError::BadSeat);
        require!(
            amount >= config.min_buy_in && amount <= config.max_buy_in,
            CardFlexError::BadAmount
        );
        // One seat per wallet (ledger init already refuses a taken seat).
        let seated_wallets: Vec<Pubkey> = (0..MAX_SEATS)
            .filter(|&i| config.seated & (1 << i) != 0)
            .map(|i| config.wallets[i])
            .collect();
        require!(!seated_wallets.contains(&wallet), CardFlexError::SeatTaken);
        // Session key: the checks the base layer can make; `join_seat`
        // repeats the full check against the live runtime.
        let config_key = config.key();
        require!(
            session_key != Pubkey::default()
                && session_key != wallet
                && session_key != config.authority
                && session_key != config_key
                && session_key != config.runtime
                && session_key != ctx.accounts.vault.key()
                && !seated_wallets.contains(&session_key)
                && !(0..MAX_SEATS).any(|i| {
                    config.seated & (1 << i) != 0
                        && (config.sessions[i] == session_key || config.sessions[i] == wallet)
                }),
            CardFlexError::BadSessionKey
        );
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.wallet.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )?;
        let epoch = config.seat_epochs[seat as usize]
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        config.seat_epochs[seat as usize] = epoch;
        config.wallets[seat as usize] = wallet;
        config.sessions[seat as usize] = session_key;
        config.seated |= 1 << seat;
        let ledger = &mut ctx.accounts.ledger;
        ledger.config = config_key;
        ledger.seat = seat;
        ledger.wallet = wallet;
        ledger.buy_in = amount;
        ledger.synced_stack = amount;
        ledger.bump = ctx.bumps.ledger;
        ledger.epoch = epoch;
        ledger.session_key = session_key;
        ledger.left = false;
        Ok(())
    }

    /// Seats a bought-in ledger (ADR 0005 decision 2). Permissionless: the
    /// ledger alone decides who sits and with what. Between hands only.
    pub fn join_seat(ctx: Context<JoinSeat>, seat: u8) -> Result<()> {
        let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
        let (runtime_key, config, bump, session, members, locked) = {
            let runtime = &mut ctx.accounts.runtime;
            let ledger = &ctx.accounts.ledger;
            require!(runtime.phase == phase::IDLE, CardFlexError::WrongPhase);
            require!(seat < runtime.max_seats, CardFlexError::BadSeat);
            require!(
                runtime.occupied & (1 << seat) == 0,
                CardFlexError::SeatTaken
            );
            require_keys_eq!(ledger.config, runtime.config, CardFlexError::BadLedger);
            require!(
                // A newer sit-down than the runtime has seen. The ledger of a
                // live or not yet cashed-out sit-down has epoch == seat_epoch,
                // so it can never join twice; epochs skipped by a cancelled
                // buy-in are fine. synced_stack == buy_in: never synced or
                // refunded (a claimed ledger is zeroed).
                ledger.epoch > runtime.seat_epoch[seat as usize]
                    && !ledger.left
                    && ledger.synced_stack == ledger.buy_in
                    && ledger.buy_in > 0,
                CardFlexError::BadLedger
            );
            let runtime_key = runtime.key();
            let config = runtime.config;
            require!(
                !runtime
                    .seated()
                    .any(|i| runtime.wallets[i] == ledger.wallet),
                CardFlexError::SeatTaken
            );
            require!(
                runtime.is_valid_new_session(
                    &ledger.session_key,
                    &runtime_key,
                    &config,
                    &ledger.wallet
                ),
                CardFlexError::BadSessionKey
            );
            let s = seat as usize;
            runtime.wallets[s] = ledger.wallet;
            runtime.session_keys[s] = ledger.session_key;
            runtime.stacks[s] = ledger.synced_stack;
            runtime.seat_epoch[s] = ledger.epoch;
            runtime.occupied |= 1 << seat;
            runtime.departed &= !(1 << seat);
            runtime.missed_salts[s] = 0;
            let mut members = vec![Member {
                flags,
                pubkey: runtime.authority,
            }];
            members.extend(runtime.seated().map(|i| Member {
                flags,
                pubkey: runtime.session_keys[i],
            }));
            (
                runtime_key,
                config,
                runtime.bump,
                ledger.session_key,
                members,
                runtime.locked,
            )
        };
        if !locked {
            return Ok(()); // base layer, before permissions exist
        }
        let a = &ctx.accounts;
        let (hand, hand_perm, rt_perm, perm_prog, vault, magic) = (
            need(&a.hand)?,
            need(&a.hand_permission)?,
            need(&a.runtime_permission)?,
            need(&a.permission_program)?,
            need(&a.ephemeral_vault)?,
            need(&a.magic_program)?,
        );
        let (hand_pda, hand_bump) = Pubkey::find_program_address(
            &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
            &crate::ID,
        );
        let perm_of = |k: &Pubkey| {
            Pubkey::find_program_address(&[PERMISSION_SEED, k.as_ref()], &PERMISSION_PROGRAM_ID).0
        };
        require_keys_eq!(hand.key(), hand_pda, CardFlexError::BadSeatHand);
        require_keys_eq!(
            hand_perm.key(),
            perm_of(&hand_pda),
            CardFlexError::BadSeatHand
        );
        require_keys_eq!(
            rt_perm.key(),
            perm_of(&runtime_key),
            CardFlexError::BadSeatHand
        );
        require_keys_eq!(
            perm_prog.key(),
            PERMISSION_PROGRAM_ID,
            CardFlexError::BadSeatHand
        );
        require_keys_eq!(vault.key(), EPHEMERAL_VAULT_ID, CardFlexError::BadSeatHand);
        require_keys_eq!(magic.key(), MAGIC_PROGRAM_ID, CardFlexError::BadSeatHand);
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, config.as_ref(), &[bump]];
        let hand_seeds: &[&[u8]] = &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat], &[hand_bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        UpdateEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: hand.clone(),
            permission: hand_perm,
            vault: vault.clone(),
            magic_program: magic.clone(),
            permission_program: perm_prog.clone(),
            authority: hand,
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags,
                    pubkey: session,
                }],
            },
        }
        .invoke_signed(&[runtime_seeds, hand_seeds])?;
        UpdateEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: runtime_info.clone(),
            permission: rt_perm,
            vault,
            magic_program: magic,
            permission_program: perm_prog,
            authority: runtime_info,
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: true,
                members,
            },
        }
        .invoke_signed(&[runtime_seeds])?;
        Ok(())
    }

    /// A player asks to leave (ADR 0005 decision 3), signed by the seat's
    /// session key or wallet. Between hands it applies at once; during a hand
    /// the player finishes it and `next_hand` applies it.
    pub fn leave_seat(ctx: Context<LeaveSeat>, seat: u8) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        let s = seat as usize;
        require!(seat < runtime.max_seats, CardFlexError::BadSeat);
        require!(
            runtime.occupied & (1 << seat) != 0,
            CardFlexError::SeatEmpty
        );
        let signer = ctx.accounts.signer.key();
        require!(
            signer == runtime.session_keys[s] || signer == runtime.wallets[s],
            CardFlexError::NotSeatOwner
        );
        runtime.leaving |= 1 << seat;
        if runtime.phase == phase::IDLE {
            apply_leaves(runtime);
        }
        Ok(())
    }

    /// Pays a seat that has left (ADR 0005 decision 4): its `synced_stack`,
    /// set by `sync_hand` from the committed runtime, to the wallet recorded
    /// at buy-in. Closes the ledger, so it can't be paid twice. Anyone may
    /// submit it; it works while paused and after a refund.
    pub fn cash_out(ctx: Context<CashOut>, seat: u8) -> Result<()> {
        require!(ctx.accounts.ledger.left, CardFlexError::NotLeft);
        let pay = ctx.accounts.ledger.synced_stack;
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports() >= rent_floor.saturating_add(pay),
            CardFlexError::VaultShort
        );
        ctx.accounts.ledger.synced_stack = 0;
        **vault_info.try_borrow_mut_lamports()? -= pay;
        **ctx.accounts.wallet.try_borrow_mut_lamports()? += pay;
        let config = &mut ctx.accounts.config;
        config.seated &= !(1 << seat);
        config.wallets[seat as usize] = Pubkey::default();
        config.sessions[seat as usize] = Pubkey::default();
        Ok(())
    }

    /// Reconciles the vault (ADR 0005 decision 8, PRD §10.4.1):
    /// `vault = rent-exempt minimum + Σ synced_stack + (synced_rake − rake_swept)`.
    /// Fails if the vault holds less (insolvent). `strict` also fails on any
    /// surplus (lamports sent straight to the vault). Read-only; anyone.
    pub fn check_vault(ctx: Context<CheckVault>, strict: bool) -> Result<()> {
        let config = &ctx.accounts.config;
        let config_key = config.key();
        let seats: Vec<u8> = (0..MAX_SEATS as u8)
            .filter(|s| config.seated & (1 << s) != 0)
            .collect();
        require!(
            ctx.remaining_accounts.len() == seats.len(),
            CardFlexError::BadLedger
        );
        let mut owed: u64 = 0;
        for (&seat, acc) in seats.iter().zip(ctx.remaining_accounts) {
            let (pda, _) = Pubkey::find_program_address(
                &[LEDGER_SEED, config_key.as_ref(), &[seat]],
                &crate::ID,
            );
            require_keys_eq!(acc.key(), pda, CardFlexError::BadLedger);
            let ledger: Account<SeatLedger> = Account::try_from(acc)?;
            owed = owed
                .checked_add(ledger.synced_stack)
                .ok_or(CardFlexError::Overflow)?;
        }
        let rake = config
            .synced_rake
            .checked_sub(config.rake_swept)
            .ok_or(CardFlexError::Overflow)?;
        let vault_info = ctx.accounts.vault.to_account_info();
        let expected = Rent::get()?
            .minimum_balance(vault_info.data_len())
            .checked_add(owed)
            .and_then(|x| x.checked_add(rake))
            .ok_or(CardFlexError::Overflow)?;
        let have = vault_info.lamports();
        require!(have >= expected, CardFlexError::VaultShort);
        require!(!strict || have == expected, CardFlexError::VaultSurplus);
        Ok(())
    }

    /// Pays rake to the treasury (ADR 0005 decision 6): only rake of hands
    /// that were committed and synced (`synced_rake`), each lamport once.
    /// Permissionless; allowed while paused and after a refund.
    pub fn sweep_rake(ctx: Context<SweepRake>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let pay = config
            .synced_rake
            .checked_sub(config.rake_swept)
            .ok_or(CardFlexError::Overflow)?;
        require!(pay > 0, CardFlexError::NothingToClaim);
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports() >= rent_floor.saturating_add(pay),
            CardFlexError::VaultShort
        );
        config.rake_swept = config.synced_rake;
        **vault_info.try_borrow_mut_lamports()? -= pay;
        **ctx.accounts.treasury.try_borrow_mut_lamports()? += pay;
        Ok(())
    }

    /// Refunds a buy-in that never joined (ADR 0005). Only while the runtime
    /// is on the base layer and owned by this program: then the base copy is
    /// the truth, and no join in PER can race the refund, and only if the
    /// table was never delegated. Signed by the recorded wallet (no one else
    /// can cancel a player's buy-in); closes the ledger.
    pub fn cancel_buy_in(ctx: Context<CancelBuyIn>, seat: u8) -> Result<()> {
        // Once delegated, PER may hold a clone of this ledger and seat it
        // later even after the base account is closed (stale clone): never.
        require!(
            !ctx.accounts.config.ever_delegated,
            CardFlexError::TableLocked
        );
        let runtime = &ctx.accounts.runtime;
        require!(
            runtime.seat_epoch[seat as usize] < ctx.accounts.ledger.epoch,
            CardFlexError::SeatTaken
        );
        let pay = ctx.accounts.ledger.synced_stack;
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports() >= rent_floor.saturating_add(pay),
            CardFlexError::VaultShort
        );
        ctx.accounts.ledger.synced_stack = 0;
        **vault_info.try_borrow_mut_lamports()? -= pay;
        **ctx.accounts.wallet.try_borrow_mut_lamports()? += pay;
        let config = &mut ctx.accounts.config;
        config.seated &= !(1 << seat);
        config.wallets[seat as usize] = Pubkey::default();
        config.sessions[seat as usize] = Pubkey::default();
        Ok(())
    }

    /// Commits `TableRuntime` and `HandLog` to the base layer without
    /// undelegating. Anyone may call it (keeper heartbeat / end of hand).
    pub fn commit_hand(ctx: Context<CommitHand>) -> Result<()> {
        ctx.accounts.runtime.commit_seq = ctx
            .accounts
            .runtime
            .commit_seq
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        ctx.accounts.runtime.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[
            ctx.accounts.runtime.to_account_info(),
            ctx.accounts.hand_log.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }

    /// Accepts newer committed runtime state (ADR 0004 rule 4): refreshes
    /// the liveness clock, and between hands copies stacks into the ledgers.
    pub fn sync_hand(ctx: Context<SyncHand>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.status == status::ACTIVE,
            CardFlexError::TableNotActive
        );
        let config_key = config.key();
        let rt_info = &ctx.accounts.runtime;
        let (expected, _) =
            Pubkey::find_program_address(&[RUNTIME_SEED, config_key.as_ref()], &crate::ID);
        require_keys_eq!(rt_info.key(), expected, CardFlexError::BadRuntime);
        let delegation_program = ephemeral_rollups_sdk::id();
        if *rt_info.owner == delegation_program {
            let (record, _) = Pubkey::find_program_address(
                &[b"delegation", rt_info.key().as_ref()],
                &delegation_program,
            );
            let rec = &ctx.accounts.delegation_record;
            require_keys_eq!(rec.key(), record, CardFlexError::BadRuntime);
            require_keys_eq!(*rec.owner, delegation_program, CardFlexError::BadRuntime);
            let d = rec.try_borrow_data()?;
            require!(d.len() >= 72, CardFlexError::BadRuntime);
            require!(
                allowed_validator(&config.validator)
                    && d[8..40] == config.validator.to_bytes()
                    && d[40..72] == crate::ID.to_bytes(),
                CardFlexError::BadRuntime
            );
        } else {
            require_keys_eq!(*rt_info.owner, crate::ID, CardFlexError::BadRuntime);
        }
        let rt = Box::new(TableRuntime::try_deserialize(
            &mut &rt_info.try_borrow_data()?[..],
        )?);
        require_keys_eq!(rt.config, config_key, CardFlexError::BadRuntime);
        require!(
            rt.commit_seq > config.last_synced_seq,
            CardFlexError::StaleCommit
        );
        config.last_synced_seq = rt.commit_seq;
        config.last_sync_time = Clock::get()?.unix_timestamp;

        // Stacks only between hands, so unfinished bets never become payable.
        if !matches!(rt.phase, phase::IDLE | phase::REVEALED | phase::POC_DONE) {
            return Ok(());
        }
        // CF-033: rake of settled hands. It only ever grows.
        require!(rt.rake_owed >= config.synced_rake, CardFlexError::BadStacks);
        config.synced_rake = rt.rake_owed;
        let seats: Vec<u8> = (0..MAX_SEATS as u8)
            .filter(|s| config.seated & (1 << s) != 0)
            .collect();
        require!(
            ctx.remaining_accounts.len() == seats.len(),
            CardFlexError::BadLedger
        );
        for (&seat, acc) in seats.iter().zip(ctx.remaining_accounts) {
            let (pda, _) = Pubkey::find_program_address(
                &[LEDGER_SEED, config_key.as_ref(), &[seat]],
                &crate::ID,
            );
            require_keys_eq!(acc.key(), pda, CardFlexError::BadLedger);
            let mut ledger: Account<SeatLedger> = Account::try_from(acc)?;
            // ADR 0005: only the sit-down this ledger belongs to. A ledger
            // that hasn't joined yet keeps its buy-in.
            let bit = 1u8 << seat;
            if rt.seat_epoch[seat as usize] == ledger.epoch
                && (rt.occupied | rt.departed) & bit != 0
                && !ledger.left
            {
                ledger.synced_stack = rt.stacks[seat as usize];
                // CF-032: the committed runtime shows this sit-down left; its
                // stack is final and may now be cashed out.
                ledger.left = rt.departed & bit != 0;
                ledger.exit(&crate::ID)?;
            }
        }
        Ok(())
    }

    /// ADR 0004 rule 5: after `refund_timeout_secs` without an accepted
    /// sync, anyone switches the table to REFUNDED. No cooperation from PER
    /// or the operator. Payouts are then claimed per seat (`claim_refund`).
    pub fn emergency_refund(ctx: Context<EmergencyRefund>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        require!(
            config.status == status::ACTIVE,
            CardFlexError::TableNotActive
        );
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= config
                .last_sync_time
                .saturating_add(config.refund_timeout_secs as i64),
            CardFlexError::TooEarly
        );
        config.status = status::REFUNDED;
        Ok(())
    }

    /// Pays one seat its last synced stack after `emergency_refund`, to the
    /// wallet recorded at buy-in. Anyone may call it; each seat is
    /// independent, so one failing payout can't lock the others.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        require!(
            ctx.accounts.config.status == status::REFUNDED,
            CardFlexError::TableNotActive
        );
        let ledger = &mut ctx.accounts.ledger;
        let pay = ledger.synced_stack;
        require!(pay > 0, CardFlexError::NothingToClaim);
        let vault_info = ctx.accounts.vault.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(vault_info.data_len());
        require!(
            vault_info.lamports() >= rent_floor.saturating_add(pay),
            CardFlexError::VaultShort
        );
        ledger.synced_stack = 0;
        **vault_info.try_borrow_mut_lamports()? -= pay;
        **ctx.accounts.wallet.try_borrow_mut_lamports()? += pay;
        Ok(())
    }

    /// Delegates `TableRuntime` to the TEE validator. Never auto-commits
    /// (ADR 0002 rule 1).
    pub fn delegate_table(ctx: Context<DelegateTable>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        let config_key = ctx.accounts.config.key();
        ctx.accounts.delegate_runtime(
            &ctx.accounts.authority,
            &[RUNTIME_SEED, config_key.as_ref()],
            DelegateConfig {
                commit_frequency_ms: u32::MAX,
                validator,
            },
        )?;
        // ADR 0004 + security review: only MagicBlock's TEE validator, and the
        // validator never changes once recorded.
        let v = validator.ok_or(CardFlexError::ValidatorRequired)?;
        require!(allowed_validator(&v), CardFlexError::ValidatorNotAllowed);
        let recorded = ctx.accounts.config.validator;
        require!(
            recorded == Pubkey::default() || recorded == v,
            CardFlexError::ValidatorNotAllowed
        );
        ctx.accounts.config.validator = v;
        ctx.accounts.config.ever_delegated = true;
        let runtime_key = ctx.accounts.runtime.key();
        ctx.accounts.delegate_hand_log(
            &ctx.accounts.authority,
            &[HAND_LOG_SEED, runtime_key.as_ref()],
            DelegateConfig {
                commit_frequency_ms: u32::MAX,
                validator,
            },
        )?;
        Ok(())
    }

    // ---------- CF-006 table (PER) ----------

    /// Makes `TableRuntime` readable only by the table authority and the
    /// seated session keys.
    pub fn open_runtime_permission(ctx: Context<TablePer>) -> Result<()> {
        // Seating closes here, so the reader lists can't go stale.
        ctx.accounts.runtime.locked = true;
        let runtime = &ctx.accounts.runtime;
        require_keys_eq!(
            ctx.accounts.target.key(),
            runtime.key(),
            CardFlexError::BadDealer
        );
        let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
        let mut members = vec![Member {
            flags,
            pubkey: runtime.authority,
        }];
        members.extend(runtime.seated().map(|i| Member {
            flags,
            pubkey: runtime.session_keys[i],
        }));
        let seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
        create_permission(
            ctx.accounts,
            &ctx.accounts.runtime.to_account_info(),
            members,
            &[seeds],
        )
    }

    /// Creates the ephemeral `DealerState`. Its only permission member is the
    /// `TableRuntime` PDA, which can't sign, so no one can read it.
    pub fn open_dealer(ctx: Context<TablePer>) -> Result<()> {
        require!(
            !ctx.accounts.runtime.hand_in_progress(),
            CardFlexError::HandInProgress
        );
        let runtime_key = ctx.accounts.runtime.key();
        let (dealer, dealer_bump) =
            Pubkey::find_program_address(&[DEALER_SEED, runtime_key.as_ref()], &crate::ID);
        require_keys_eq!(ctx.accounts.target.key(), dealer, CardFlexError::BadDealer);
        let runtime_seeds: &[&[u8]] = &[
            RUNTIME_SEED,
            ctx.accounts.runtime.config.as_ref(),
            &[ctx.accounts.runtime.bump],
        ];
        let dealer_seeds: &[&[u8]] = &[DEALER_SEED, runtime_key.as_ref(), &[dealer_bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        EphemeralAccount::new(
            &runtime_info,
            &ctx.accounts.target,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[runtime_seeds, dealer_seeds])
        .create(DEALER_LEN)?;
        {
            let mut data = ctx.accounts.target.try_borrow_mut_data()?;
            data[..8].copy_from_slice(DEALER_TAG);
            data[8..40].copy_from_slice(runtime_key.as_ref());
        }
        let members = vec![Member {
            flags: 0,
            pubkey: runtime_key,
        }];
        create_permission(
            ctx.accounts,
            &ctx.accounts.target.to_account_info(),
            members,
            &[runtime_seeds, dealer_seeds],
        )
    }

    /// Creates the ephemeral `SeatHand` for an occupied seat, readable only by
    /// that seat's session key.
    pub fn open_seat_hand(ctx: Context<TablePer>, seat: u8) -> Result<()> {
        require!(
            !ctx.accounts.runtime.hand_in_progress(),
            CardFlexError::HandInProgress
        );
        let runtime = &ctx.accounts.runtime;
        require!(seat < runtime.max_seats, CardFlexError::BadSeat);
        // Empty seats too (ADR 0005): their reader is the default key, which
        // nobody holds; `join_seat` swaps in the new player's session key.
        let runtime_key = runtime.key();
        let (hand, hand_bump) = Pubkey::find_program_address(
            &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
            &crate::ID,
        );
        require_keys_eq!(ctx.accounts.target.key(), hand, CardFlexError::BadSeatHand);
        let reader = runtime.session_keys[seat as usize];
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
        let hand_seeds: &[&[u8]] = &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat], &[hand_bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        EphemeralAccount::new(
            &runtime_info,
            &ctx.accounts.target,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[runtime_seeds, hand_seeds])
        .create(SEAT_HAND_LEN)?;
        {
            let mut data = ctx.accounts.target.try_borrow_mut_data()?;
            data[..8].copy_from_slice(SEAT_HAND_TAG);
            data[8..40].copy_from_slice(runtime_key.as_ref());
            data[40] = seat;
        }
        let members = vec![Member {
            flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
            pubkey: reader,
        }];
        create_permission(
            ctx.accounts,
            &ctx.accounts.target.to_account_info(),
            members,
            &[runtime_seeds, hand_seeds],
        )?;
        // CF-053: a re-created hand (lost state) has its owner as the only
        // reader, so any Side Show grant recorded for it is gone.
        ctx.accounts.runtime.grants &= !(1 << seat);
        Ok(())
    }

    /// Resets a seat hand's reader list to its own session key (CF-007).
    /// Revoke only since CF-022: grants come only from an accepted Side Show
    /// (`side_show_view`), never from the operator or a player's choice.
    pub fn set_hand_readers(
        ctx: Context<SetHandReaders>,
        seat: u8,
        readers: Vec<Pubkey>,
    ) -> Result<()> {
        let runtime = &ctx.accounts.runtime;
        require!(
            runtime.occupied & (1 << seat) != 0,
            CardFlexError::SeatEmpty
        );
        let own = runtime.session_keys[seat as usize];
        require!(
            readers.len() == 1 && readers[0] == own,
            CardFlexError::BadReaders
        );
        ctx.accounts.runtime.grants &= !(1 << seat);
        let a = &ctx.accounts;
        update_hand_readers(
            &a.runtime,
            seat,
            &a.target,
            &a.permission,
            &a.ephemeral_vault,
            &a.magic_program,
            &a.permission_program,
            readers,
        )
    }

    /// CF-022: Side Show view. `grant`: after an accepted Side Show between
    /// `seat_a` and `seat_b` in the current hand, each may read the other's
    /// hand (reader list = own session + this hand's Side Show opponents).
    /// Only the game can create the pair, so neither the operator nor a
    /// player can choose a viewer. `!grant`: once the hand is no longer being
    /// played, reset both lists to the owner only (needed before the next
    /// `start_hand`). Permissionless: anyone may crank it.
    pub fn side_show_view(
        ctx: Context<SideShowView>,
        seat_a: u8,
        seat_b: u8,
        grant: bool,
    ) -> Result<()> {
        let runtime = &ctx.accounts.runtime;
        require!(
            seat_a != seat_b
                && (seat_a as usize) < MAX_SEATS
                && (seat_b as usize) < MAX_SEATS
                && runtime.occupied & (1 << seat_a) != 0
                && runtime.occupied & (1 << seat_b) != 0,
            CardFlexError::BadReaders
        );
        let readers_of = |s: u8| -> Vec<Pubkey> {
            let mut v = vec![runtime.session_keys[s as usize]];
            if grant {
                let viewers = runtime.side_show_viewers[s as usize];
                v.extend(
                    (0..MAX_SEATS)
                        .filter(|j| viewers & (1 << j) != 0)
                        .map(|j| runtime.session_keys[j]),
                );
            }
            v
        };
        if grant {
            require!(
                runtime.phase == phase::DEALT
                    && runtime.side_show_hand_no == runtime.hand_no
                    && runtime.side_show_viewers[seat_a as usize] & (1 << seat_b) != 0,
                CardFlexError::NoSideShowPending
            );
        } else {
            require!(runtime.phase != phase::DEALT, CardFlexError::WrongPhase);
        }
        let (ra, rb) = (readers_of(seat_a), readers_of(seat_b));
        let bits = (1u8 << seat_a) | (1u8 << seat_b);
        let a = &ctx.accounts;
        update_hand_readers(
            &a.runtime,
            seat_a,
            &a.hand_a,
            &a.permission_a,
            &a.ephemeral_vault,
            &a.magic_program,
            &a.permission_program,
            ra,
        )?;
        update_hand_readers(
            &a.runtime,
            seat_b,
            &a.hand_b,
            &a.permission_b,
            &a.ephemeral_vault,
            &a.magic_program,
            &a.permission_program,
            rb,
        )?;
        let runtime = &mut ctx.accounts.runtime;
        if grant {
            runtime.grants |= bits;
        } else {
            runtime.grants &= !bits;
        }
        Ok(())
    }

    /// The seat's wallet replaces its session key (e.g. a lost or expired
    /// key). Rebuilds the seat hand's reader list and the runtime's member list
    /// so the old key loses access at once.
    pub fn rotate_session(
        ctx: Context<RotateSession>,
        seat: u8,
        new_session: Pubkey,
    ) -> Result<()> {
        let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
        // Update state in a scope so the mutable borrow ends before the CPIs.
        let (runtime_key, config, bump, runtime_members) = {
            let runtime = &mut ctx.accounts.runtime;
            require!(seat < runtime.max_seats, CardFlexError::BadSeat);
            require!(
                runtime.occupied & (1 << seat) != 0,
                CardFlexError::SeatEmpty
            );
            require_keys_eq!(
                runtime.wallets[seat as usize],
                ctx.accounts.wallet.key(),
                CardFlexError::NotSeatOwner
            );
            let runtime_key = runtime.key();
            let config = runtime.config;
            let wallet = ctx.accounts.wallet.key();
            require!(
                runtime.is_valid_new_session(&new_session, &runtime_key, &config, &wallet),
                CardFlexError::BadSessionKey
            );
            // The old key may hold a Side Show grant on another hand; rotating
            // now would leave it readable (security review). Revoke first.
            require!(runtime.grants == 0, CardFlexError::GrantActive);
            runtime.session_keys[seat as usize] = new_session;
            let mut members = vec![Member {
                flags,
                pubkey: runtime.authority,
            }];
            members.extend(runtime.seated().map(|i| Member {
                flags,
                pubkey: runtime.session_keys[i],
            }));
            (runtime.key(), runtime.config, runtime.bump, members)
        };
        let (hand, hand_bump) = Pubkey::find_program_address(
            &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
            &crate::ID,
        );
        require_keys_eq!(ctx.accounts.hand.key(), hand, CardFlexError::BadSeatHand);
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, config.as_ref(), &[bump]];
        let hand_seeds: &[&[u8]] = &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat], &[hand_bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();

        UpdateEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: ctx.accounts.hand.to_account_info(),
            permission: ctx.accounts.hand_permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.hand.to_account_info(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags,
                    pubkey: new_session,
                }],
            },
        }
        .invoke_signed(&[runtime_seeds, hand_seeds])?;
        UpdateEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: runtime_info.clone(),
            permission: ctx.accounts.runtime_permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: runtime_info.clone(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private: true,
                members: runtime_members,
            },
        }
        .invoke_signed(&[runtime_seeds])?;
        Ok(())
    }

    // ---------- CF-009 salt round (PER) ----------

    /// Creates the ephemeral `SaltAccount` for a seat. Its only permission
    /// member is the `TableRuntime` PDA, so nobody (not even the player) can
    /// read a salt back; only the program uses it (ADR 0002).
    pub fn open_salt(ctx: Context<TablePer>, seat: u8) -> Result<()> {
        require!(
            !ctx.accounts.runtime.hand_in_progress(),
            CardFlexError::HandInProgress
        );
        let runtime = &ctx.accounts.runtime;
        require!(seat < runtime.max_seats, CardFlexError::BadSeat);
        // Empty seats too (ADR 0005): the salt account has no human reader.
        let runtime_key = runtime.key();
        let (salt, salt_bump) =
            Pubkey::find_program_address(&[SALT_SEED, runtime_key.as_ref(), &[seat]], &crate::ID);
        require_keys_eq!(ctx.accounts.target.key(), salt, CardFlexError::BadSalt);
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
        let salt_seeds: &[&[u8]] = &[SALT_SEED, runtime_key.as_ref(), &[seat], &[salt_bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        EphemeralAccount::new(
            &runtime_info,
            &ctx.accounts.target,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[runtime_seeds, salt_seeds])
        .create(SALT_LEN)?;
        {
            let mut data = ctx.accounts.target.try_borrow_mut_data()?;
            data[..8].copy_from_slice(SALT_TAG);
            data[8..40].copy_from_slice(runtime_key.as_ref());
            data[40] = seat;
        }
        let members = vec![Member {
            flags: 0,
            pubkey: runtime_key,
        }];
        create_permission(
            ctx.accounts,
            &ctx.accounts.target.to_account_info(),
            members,
            &[runtime_seeds, salt_seeds],
        )
    }

    /// Starts the salt round: fixes the dealing order and roster and computes
    /// `hand_ctx` (CF-Fairness v2 spec §2). Dealing order: clockwise from the
    /// seat left of the button, seats with stack >= boot only (CF-024).
    pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
        let config_key = ctx.accounts.config.key();
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.locked, CardFlexError::TableNotLocked);
        require!(runtime.phase == phase::IDLE, CardFlexError::WrongPhase);
        require!(
            Clock::get()?.unix_timestamp >= runtime.last_hand_end.saturating_add(HAND_GAP_SECS),
            CardFlexError::TooEarly
        );
        // Security: a reader grant from the last hand must be revoked first,
        // or the old viewer could read this seat's new cards.
        require!(runtime.grants == 0, CardFlexError::GrantActive);
        // Rules v1 §1: a seat whose stack is below the boot isn't dealt in.
        // A table must be configured (boot set) before any hand.
        let boot = runtime.boot;
        require!(boot > 0, CardFlexError::BadAmount);
        let seats: Vec<fairness_core::Seat> = runtime
            .seated_from_button()
            .filter(|&i| runtime.stacks[i] >= boot)
            .map(|i| fairness_core::Seat {
                index: i as u8,
                wallet: runtime.wallets[i].to_bytes(),
            })
            .collect();
        require!(seats.len() >= 2, CardFlexError::NotEnoughPlayers);
        let roster = fairness_core::roster_hash::<SolSha256>(&seats);
        let ctx_hash = fairness_core::hand_ctx::<SolSha256>(&fairness_core::HandContext {
            program_id: crate::ID.to_bytes(),
            table: config_key.to_bytes(),
            hand_no: runtime.hand_no,
            roster_hash: roster,
            rules_version: RULES_VERSION,
        });
        runtime.dealing_order = [0; MAX_SEATS];
        for (k, s) in seats.iter().enumerate() {
            runtime.dealing_order[k] = s.index;
        }
        runtime.dealing_count = seats.len() as u8;
        runtime.roster_hash = roster;
        runtime.hand_ctx = ctx_hash;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
        runtime.phase = phase::SALTS_PENDING;
        runtime.salts_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(SALT_SECS)
            .ok_or(CardFlexError::Overflow)?;
        Ok(())
    }

    /// A seat's session key submits its secret salt once per hand. The salt
    /// goes to the private `SaltAccount`; only `c_i` (spec §3) is public.
    pub fn submit_salt(ctx: Context<SubmitSalt>, seat: u8, salt: [u8; 32]) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(
            runtime.phase == phase::SALTS_PENDING,
            CardFlexError::WrongPhase
        );
        require!(seat < runtime.max_seats, CardFlexError::BadSeat);
        require!(
            runtime.occupied & (1 << seat) != 0,
            CardFlexError::SeatEmpty
        );
        require_keys_eq!(
            runtime.session_keys[seat as usize],
            ctx.accounts.session.key(),
            CardFlexError::NotSeatOwner
        );
        require!(
            runtime.salts_in & (1 << seat) == 0,
            CardFlexError::SaltAlreadySubmitted
        );
        // Only dealt seats: a seated player who isn't dealt in (stack below
        // the boot) must not be able to stall the hand with a stray salt.
        require!(
            runtime.dealing_order[..runtime.dealing_count as usize].contains(&seat),
            CardFlexError::SeatEmpty
        );
        let runtime_key = runtime.key();
        let (expected, _) =
            Pubkey::find_program_address(&[SALT_SEED, runtime_key.as_ref(), &[seat]], &crate::ID);
        require_keys_eq!(ctx.accounts.salt.key(), expected, CardFlexError::BadSalt);
        {
            let mut data = ctx.accounts.salt.try_borrow_mut_data()?;
            require!(&data[..8] == SALT_TAG, CardFlexError::BadSalt);
            data[41..49].copy_from_slice(&runtime.hand_no.to_le_bytes());
            data[49..81].copy_from_slice(&salt);
        }
        runtime.salt_commitments[seat as usize] =
            fairness_core::salt_commitment::<SolSha256>(&runtime.hand_ctx, seat, &salt);
        runtime.salts_in |= 1 << seat;
        runtime.missed_salts[seat as usize] = 0;
        let all = runtime.dealing_order[..runtime.dealing_count as usize]
            .iter()
            .fold(0u8, |m, s| m | (1 << s));
        if runtime.salts_in == all {
            runtime.phase = phase::SALTS_DONE;
        }
        Ok(())
    }

    /// Closes a seat's `SaltAccount` and its permission (before undelegate).
    pub fn close_salt(ctx: Context<TablePer>, seat: u8) -> Result<()> {
        require!(
            !ctx.accounts.runtime.hand_in_progress(),
            CardFlexError::HandInProgress
        );
        let runtime = &ctx.accounts.runtime;
        let runtime_key = runtime.key();
        let (expected, bump) =
            Pubkey::find_program_address(&[SALT_SEED, runtime_key.as_ref(), &[seat]], &crate::ID);
        require_keys_eq!(ctx.accounts.target.key(), expected, CardFlexError::BadSalt);
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
        let salt_seeds: &[&[u8]] = &[SALT_SEED, runtime_key.as_ref(), &[seat], &[bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        CloseEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: ctx.accounts.target.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.target.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[runtime_seeds, salt_seeds])?;
        EphemeralAccount::new(
            &runtime_info,
            &ctx.accounts.target,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[runtime_seeds])
        .close()?;
        Ok(())
    }

    // ---------- CF-010 VRF (PER) ----------

    /// Requests MagicBlock VRF once every dealt seat has a salt. `caller_seed`
    /// = `vrf_caller_seed(hand_ctx, c_0..c_n)` (spec §3), computed here.
    pub fn request_shuffle(ctx: Context<RequestShuffle>) -> Result<()> {
        // Security review: only the queue MagicBlock serves for PER. Accepting
        // others (e.g. the test queue, never fulfilled on Devnet) would let
        // anyone stall the hand and force a cancellation.
        let queue = ctx.accounts.oracle_queue.key();
        require_keys_eq!(
            queue,
            ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE,
            CardFlexError::BadQueue
        );
        let runtime = &mut ctx.accounts.runtime;
        require!(
            runtime.phase == phase::SALTS_DONE,
            CardFlexError::WrongPhase
        );
        let order: Vec<u8> = runtime.dealing_order[..runtime.dealing_count as usize].to_vec();
        let commitments: Vec<[u8; 32]> = order
            .iter()
            .map(|&s| runtime.salt_commitments[s as usize])
            .collect();
        let caller_seed =
            fairness_core::vrf_caller_seed::<SolSha256>(&runtime.hand_ctx, &commitments);
        runtime.vrf_caller_seed = caller_seed;
        runtime.vrf_request_slot = Clock::get()?.slot;
        runtime.phase = phase::VRF_PENDING;
        let hand_no = runtime.hand_no;

        let runtime_key = runtime.key();
        let mut metas = vec![
            ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta {
                pubkey: runtime_key,
                is_signer: false,
                is_writable: true,
            },
            ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta {
                pubkey: ctx.accounts.dealer.key(),
                is_signer: false,
                is_writable: true,
            },
        ];
        for &s in &order {
            metas.push(ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta {
                pubkey: Pubkey::find_program_address(
                    &[SALT_SEED, runtime_key.as_ref(), &[s]],
                    &crate::ID,
                )
                .0,
                is_signer: false,
                is_writable: false,
            });
        }
        let ix = ephemeral_rollups_sdk::vrf::instructions::create_request_randomness_ix(
            ephemeral_rollups_sdk::vrf::instructions::RequestRandomnessParams {
                payer: ctx.accounts.payer.key(),
                oracle_queue: queue,
                callback_program_id: crate::ID,
                callback_discriminator: instruction::VrfDeal::DISCRIMINATOR.to_vec(),
                caller_seed,
                accounts_metas: Some(metas),
                // Echoed after `randomness` in the callback data: binds the
                // callback to this hand so a late one for a cancelled hand fails.
                callback_args: Some(hand_no.to_le_bytes().to_vec()),
            },
        );
        ctx.accounts
            .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
        Ok(())
    }

    /// VRF callback. Only the scoped VRF identity can call it, and only while
    /// the hand waits for randomness, so a second or stale fulfilment fails.
    /// Derives `seed` (spec §4) from the VRF output and every salt, and stores
    /// both in the private `DealerState`. The shuffle itself is CF-011.
    pub fn vrf_deal(ctx: Context<VrfDeal>, randomness: [u8; 32], hand_no: u64) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(
            runtime.phase == phase::VRF_PENDING,
            CardFlexError::WrongPhase
        );
        require!(hand_no == runtime.hand_no, CardFlexError::StaleCallback);
        let runtime_key = runtime.key();
        let order: Vec<u8> = runtime.dealing_order[..runtime.dealing_count as usize].to_vec();
        require!(
            ctx.remaining_accounts.len() == order.len(),
            CardFlexError::BadSalt
        );
        let mut salts = Vec::with_capacity(order.len());
        for (&seat, acc) in order.iter().zip(ctx.remaining_accounts) {
            let (expected, _) = Pubkey::find_program_address(
                &[SALT_SEED, runtime_key.as_ref(), &[seat]],
                &crate::ID,
            );
            require_keys_eq!(acc.key(), expected, CardFlexError::BadSalt);
            require_keys_eq!(*acc.owner, crate::ID, CardFlexError::BadSalt);
            let data = acc.try_borrow_data()?;
            require!(&data[..8] == SALT_TAG, CardFlexError::BadSalt);
            require!(
                data[41..49] == runtime.hand_no.to_le_bytes(),
                CardFlexError::BadSalt
            );
            let mut salt = [0u8; 32];
            salt.copy_from_slice(&data[49..81]);
            // Security review: the salt used must be exactly the committed one.
            require!(
                fairness_core::salt_commitment::<SolSha256>(&runtime.hand_ctx, seat, &salt)
                    == runtime.salt_commitments[seat as usize],
                CardFlexError::BadSalt
            );
            salts.push(salt);
        }
        let seed = fairness_core::shuffle_seed::<SolSha256>(&runtime.hand_ctx, &randomness, &salts);
        {
            let mut d = ctx.accounts.dealer.try_borrow_mut_data()?;
            require!(&d[..8] == DEALER_TAG, CardFlexError::BadDealer);
            d[40..48].copy_from_slice(&runtime.hand_no.to_le_bytes());
            d[DEALER_VRF_OFFSET..DEALER_VRF_OFFSET + 32].copy_from_slice(&randomness);
            d[DEALER_SEED_OFFSET..DEALER_SEED_OFFSET + 32].copy_from_slice(&seed);
        }
        runtime.phase = phase::SEEDED;
        Ok(())
    }

    // ---------- CF-011 shuffle and deal (PER) ----------

    /// Shuffles from the private seed (spec §5–6), commits the deck with a
    /// Merkle root (spec §7), and writes each seat's 3 cards, positions, leaf
    /// salts and proofs into its private `SeatHand` (spec §8). Only the root
    /// becomes public.
    pub fn deal_hand(ctx: Context<DealHand>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.phase == phase::SEEDED, CardFlexError::WrongPhase);
        let runtime_key = runtime.key();
        let order: Vec<u8> = runtime.dealing_order[..runtime.dealing_count as usize].to_vec();
        require!(
            ctx.remaining_accounts.len() == order.len(),
            CardFlexError::BadSeatHand
        );
        let mut seed = [0u8; 32];
        {
            let d = ctx.accounts.dealer.try_borrow_data()?;
            require!(&d[..8] == DEALER_TAG, CardFlexError::BadDealer);
            require!(
                d[40..48] == runtime.hand_no.to_le_bytes(),
                CardFlexError::BadDealer
            );
            seed.copy_from_slice(&d[DEALER_SEED_OFFSET..DEALER_SEED_OFFSET + 32]);
        }
        let out = compute_deal(&runtime.hand_ctx, &seed, order.len());
        {
            let mut d = ctx.accounts.dealer.try_borrow_mut_data()?;
            for (i, c) in out.deck.iter().enumerate() {
                d[48 + i] = c.id();
            }
        }
        let n = order.len();
        for (k, (&seat, acc)) in order.iter().zip(ctx.remaining_accounts).enumerate() {
            let (expected, _) = Pubkey::find_program_address(
                &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
                &crate::ID,
            );
            require_keys_eq!(acc.key(), expected, CardFlexError::BadSeatHand);
            require_keys_eq!(*acc.owner, crate::ID, CardFlexError::BadSeatHand);
            let mut data = acc.try_borrow_mut_data()?;
            require!(
                data.len() == SEAT_HAND_LEN as usize && &data[..8] == SEAT_HAND_TAG,
                CardFlexError::BadSeatHand
            );
            data[41..49].copy_from_slice(&runtime.hand_no.to_le_bytes());
            for (j, pos) in fairness_core::deal_positions(k, n).into_iter().enumerate() {
                data[HAND_CARDS + j] = out.deck[pos].id();
                data[HAND_POSITIONS + j] = pos as u8;
                let salt = fairness_core::leaf_salt::<SolSha256>(&seed, pos as u8);
                data[HAND_LEAF_SALTS + 32 * j..HAND_LEAF_SALTS + 32 * (j + 1)]
                    .copy_from_slice(&salt);
                for (lvl, sib) in out.proofs[3 * k + j].iter().enumerate() {
                    let at = HAND_PROOFS + (6 * j + lvl) * 32;
                    data[at..at + 32].copy_from_slice(sib);
                }
            }
        }
        runtime.merkle_root = out.root;
        runtime.dealt = true;
        runtime.phase = phase::DEALT;
        // CF-020: betting starts; boots are collected now.
        let rules =
            teen_patti_core::game::Rules::v1(runtime.boot, runtime.rake_bps, runtime.rake_cap);
        let hand = teen_patti_core::game::Hand::start(rules, runtime.stacks, &order)
            .map_err(|_| CardFlexError::BadStacks)?;
        runtime.game = GameState::from_hand(&hand);
        runtime.action_seq = 0;
        runtime.turn_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(TURN_SECS)
            .ok_or(CardFlexError::Overflow)?;
        Ok(())
    }

    /// One player action during betting (CF-020). Signed by the acting seat's
    /// session key; `expected_seq` must equal the current `action_seq`, so a
    /// stale or replayed action fails. Rules come only from
    /// `teen-patti-core`; on settlement the stacks and rake are written back
    /// and the hand becomes `HAND_COMPLETE`.
    pub fn act(ctx: Context<Act>, action: u8, amount: u64, expected_seq: u64) -> Result<()> {
        use teen_patti_core::game::Action;
        let runtime_key = ctx.accounts.runtime.key();
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.phase == phase::DEALT, CardFlexError::WrongPhase);
        require!(
            expected_seq == runtime.action_seq,
            CardFlexError::StaleAction
        );
        let session = ctx.accounts.session.key();
        let seat = runtime
            .seated()
            .find(|&i| runtime.session_keys[i] == session)
            .ok_or(CardFlexError::NotSeatOwner)? as u8;
        let action = match action {
            0 => Action::See,
            1 => Action::Chaal { amount },
            2 => Action::Pack,
            3 => Action::Show,
            4 => Action::SideShowRequest,
            5 => Action::SideShowRespond {
                accept: amount != 0,
            },
            _ => return err!(CardFlexError::IllegalAction),
        };
        apply_game_action(
            runtime,
            runtime_key,
            &ctx.accounts.hand_log.to_account_info(),
            seat,
            action,
            ctx.remaining_accounts,
        )
    }

    /// Turn timer (CF-023, rules v1 §3: 25 s). After `turn_deadline` anyone
    /// may call this: it applies `Timeout` for the player to act (= Pack) or
    /// for a pending Side Show's target (= reject), through the same rules
    /// engine and public log as `act`. A keeper cranks it; players need not.
    pub fn timeout_turn(ctx: Context<TimeoutTurn>, expected_seq: u64) -> Result<()> {
        let runtime_key = ctx.accounts.runtime.key();
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.phase == phase::DEALT, CardFlexError::WrongPhase);
        require!(
            expected_seq == runtime.action_seq,
            CardFlexError::StaleAction
        );
        require!(
            Clock::get()?.unix_timestamp >= runtime.turn_deadline,
            CardFlexError::TooEarly
        );
        let g = &runtime.game;
        let seat = if g.phase == 1 {
            g.ss_target
        } else {
            g.order[g.turn as usize]
        };
        apply_game_action(
            runtime,
            runtime_key,
            &ctx.accounts.hand_log.to_account_info(),
            seat,
            teen_patti_core::game::Action::Timeout,
            ctx.remaining_accounts,
        )
    }

    /// Moves to the next hand once this one is revealed (CF-024).
    /// Permissionless. The button moves to the seat dealt first this hand;
    /// `hand_no` goes up, so every account of the old hand (salts, seat
    /// hands, VRF) is stale for the new one. Stacks stay as settled; a keeper
    /// commits and syncs them (`commit_hand`, `sync_hand`) between hands.
    pub fn next_hand(ctx: Context<NextHand>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.phase == phase::REVEALED, CardFlexError::WrongPhase);
        if runtime.dealing_count > 0 {
            runtime.button = runtime.dealing_order[0];
        }
        runtime.hand_no = runtime
            .hand_no
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        runtime.phase = phase::IDLE;
        runtime.dealt = false;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
        runtime.vrf_caller_seed = [0; 32];
        runtime.merkle_root = [0; 32];
        runtime.game = GameState::default();
        runtime.action_seq = 0;
        runtime.turn_deadline = 0;
        runtime.side_show_viewers = [0; MAX_SEATS];
        runtime.last_hand_end = Clock::get()?.unix_timestamp;
        apply_leaves(runtime);
        Ok(())
    }

    /// Ends a salt round that stalled (CF-050): after `salts_deadline`, anyone
    /// may call it. No boots were collected yet (that happens at the deal), so
    /// nothing is owed. Each dealt player who didn't submit a salt gets a
    /// strike; after MAX_MISSED_SALTS in a row they're made to leave (cash-out
    /// after the next sync), so an absent player can't freeze the table but a
    /// briefly slow one isn't evicted.
    /// The hand number moves on, so the next hand has a new context and new
    /// salts. Without this, one absent player froze the table and everyone's
    /// money with it.
    pub fn cancel_salts(ctx: Context<CancelSalts>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(
            runtime.phase == phase::SALTS_PENDING,
            CardFlexError::WrongPhase
        );
        require!(
            Clock::get()?.unix_timestamp >= runtime.salts_deadline,
            CardFlexError::TooEarly
        );
        let order: Vec<u8> = runtime.dealing_order[..runtime.dealing_count as usize].to_vec();
        for s in order {
            if runtime.salts_in & (1 << s) == 0 {
                let m = &mut runtime.missed_salts[s as usize];
                *m = m.saturating_add(1);
                if *m >= MAX_MISSED_SALTS {
                    runtime.leaving |= 1 << s;
                }
            }
        }
        runtime.last_hand_end = Clock::get()?.unix_timestamp;
        runtime.cancelled_hands = runtime.cancelled_hands.saturating_add(1);
        runtime.hand_no = runtime
            .hand_no
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        runtime.phase = phase::IDLE;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
        apply_leaves(runtime);
        Ok(())
    }

    /// Cancels a hand whose VRF callback hasn't arrived within
    /// `VRF_TIMEOUT_SLOTS`. Permissionless. The cancellation is counted
    /// publicly, the hand number moves on (so a late callback is rejected and
    /// the next hand has new salts), and nothing is rerolled silently.
    /// Boots are returned with the money logic in P6.
    pub fn cancel_hand(ctx: Context<CancelHand>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(
            runtime.phase == phase::VRF_PENDING,
            CardFlexError::WrongPhase
        );
        let now = Clock::get()?.slot;
        require!(
            now >= runtime.vrf_request_slot.saturating_add(VRF_TIMEOUT_SLOTS),
            CardFlexError::TooEarly
        );
        runtime.cancelled_hands = runtime.cancelled_hands.saturating_add(1);
        runtime.hand_no = runtime
            .hand_no
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        runtime.last_hand_end = Clock::get()?.unix_timestamp;
        runtime.phase = phase::IDLE;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
        Ok(())
    }

    /// CF-053 (ADR 0004 #8): ends a hand whose secret state was lost, e.g. a
    /// PER restart that kept the delegated runtime but not the ephemeral
    /// accounts. Permissionless. `remaining_accounts` = every ephemeral
    /// account the hand needs: the dealer, then the seat hands, then the
    /// salts of the dealt seats in dealing order. It succeeds only if at
    /// least one of them is gone. Those accounts can't be closed while a hand
    /// is in progress, so a missing one can only mean lost state; and since
    /// they are private, only the program (not an RPC reader) can tell, which
    /// is why a keeper simply tries this when a hand is stuck. Nothing is
    /// redealt and the hand is counted in `cancelled_hands`. Before
    /// settlement no stack has moved (boots live in `game` until the hand
    /// ends). A hand settled but not yet revealed can never be verified, so
    /// its result is reversed: stacks go back to the start of the hand and
    /// its rake is taken back. No sync copies stacks or rake mid-hand, so
    /// nothing was paid from that result.
    pub fn abort_lost_hand(ctx: Context<AbortLostHand>) -> Result<()> {
        let runtime_key = ctx.accounts.runtime.key();
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.hand_in_progress(), CardFlexError::WrongPhase);
        require!(
            any_lost(runtime, runtime_key, ctx.remaining_accounts)?,
            CardFlexError::NotLost
        );
        if runtime.phase == phase::HAND_COMPLETE {
            void_settlement(runtime)?;
        }
        runtime.cancelled_hands = runtime.cancelled_hands.saturating_add(1);
        runtime.hand_no = runtime
            .hand_no
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        runtime.phase = phase::IDLE;
        runtime.dealt = false;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
        runtime.vrf_caller_seed = [0; 32];
        runtime.merkle_root = [0; 32];
        runtime.game = GameState::default();
        runtime.action_seq = 0;
        runtime.turn_deadline = 0;
        runtime.side_show_viewers = [0; MAX_SEATS];
        runtime.last_hand_end = Clock::get()?.unix_timestamp;
        // `grants` stays: a surviving seat hand may still have a second
        // reader and must be revoked (`side_show_view`, `set_hand_readers`)
        // before `start_hand`; a re-created one starts with its owner only.
        apply_leaves(runtime);
        Ok(())
    }

    // ---------- CF-012 reveal (PER) ----------

    /// Gives `HandLog` an explicit permission marking it **public** (ADR 0002:
    /// never rely on the default for a delegated account).
    pub fn open_hand_log_permission(ctx: Context<TablePer>) -> Result<()> {
        let runtime = &ctx.accounts.runtime;
        let runtime_key = runtime.key();
        let (hand_log, bump) =
            Pubkey::find_program_address(&[HAND_LOG_SEED, runtime_key.as_ref()], &crate::ID);
        require_keys_eq!(
            ctx.accounts.target.key(),
            hand_log,
            CardFlexError::BadHandLog
        );
        let seeds: &[&[u8]] = &[HAND_LOG_SEED, runtime_key.as_ref(), &[bump]];
        create_permission_with(
            ctx.accounts,
            &ctx.accounts.target.to_account_info(),
            vec![],
            &[
                &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]],
                seeds,
            ],
            false,
        )
    }

    /// Publishes a finished hand's seed inputs (spec §9) in `HandLog`: roster,
    /// salts, VRF output, commitments and root. Permissionless. Salts are
    /// re-checked against their commitments. After this, anyone can rebuild
    /// the deck, so it runs only after the game has ended the hand.
    pub fn reveal_hand(ctx: Context<RevealHand>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        // Security review: revealing during play would let anyone rebuild
        // every hand. Only a finished hand may be revealed.
        require!(
            runtime.phase == phase::HAND_COMPLETE,
            CardFlexError::WrongPhase
        );
        let runtime_key = runtime.key();
        let order: Vec<u8> = runtime.dealing_order[..runtime.dealing_count as usize].to_vec();
        require!(
            ctx.remaining_accounts.len() == order.len(),
            CardFlexError::BadSalt
        );
        let log = &mut ctx.accounts.hand_log;
        log.hand_no = runtime.hand_no;
        log.rules_version = RULES_VERSION;
        log.protocol_version = fairness_core::PROTOCOL_VERSION;
        log.dealing_count = order.len() as u8;
        log.seats = [0; MAX_SEATS];
        log.wallets = [Pubkey::default(); MAX_SEATS];
        log.salts = [[0; 32]; MAX_SEATS];
        log.salt_commitments = [[0; 32]; MAX_SEATS];
        for (k, (&seat, acc)) in order.iter().zip(ctx.remaining_accounts).enumerate() {
            let (expected, _) = Pubkey::find_program_address(
                &[SALT_SEED, runtime_key.as_ref(), &[seat]],
                &crate::ID,
            );
            require_keys_eq!(acc.key(), expected, CardFlexError::BadSalt);
            require_keys_eq!(*acc.owner, crate::ID, CardFlexError::BadSalt);
            let data = acc.try_borrow_data()?;
            require!(&data[..8] == SALT_TAG, CardFlexError::BadSalt);
            let mut salt = [0u8; 32];
            salt.copy_from_slice(&data[49..81]);
            require!(
                fairness_core::salt_commitment::<SolSha256>(&runtime.hand_ctx, seat, &salt)
                    == runtime.salt_commitments[seat as usize],
                CardFlexError::BadSalt
            );
            log.seats[k] = seat;
            log.wallets[k] = runtime.wallets[seat as usize];
            log.salts[k] = salt;
            log.salt_commitments[k] = runtime.salt_commitments[seat as usize];
        }
        {
            let d = ctx.accounts.dealer.try_borrow_data()?;
            require!(&d[..8] == DEALER_TAG, CardFlexError::BadDealer);
            log.vrf_output
                .copy_from_slice(&d[DEALER_VRF_OFFSET..DEALER_VRF_OFFSET + 32]);
        }
        log.hand_ctx = runtime.hand_ctx;
        log.roster_hash = runtime.roster_hash;
        log.vrf_caller_seed = runtime.vrf_caller_seed;
        log.merkle_root = runtime.merkle_root;
        // CF-021: rules, starting stacks and result, for replay. A hand that
        // ended without any action can't exist (the game ends only on one).
        let (log_hand, log_count) = {
            let info = log.to_account_info();
            let d = info.try_borrow_data()?;
            require!(d.len() >= HAND_LOG_LEN, CardFlexError::WrongPhase);
            action_log_header(&d)
        };
        require!(
            runtime.game.phase == 2
                && log_hand == runtime.hand_no
                && log_count as u64 == runtime.action_seq
                && log_count > 0,
            CardFlexError::WrongPhase
        );
        write_game_summary(&runtime.game, &order, log);
        log.revealed = true;
        runtime.phase = phase::REVEALED;
        Ok(())
    }

    /// Deals the P1 **test deck** (not random). `remaining_accounts` = the
    /// seat hands of every occupied seat, in seat order. Compiled only with
    /// feature `poc-test-deck` (CF-052): production builds don't contain it.
    #[cfg(feature = "poc-test-deck")]
    pub fn poc_deal(ctx: Context<PocDeal>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.locked, CardFlexError::TableNotLocked);
        require!(!runtime.dealt, CardFlexError::AlreadyDealt);
        let seats: Vec<usize> = runtime.seated().collect();
        require!(seats.len() >= 2, CardFlexError::NotEnoughPlayers);
        require!(
            ctx.remaining_accounts.len() == seats.len(),
            CardFlexError::BadSeatHand
        );
        let runtime_key = runtime.key();
        let deck = poc_test_deck(runtime.hand_no);

        {
            let mut data = ctx.accounts.dealer.try_borrow_mut_data()?;
            require!(&data[..8] == DEALER_TAG, CardFlexError::BadDealer);
            data[40..48].copy_from_slice(&runtime.hand_no.to_le_bytes());
            for (i, card) in deck.iter().enumerate() {
                data[48 + i] = card.id();
            }
        }
        for (k, (&seat, hand)) in seats.iter().zip(ctx.remaining_accounts).enumerate() {
            let (expected, _) = Pubkey::find_program_address(
                &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat as u8]],
                &crate::ID,
            );
            require_keys_eq!(hand.key(), expected, CardFlexError::BadSeatHand);
            require_keys_eq!(*hand.owner, crate::ID, CardFlexError::BadSeatHand);
            let mut data = hand.try_borrow_mut_data()?;
            require!(&data[..8] == SEAT_HAND_TAG, CardFlexError::BadSeatHand);
            data[41..49].copy_from_slice(&runtime.hand_no.to_le_bytes());
            for (j, pos) in deal_positions(k, seats.len()).into_iter().enumerate() {
                data[49 + j] = deck[pos].id();
            }
        }
        runtime.dealt = true;
        // The test-deck hand isn't played or revealed; its own terminal phase
        // lets the POC scripts clean up.
        runtime.phase = phase::POC_DONE;
        Ok(())
    }

    /// Closes an ephemeral account (dealer or a seat hand) and its permission,
    /// returning rent to `TableRuntime`. Must run before `undelegate_table`.
    pub fn close_ephemeral(ctx: Context<TablePer>, seat: Option<u8>) -> Result<()> {
        require!(
            !ctx.accounts.runtime.hand_in_progress(),
            CardFlexError::HandInProgress
        );
        let runtime = &ctx.accounts.runtime;
        let runtime_key = runtime.key();
        let (expected, bump) = match seat {
            Some(s) => Pubkey::find_program_address(
                &[SEAT_HAND_SEED, runtime_key.as_ref(), &[s]],
                &crate::ID,
            ),
            None => Pubkey::find_program_address(&[DEALER_SEED, runtime_key.as_ref()], &crate::ID),
        };
        require_keys_eq!(
            ctx.accounts.target.key(),
            expected,
            CardFlexError::BadSeatHand
        );
        let seat_byte = [seat.unwrap_or(0)];
        let bump_byte = [bump];
        let target_seeds: Vec<&[u8]> = match seat {
            Some(_) => vec![SEAT_HAND_SEED, runtime_key.as_ref(), &seat_byte, &bump_byte],
            None => vec![DEALER_SEED, runtime_key.as_ref(), &bump_byte],
        };
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
        let runtime_info = ctx.accounts.runtime.to_account_info();
        CloseEphemeralPermissionCpi {
            payer: runtime_info.clone(),
            permissioned_account: ctx.accounts.target.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.target.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[runtime_seeds, &target_seeds])?;
        EphemeralAccount::new(
            &runtime_info,
            &ctx.accounts.target,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[runtime_seeds])
        .close()?;
        Ok(())
    }

    /// Commits `TableRuntime` and returns it to the base layer.
    pub fn undelegate_table(ctx: Context<CommitTable>) -> Result<()> {
        // CF-050: a newer commit_seq, so sync_hand accepts the state this
        // writes back (otherwise a player who just left couldn't cash out).
        ctx.accounts.runtime.commit_seq = ctx
            .accounts
            .runtime
            .commit_seq
            .checked_add(1)
            .ok_or(CardFlexError::Overflow)?;
        ctx.accounts.runtime.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[
            ctx.accounts.runtime.to_account_info(),
            ctx.accounts.hand_log.to_account_info(),
        ])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

/// `request_shuffle`: anyone may pay for the request once all salts are in;
/// the program fixes `caller_seed`, so the caller can't influence it.
#[ephemeral_rollups_sdk::anchor::vrf]
#[derive(Accounts)]
pub struct RequestShuffle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: ephemeral dealer PDA (callback target), checked by seeds.
    #[account(seeds = [DEALER_SEED, runtime.key().as_ref()], bump)]
    pub dealer: UncheckedAccount<'info>,
    /// CHECK: must be one of MagicBlock's VRF queues (checked in the handler).
    #[account(mut)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// `vrf_deal`: called only by the VRF program through the scoped identity
/// PDA (injected by `#[vrf_callback]`). Salt accounts follow in
/// `remaining_accounts`, in dealing order.
#[ephemeral_rollups_sdk::anchor::vrf_callback]
#[derive(Accounts)]
pub struct VrfDeal<'info> {
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: ephemeral dealer PDA, checked by seeds, owner and tag.
    #[account(mut, seeds = [DEALER_SEED, runtime.key().as_ref()], bump, owner = crate::ID)]
    pub dealer: UncheckedAccount<'info>,
}

/// Creates a private ephemeral permission for `account` with `members`.
fn create_permission<'info>(
    accs: &TablePer<'info>,
    account: &AccountInfo<'info>,
    members: Vec<Member>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    create_permission_with(accs, account, members, signer_seeds, true)
}

fn create_permission_with<'info>(
    accs: &TablePer<'info>,
    account: &AccountInfo<'info>,
    members: Vec<Member>,
    signer_seeds: &[&[&[u8]]],
    is_private: bool,
) -> Result<()> {
    CreateEphemeralPermissionCpi {
        payer: accs.runtime.to_account_info(),
        permissioned_account: account.clone(),
        permission: accs.permission.to_account_info(),
        vault: accs.ephemeral_vault.to_account_info(),
        magic_program: accs.magic_program.to_account_info(),
        permission_program: accs.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private,
            members,
        },
    }
    .invoke_signed(signer_seeds)?;
    Ok(())
}

/// Applies pending leaves between hands (ADR 0005 decision 3): the seat is
/// no longer occupied and is marked departed; its final stack stays in
/// `stacks` for `sync_hand`. Its session key keeps reading only its own old
/// seat hand (never dealt again) until `join_seat` replaces it.
/// CF-053: checks that `accounts` are exactly the dealer, the seat hands and
/// the salts of the dealt seats (dealing order) and reports whether any of
/// them is missing or unusable: not owned by the program, or without its
/// tag (every real one is tagged when opened, so a zeroed account left by a
/// restart counts as lost too).
#[inline(never)]
fn any_lost(runtime: &TableRuntime, rt: Pubkey, accounts: &[AccountInfo]) -> Result<bool> {
    let order = &runtime.dealing_order[..runtime.dealing_count as usize];
    require!(
        accounts.len() == 1 + 2 * order.len(),
        CardFlexError::BadLostAccounts
    );
    let mut expected: Vec<(Pubkey, &[u8; 8])> = Vec::with_capacity(accounts.len());
    expected.push((
        Pubkey::find_program_address(&[DEALER_SEED, rt.as_ref()], &crate::ID).0,
        DEALER_TAG,
    ));
    for (seed, tag) in [(SEAT_HAND_SEED, SEAT_HAND_TAG), (SALT_SEED, SALT_TAG)] {
        for &s in order {
            expected.push((
                Pubkey::find_program_address(&[seed, rt.as_ref(), &[s]], &crate::ID).0,
                tag,
            ));
        }
    }
    let mut lost = false;
    for (acc, (want, tag)) in accounts.iter().zip(expected) {
        require_keys_eq!(acc.key(), want, CardFlexError::BadLostAccounts);
        let data = acc.try_borrow_data()?;
        lost |= *acc.owner != crate::ID || data.len() < 8 || &data[..8] != tag;
    }
    Ok(lost)
}

/// CF-053: undoes the settlement of a hand that will never be revealed.
/// Each dealt seat gets back its stack from the start of the hand
/// (`stack + contributed - payout`, as in `write_game_summary`) and the
/// hand's rake leaves `rake_owed`. Checked for conservation.
#[inline(never)]
fn void_settlement(runtime: &mut TableRuntime) -> Result<()> {
    let g = &runtime.game;
    require!(g.phase == 2, CardFlexError::BadStacks);
    let mut restored = runtime.stacks;
    let (mut before, mut after) = (0u128, 0u128);
    for (i, (s, out)) in g.seats.iter().zip(restored.iter_mut()).enumerate() {
        if !s.dealt {
            continue;
        }
        require!(runtime.stacks[i] == s.stack, CardFlexError::BadStacks);
        *out = s
            .stack
            .checked_add(s.contributed)
            .and_then(|v| v.checked_sub(g.payouts[i]))
            .ok_or(CardFlexError::BadStacks)?;
        before += s.stack as u128;
        after += *out as u128;
    }
    require!(after == before + g.rake as u128, CardFlexError::BadStacks);
    runtime.rake_owed = runtime
        .rake_owed
        .checked_sub(g.rake)
        .ok_or(CardFlexError::BadStacks)?;
    runtime.stacks = restored;
    Ok(())
}

fn apply_leaves(runtime: &mut TableRuntime) {
    let l = runtime.leaving & runtime.occupied;
    runtime.occupied &= !l;
    runtime.departed |= l;
    runtime.leaving = 0;
}

/// An optional account that must be present (permission paths of `join_seat`).
fn need<'info>(o: &Option<UncheckedAccount<'info>>) -> Result<AccountInfo<'info>> {
    o.as_ref()
        .map(|x| x.to_account_info())
        .ok_or(error!(CardFlexError::BadSeatHand))
}

/// Replaces a seat hand's reader list (permission CPI signed by the runtime
/// and hand PDAs). Callers decide the readers; this only checks the PDA.
#[allow(clippy::too_many_arguments)]
fn update_hand_readers<'info>(
    runtime: &Account<'info, TableRuntime>,
    seat: u8,
    target: &UncheckedAccount<'info>,
    permission: &UncheckedAccount<'info>,
    vault: &UncheckedAccount<'info>,
    magic_program: &UncheckedAccount<'info>,
    permission_program: &UncheckedAccount<'info>,
    readers: Vec<Pubkey>,
) -> Result<()> {
    require!(
        !readers.is_empty() && readers.len() <= MAX_HAND_READERS,
        CardFlexError::BadReaders
    );
    let runtime_key = runtime.key();
    let (hand, hand_bump) =
        Pubkey::find_program_address(&[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]], &crate::ID);
    require_keys_eq!(target.key(), hand, CardFlexError::BadSeatHand);
    let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, runtime.config.as_ref(), &[runtime.bump]];
    let hand_seeds: &[&[u8]] = &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat], &[hand_bump]];
    let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
    UpdateEphemeralPermissionCpi {
        payer: runtime.to_account_info(),
        permissioned_account: target.to_account_info(),
        permission: permission.to_account_info(),
        vault: vault.to_account_info(),
        magic_program: magic_program.to_account_info(),
        permission_program: permission_program.to_account_info(),
        authority: target.to_account_info(),
        authority_is_signer: false,
        args: EphemeralMembersArgs {
            is_private: true,
            members: readers
                .into_iter()
                .map(|pubkey| Member { flags, pubkey })
                .collect(),
        },
    }
    .invoke_signed(&[runtime_seeds, hand_seeds])?;
    Ok(())
}

/// One rules-engine step for `act` and `timeout_turn`: apply, record Side
/// Show viewers, append to the public log, reset the turn timer, and settle
/// when the hand ends. On error nothing changes.
#[inline(never)]
fn apply_game_action(
    runtime: &mut TableRuntime,
    runtime_key: Pubkey,
    hand_log: &AccountInfo,
    seat: u8,
    action: teen_patti_core::game::Action,
    seat_hands: &[AccountInfo],
) -> Result<()> {
    use teen_patti_core::game::{Action, Event};
    let oracle = read_hand_ranks(runtime, runtime_key, seat_hands)?;
    let mut hand = runtime.game.to_hand();
    let before = hand.table_total();
    let entry =
        teen_patti_core::game::encode_action(seat, action, &hand).ok_or(CardFlexError::BadBet)?;
    let pending_ss =
        (runtime.game.phase == 1).then_some((runtime.game.ss_requester, runtime.game.ss_target));
    let event = hand.apply(seat, action, &oracle).map_err(rule_error)?;
    // CF-022: an accepted Side Show lets the two players see each other's
    // cards (granted by `side_show_view`, at most 2 viewers per hand).
    if let (Event::SideShowResolved { .. }, Some((a, b))) = (event, pending_ss) {
        if runtime.side_show_hand_no != runtime.hand_no {
            runtime.side_show_viewers = [0; MAX_SEATS];
            runtime.side_show_hand_no = runtime.hand_no;
        }
        let fits = |v: u8| v.count_ones() < (MAX_HAND_READERS - 1) as u32;
        let (va, vb) = (
            runtime.side_show_viewers[a as usize],
            runtime.side_show_viewers[b as usize],
        );
        if fits(va) && fits(vb) {
            runtime.side_show_viewers[a as usize] |= 1 << b;
            runtime.side_show_viewers[b as usize] |= 1 << a;
        }
    }
    // CF-021: append to the public log tail (index = action_seq).
    let i = runtime.action_seq as usize;
    require!(
        i < teen_patti_core::game::MAX_ACTIONS,
        CardFlexError::Overflow
    );
    {
        let mut d = hand_log.try_borrow_mut_data()?;
        require!(d.len() >= HAND_LOG_LEN, CardFlexError::Overflow);
        let o = ACTION_LOG_OFFSET;
        d[o..o + 8].copy_from_slice(&runtime.hand_no.to_le_bytes());
        d[o + 8..o + 10].copy_from_slice(&((i + 1) as u16).to_le_bytes());
        d[ACTION_LOG_ACTIONS + i] = entry;
    }
    runtime.game = GameState::from_hand(&hand);
    runtime.action_seq = runtime
        .action_seq
        .checked_add(1)
        .ok_or(CardFlexError::Overflow)?;
    if let Event::HandOver(s) = event {
        // Conservation: nothing created or lost (rules v1 §5).
        require!(
            hand.table_total() + s.rake == before,
            CardFlexError::BadStacks
        );
        for i in 0..MAX_SEATS {
            if hand.seats[i].dealt {
                runtime.stacks[i] = hand.seats[i].stack;
            }
        }
        runtime.rake_owed = runtime
            .rake_owed
            .checked_add(s.rake)
            .ok_or(CardFlexError::Overflow)?;
        runtime.phase = phase::HAND_COMPLETE;
    }
    if action != Action::See {
        runtime.turn_deadline = Clock::get()?
            .unix_timestamp
            .checked_add(TURN_SECS)
            .ok_or(CardFlexError::Overflow)?;
    }
    Ok(())
}

/// Copies the rules, starting stacks and result into the public log, in
/// dealing order. Separate function: keeps `reveal_hand`'s stack frame small.
#[inline(never)]
fn write_game_summary(g: &GameState, order: &[u8], log: &mut HandLog) {
    log.boot = g.boot;
    log.rake_bps = g.rake_bps;
    log.rake_cap = g.rake_cap;
    log.end_reason = g.end_reason;
    log.winners = g.winners;
    log.rake = g.rake;
    log.start_stacks = [0; MAX_SEATS];
    log.payouts = [0; MAX_SEATS];
    for (k, &seat) in order.iter().enumerate() {
        let s = &g.seats[seat as usize];
        let payout = g.payouts[seat as usize];
        log.start_stacks[k] = s.stack + s.contributed - payout;
        log.payouts[k] = payout;
    }
}

/// Reads and ranks the dealt hands from the seat-hand accounts (dealing
/// order). Each account is checked by PDA, owner, tag and hand number.
fn read_hand_ranks(
    runtime: &TableRuntime,
    runtime_key: Pubkey,
    accounts: &[AccountInfo],
) -> Result<SeatHandOracle> {
    let n = runtime.game.n as usize;
    require!(accounts.len() == n, CardFlexError::BadSeatHand);
    let mut ranks = [teen_patti_core::HandRank { key: 0 }; MAX_SEATS];
    for (k, acc) in accounts.iter().enumerate() {
        let seat = runtime.game.order[k];
        let (expected, _) = Pubkey::find_program_address(
            &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
            &crate::ID,
        );
        require_keys_eq!(acc.key(), expected, CardFlexError::BadSeatHand);
        require_keys_eq!(*acc.owner, crate::ID, CardFlexError::BadSeatHand);
        let d = acc.try_borrow_data()?;
        require!(
            d.len() == SEAT_HAND_LEN as usize
                && &d[..8] == SEAT_HAND_TAG
                && d[41..49] == runtime.hand_no.to_le_bytes(),
            CardFlexError::BadSeatHand
        );
        let cards: [card_types::Card; 3] = [
            card_types::Card::from_id(d[HAND_CARDS]).map_err(|_| CardFlexError::BadSeatHand)?,
            card_types::Card::from_id(d[HAND_CARDS + 1]).map_err(|_| CardFlexError::BadSeatHand)?,
            card_types::Card::from_id(d[HAND_CARDS + 2]).map_err(|_| CardFlexError::BadSeatHand)?,
        ];
        ranks[seat as usize] = teen_patti_core::evaluate(cards);
    }
    Ok(SeatHandOracle { ranks })
}

fn rule_error(e: teen_patti_core::game::RuleError) -> anchor_lang::error::Error {
    use teen_patti_core::game::RuleError as R;
    match e {
        R::NotYourTurn => error!(CardFlexError::NotYourTurn),
        R::NotActive => error!(CardFlexError::NotActive),
        R::BadAmount => error!(CardFlexError::BadBet),
        R::MustSee => error!(CardFlexError::MustSee),
        R::InsufficientStack => error!(CardFlexError::InsufficientStack),
        R::CannotShow => error!(CardFlexError::CannotShow),
        R::CannotSideShow => error!(CardFlexError::CannotSideShow),
        R::SideShowPending => error!(CardFlexError::SideShowPending),
        R::NoSideShowPending => error!(CardFlexError::NoSideShowPending),
        R::HandOver => error!(CardFlexError::WrongPhase),
        R::BadSetup => error!(CardFlexError::BadStacks),
    }
}

#[error_code]
pub enum CardFlexError {
    #[msg("counter overflow")]
    Overflow,
    #[msg("not a probe secret account")]
    BadSecret,
    #[msg("seat index out of range")]
    BadSeat,
    #[msg("seat already taken")]
    SeatTaken,
    #[msg("seat is empty")]
    SeatEmpty,
    #[msg("need at least two seated players")]
    NotEnoughPlayers,
    #[msg("hand already dealt")]
    AlreadyDealt,
    #[msg("wrong or missing seat hand account")]
    BadSeatHand,
    #[msg("wrong dealer account")]
    BadDealer,
    #[msg("table is locked; seats can't change")]
    TableLocked,
    #[msg("table permissions are not set up yet")]
    TableNotLocked,
    /// Unused since CF-052 (`poc_deal` is compiled out); kept so later
    /// error codes keep their numbers.
    #[msg("test deck is disabled in this build")]
    TestDeckDisabled,
    #[msg("readers must be the seat's session key plus at most one seated opponent")]
    BadReaders,
    #[msg("signer does not own this seat")]
    NotSeatOwner,
    #[msg(
        "session key may not be the authority, a wallet, an existing session or a table address"
    )]
    BadSessionKey,
    #[msg("revoke the active Side Show grant first")]
    GrantActive,
    #[msg("the hand owner's session key must sign a grant")]
    OwnerConsentMissing,
    #[msg("wrong or missing salt account")]
    BadSalt,
    #[msg("not allowed in the current hand phase")]
    WrongPhase,
    #[msg("salt already submitted for this hand")]
    SaltAlreadySubmitted,
    #[msg("not a MagicBlock VRF queue")]
    BadQueue,
    #[msg("a hand is in progress; ephemeral accounts can't change now")]
    HandInProgress,
    #[msg("callback is for a different hand")]
    StaleCallback,
    #[msg("too early: the timeout or the gap between hands has not passed yet")]
    TooEarly,
    #[msg("wrong hand log account")]
    BadHandLog,
    #[msg("delegation must name the validator")]
    ValidatorRequired,
    #[msg("amount outside the table's buy-in limits")]
    BadAmount,
    #[msg("refund timeout outside allowed bounds")]
    BadTimeout,
    #[msg("table is not active")]
    TableNotActive,
    #[msg("not this table's committed runtime")]
    BadRuntime,
    #[msg("commit is not newer than the last synced one")]
    StaleCommit,
    #[msg("wrong or missing seat ledger")]
    BadLedger,
    #[msg("vault holds less than the refund")]
    VaultShort,
    #[msg("validator is not MagicBlock's TEE validator")]
    ValidatorNotAllowed,
    #[msg("nothing left to claim for this seat")]
    NothingToClaim,
    #[msg("vault holds more than the ledgers and rake account for")]
    VaultSurplus,
    #[msg("the seat hasn't left in a synced commit yet")]
    NotLeft,
    #[msg("only the program's upgrade authority may do this")]
    NotUpgradeAuthority,
    #[msg("the program is paused for new tables and buy-ins")]
    Paused,
    #[msg("action sequence number is stale")]
    StaleAction,
    #[msg("unknown action")]
    IllegalAction,
    #[msg("stacks inconsistent with the rules")]
    BadStacks,
    #[msg("not your turn")]
    NotYourTurn,
    #[msg("seat is not active in this hand")]
    NotActive,
    #[msg("bet amount not allowed")]
    BadBet,
    #[msg("blind turns used up: see your cards first")]
    MustSee,
    #[msg("stack can't cover the bet (no all-in): pack")]
    InsufficientStack,
    #[msg("show not allowed now")]
    CannotShow,
    #[msg("side show not allowed now")]
    CannotSideShow,
    #[msg("a side show is waiting for its target")]
    SideShowPending,
    #[msg("no side show pending")]
    NoSideShowPending,
    #[msg("expected the dealer, then the dealt seats' hands and salts in dealing order")]
    BadLostAccounts,
    #[msg("the account still exists; the hand can continue")]
    NotLost,
    #[msg("the table has no terms yet (configure_table first)")]
    NotConfigured,
}
