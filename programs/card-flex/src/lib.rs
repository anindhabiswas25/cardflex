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
        structs::{EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG},
    },
    anchor::ephemeral,
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
    pub fn create_table(ctx: Context<CreateTable>, table_id: u64, max_seats: u8) -> Result<()> {
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
        let runtime = &mut ctx.accounts.runtime;
        runtime.config = config.key();
        runtime.authority = config.authority;
        runtime.max_seats = max_seats;
        runtime.bump = ctx.bumps.runtime;
        let hand_log = &mut ctx.accounts.hand_log;
        hand_log.runtime = runtime.key();
        hand_log.config = config.key();
        hand_log.bump = ctx.bumps.hand_log;
        Ok(())
    }

    /// P1 seating on the base layer: records the wallet and its session key.
    /// P6 replaces this with `buy_in`.
    pub fn poc_join(ctx: Context<PocJoin>, seat: u8, session_key: Pubkey) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        let wallet = ctx.accounts.wallet.key();
        require!(seat < runtime.max_seats, CardFlexError::BadSeat);
        require!(
            runtime.occupied & (1 << seat) == 0,
            CardFlexError::SeatTaken
        );
        require!(!runtime.dealt, CardFlexError::AlreadyDealt);
        require!(!runtime.locked, CardFlexError::TableLocked);
        require!(
            !runtime.seated().any(|i| runtime.wallets[i] == wallet),
            CardFlexError::SeatTaken
        );
        let runtime_key = runtime.key();
        let config = runtime.config;
        require!(
            runtime.is_valid_new_session(&session_key, &runtime_key, &config, &wallet),
            CardFlexError::BadSessionKey
        );
        runtime.wallets[seat as usize] = wallet;
        runtime.session_keys[seat as usize] = session_key;
        runtime.occupied |= 1 << seat;
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
        require!(
            runtime.occupied & (1 << seat) != 0,
            CardFlexError::SeatEmpty
        );
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
        )
    }

    /// Replaces the reader list of a seat's hand (CF-007; the mechanism Side
    /// Show uses: grant the opponent's session key, then restore). At most 3
    /// readers; an empty list is rejected because its meaning is ambiguous in
    /// the docs (ADR 0002 / PRD §15.2).
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
        // Security review: the operator must never be able to read a hand.
        // Readers are always the seat's own session key plus at most one other
        // seated player's session key (the Side Show opponent). The table
        // authority, wallets and outside keys are rejected.
        // A grant also needs the hand owner's session key to sign (consent).
        // TODO(P5): add game-state checks (Side Show requested by a valid
        // counterparty, accepted, then revoked automatically at resolution).
        let own = runtime.session_keys[seat as usize];
        require!(
            !readers.is_empty() && readers.len() <= 2 && readers[0] == own,
            CardFlexError::BadReaders
        );
        if let Some(other) = readers.get(1) {
            require!(
                *other != own
                    && *other != runtime.authority
                    && runtime.seated().any(|i| runtime.session_keys[i] == *other),
                CardFlexError::BadReaders
            );
            // Granting needs the hand owner's consent: their session key signs.
            let owner = ctx
                .accounts
                .owner_session
                .as_ref()
                .ok_or(CardFlexError::OwnerConsentMissing)?;
            require_keys_eq!(owner.key(), own, CardFlexError::OwnerConsentMissing);
        }
        let granting = readers.len() == 2;
        let (runtime_key, config, bump) = (runtime.key(), runtime.config, runtime.bump);
        let (hand, hand_bump) = Pubkey::find_program_address(
            &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat]],
            &crate::ID,
        );
        require_keys_eq!(ctx.accounts.target.key(), hand, CardFlexError::BadSeatHand);
        if granting {
            ctx.accounts.runtime.grants |= 1 << seat;
        } else {
            ctx.accounts.runtime.grants &= !(1 << seat);
        }
        let runtime_seeds: &[&[u8]] = &[RUNTIME_SEED, config.as_ref(), &[bump]];
        let hand_seeds: &[&[u8]] = &[SEAT_HAND_SEED, runtime_key.as_ref(), &[seat], &[hand_bump]];
        let flags = TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
        UpdateEphemeralPermissionCpi {
            payer: ctx.accounts.runtime.to_account_info(),
            permissioned_account: ctx.accounts.target.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.target.to_account_info(),
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
        require!(
            runtime.occupied & (1 << seat) != 0,
            CardFlexError::SeatEmpty
        );
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
    /// `hand_ctx` (CF-Fairness v2 spec §2). P1/P2: button fixed at seat 0, so
    /// dealing order is seat order.
    pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
        let config_key = ctx.accounts.config.key();
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.locked, CardFlexError::TableNotLocked);
        require!(runtime.phase == phase::IDLE, CardFlexError::WrongPhase);
        let seats: Vec<fairness_core::Seat> = runtime
            .seated()
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
        runtime.phase = phase::IDLE;
        runtime.salts_in = 0;
        runtime.salt_commitments = [[0; 32]; MAX_SEATS];
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

    /// Marks a dealt hand as finished. Interim, authority-only stand-in for
    /// the P5 showdown / last-player resolution, which will set
    /// `HAND_COMPLETE` itself; until then no game is played on these tables.
    /// TODO(P5): remove; only game logic may finish a hand.
    pub fn end_hand(ctx: Context<StartHand>) -> Result<()> {
        let runtime = &mut ctx.accounts.runtime;
        require!(runtime.phase == phase::DEALT, CardFlexError::WrongPhase);
        runtime.phase = phase::HAND_COMPLETE;
        Ok(())
    }

    /// Publishes a finished hand's seed inputs (spec §9) in `HandLog`: roster,
    /// salts, VRF output, commitments and root. Permissionless. Salts are
    /// re-checked against their commitments. After this, anyone can rebuild
    /// the deck, so in P5 it runs only after showdown.
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
        log.revealed = true;
        runtime.phase = phase::REVEALED;
        Ok(())
    }

    /// Compute-cost benchmark of the real deal path; touches no accounts.
    pub fn bench_deal(
        _ctx: Context<BenchDeal>,
        hand_ctx: [u8; 32],
        seed: [u8; 32],
        seats: u8,
    ) -> Result<()> {
        require!(
            (2..=MAX_SEATS as u8).contains(&seats),
            CardFlexError::BadSeat
        );
        let out = compute_deal(&hand_ctx, &seed, seats as usize);
        // Keep the optimiser from discarding the work.
        require!(out.root != [0u8; 32], CardFlexError::BadDealer);
        Ok(())
    }

    /// Deals the P1 **test deck** (not random). `remaining_accounts` = the
    /// seat hands of every occupied seat, in seat order.
    pub fn poc_deal(ctx: Context<PocDeal>) -> Result<()> {
        require!(
            cfg!(feature = "poc-test-deck"),
            CardFlexError::TestDeckDisabled
        );
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
    pub runtime: Account<'info, TableRuntime>,
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
    pub runtime: Account<'info, TableRuntime>,
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
    #[msg("the VRF timeout has not passed yet")]
    TooEarly,
    #[msg("wrong hand log account")]
    BadHandLog,
}
