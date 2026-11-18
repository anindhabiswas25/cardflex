//! Card Flex on-chain program.
//!
//! P0 contents:
//! - `ping`: proves the pinned toolchain builds, deploys and runs (CF-001).
//! - `probe_*`: CF-004 round trip on MagicBlock PER: create an account on the
//!   base layer, delegate it to the TEE validator, make it private, write to it
//!   inside PER, commit, then commit-and-undelegate back to the base layer.
//!   This is scaffolding for measurements and P1; game instructions replace it.
//! - Table instructions (CF-006, `table.rs`): P1 privacy POC with the real
//!   account layout from ADR 0002 and a fixed test deck.
//! - `probe_secret_*`: CF-006 spike for ADR 0002 assumption A1: an
//!   ephemeral-only account inside PER, protected by an ephemeral permission.

pub mod table;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    ephemeral_accounts::EphemeralAccount,
};

use table::*;

declare_id!("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");

/// Bumped whenever an on-chain account layout or instruction changes.
pub const PROTOCOL_VERSION: u16 = 0;

pub const PROBE_SEED: &[u8] = b"probe";
pub const SECRET_SEED: &[u8] = b"secret";
/// Ephemeral secret account layout: 8-byte tag + 32 bytes of secret.
pub const SECRET_LEN: u32 = 40;
pub const SECRET_TAG: &[u8; 8] = b"CFSECRET";

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
        Ok(())
    }

    /// Closes an ephemeral account (dealer or a seat hand) and its permission,
    /// returning rent to `TableRuntime`. Must run before `undelegate_table`.
    pub fn close_ephemeral(ctx: Context<TablePer>, seat: Option<u8>) -> Result<()> {
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
        .commit_and_undelegate(&[ctx.accounts.runtime.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// Base layer. Creates the probe account and pre-funds it with the rent the
    /// ephemeral permission account will need inside PER.
    pub fn probe_init(ctx: Context<ProbeInit>) -> Result<()> {
        // Rent for two ephemeral permissions (probe + secret) and the
        // ephemeral secret account, all paid inside PER by this account.
        let permission_rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32);
        let rent =
            2 * permission_rent + ephemeral_rollups_sdk::ephemeral_accounts::rent(SECRET_LEN);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.probe.to_account_info(),
                },
            ),
            rent,
        )?;
        let probe = &mut ctx.accounts.probe;
        probe.authority = ctx.accounts.authority.key();
        probe.value = 0;
        probe.writes = 0;
        Ok(())
    }

    /// Base layer. Delegates the probe account to the given (TEE) validator.
    pub fn probe_delegate(ctx: Context<ProbeDelegate>) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
        ctx.accounts.delegate_probe(
            &ctx.accounts.authority,
            &[PROBE_SEED, ctx.accounts.authority.key().as_ref()],
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// PER. Creates the ephemeral permission: private, readable only by the
    /// authority. Idempotent.
    pub fn probe_make_private(ctx: Context<ProbePermission>) -> Result<()> {
        if ctx.accounts.permission.lamports() > 0 {
            msg!("permission exists");
            return Ok(());
        }
        let authority = ctx.accounts.probe.authority;
        let seeds: &[&[u8]] = &[PROBE_SEED, authority.as_ref(), &[ctx.bumps.probe]];
        CreateEphemeralPermissionCpi {
            payer: ctx.accounts.probe.to_account_info(),
            permissioned_account: ctx.accounts.probe.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: authority,
                }],
            },
        }
        .invoke_signed(&[seeds])?;
        Ok(())
    }

    /// PER. A game-action-sized write, used to measure confirmation latency.
    pub fn probe_write(ctx: Context<ProbeWrite>, value: u64) -> Result<()> {
        let probe = &mut ctx.accounts.probe;
        probe.value = value;
        probe.writes = probe.writes.checked_add(1).ok_or(CardFlexError::Overflow)?;
        Ok(())
    }

    /// PER. Creates an ephemeral-only secret account (sponsored by the
    /// delegated probe), writes `secret` into it and makes it private to the
    /// authority. CF-006 spike for ADR 0002 assumption A1.
    pub fn probe_secret_create(ctx: Context<ProbeSecret>, secret: [u8; 32]) -> Result<()> {
        let authority = ctx.accounts.probe.authority;
        let probe_key = ctx.accounts.probe.key();
        let probe_seeds: &[&[u8]] = &[PROBE_SEED, authority.as_ref(), &[ctx.bumps.probe]];
        let secret_seeds: &[&[u8]] = &[SECRET_SEED, probe_key.as_ref(), &[ctx.bumps.secret]];
        let probe_info = ctx.accounts.probe.to_account_info();

        EphemeralAccount::new(
            &probe_info,
            &ctx.accounts.secret,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[probe_seeds, secret_seeds])
        .create(SECRET_LEN)?;
        {
            let mut data = ctx.accounts.secret.try_borrow_mut_data()?;
            data[..8].copy_from_slice(SECRET_TAG);
            data[8..40].copy_from_slice(&secret);
        }
        CreateEphemeralPermissionCpi {
            payer: probe_info.clone(),
            permissioned_account: ctx.accounts.secret.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members: vec![Member {
                    flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG,
                    pubkey: authority,
                }],
            },
        }
        .invoke_signed(&[probe_seeds, secret_seeds])?;
        Ok(())
    }

    /// PER. Overwrites the secret (owner only).
    pub fn probe_secret_write(ctx: Context<ProbeSecretWrite>, secret: [u8; 32]) -> Result<()> {
        let mut data = ctx.accounts.secret.try_borrow_mut_data()?;
        require!(
            data.len() == SECRET_LEN as usize && &data[..8] == SECRET_TAG,
            CardFlexError::BadSecret
        );
        data[8..40].copy_from_slice(&secret);
        Ok(())
    }

    /// PER. Closes the secret's permission and the ephemeral account, returning
    /// rent to the probe. Must run before `probe_undelegate` (ADR 0002 rule 3).
    pub fn probe_secret_close(ctx: Context<ProbeSecret>) -> Result<()> {
        let authority = ctx.accounts.probe.authority;
        let probe_key = ctx.accounts.probe.key();
        let probe_seeds: &[&[u8]] = &[PROBE_SEED, authority.as_ref(), &[ctx.bumps.probe]];
        let secret_seeds: &[&[u8]] = &[SECRET_SEED, probe_key.as_ref(), &[ctx.bumps.secret]];
        let probe_info = ctx.accounts.probe.to_account_info();

        CloseEphemeralPermissionCpi {
            payer: probe_info.clone(),
            permissioned_account: ctx.accounts.secret.to_account_info(),
            permission: ctx.accounts.permission.to_account_info(),
            vault: ctx.accounts.ephemeral_vault.to_account_info(),
            magic_program: ctx.accounts.magic_program.to_account_info(),
            permission_program: ctx.accounts.permission_program.to_account_info(),
            authority: ctx.accounts.secret.to_account_info(),
            authority_is_signer: false,
        }
        .invoke_signed(&[probe_seeds, secret_seeds])?;
        EphemeralAccount::new(
            &probe_info,
            &ctx.accounts.secret,
            &ctx.accounts.ephemeral_vault,
        )
        .with_signer_seeds(&[probe_seeds])
        .close()?;
        Ok(())
    }

    /// PER. Commits the probe state to the base layer and stays delegated.
    pub fn probe_commit(ctx: Context<ProbeCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    /// PER. Commits and returns ownership of the probe account to this program
    /// on the base layer.
    pub fn probe_undelegate(ctx: Context<ProbeCommit>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.probe.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

/// Creates a private ephemeral permission for `account` with `members`.
fn create_permission<'info>(
    accs: &TablePer<'info>,
    account: &AccountInfo<'info>,
    members: Vec<Member>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    CreateEphemeralPermissionCpi {
        payer: accs.runtime.to_account_info(),
        permissioned_account: account.clone(),
        permission: accs.permission.to_account_info(),
        vault: accs.ephemeral_vault.to_account_info(),
        magic_program: accs.magic_program.to_account_info(),
        permission_program: accs.permission_program.to_account_info(),
        args: EphemeralMembersArgs {
            is_private: true,
            members,
        },
    }
    .invoke_signed(signer_seeds)?;
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Probe {
    pub authority: Pubkey,
    pub value: u64,
    pub writes: u64,
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
}

#[derive(Accounts)]
pub struct ProbeSecret<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump, has_one = authority)]
    pub probe: Account<'info, Probe>,
    /// CHECK: ephemeral-only PDA created/closed through the magic program.
    #[account(mut, seeds = [SECRET_SEED, probe.key().as_ref()], bump)]
    pub secret: UncheckedAccount<'info>,
    /// CHECK: PDA of the permission program for the secret account.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, secret.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ProbeSecretWrite<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [PROBE_SEED, probe.authority.as_ref()], bump, has_one = authority)]
    pub probe: Account<'info, Probe>,
    /// CHECK: PDA checked by seeds, layout checked by tag; owned by this program.
    #[account(mut, seeds = [SECRET_SEED, probe.key().as_ref()], bump, owner = crate::ID)]
    pub secret: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ProbeInit<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Probe::INIT_SPACE,
        seeds = [PROBE_SEED, authority.key().as_ref()],
        bump
    )]
    pub probe: Account<'info, Probe>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct ProbeDelegate<'info> {
    pub authority: Signer<'info>,
    /// CHECK: the probe PDA, checked by seeds; delegated by the SDK.
    #[account(mut, del, seeds = [PROBE_SEED, authority.key().as_ref()], bump)]
    pub probe: UncheckedAccount<'info>,
    /// CHECK: validator identity, checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

#[derive(Accounts)]
pub struct ProbePermission<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump, has_one = authority)]
    pub probe: Account<'info, Probe>,
    /// CHECK: PDA of the permission program for this probe account.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, probe.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub permission: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ProbeWrite<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump, has_one = authority)]
    pub probe: Account<'info, Probe>,
}

#[commit]
#[derive(Accounts)]
pub struct ProbeCommit<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROBE_SEED, probe.authority.as_ref()], bump, has_one = authority)]
    pub probe: Account<'info, Probe>,
}
