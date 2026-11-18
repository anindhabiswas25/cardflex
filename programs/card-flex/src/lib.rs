//! Card Flex on-chain program.
//!
//! P0 contents:
//! - `ping`: proves the pinned toolchain builds, deploys and runs (CF-001).
//! - `probe_*`: CF-004 round trip on MagicBlock PER: create an account on the
//!   base layer, delegate it to the TEE validator, make it private, write to it
//!   inside PER, commit, then commit-and-undelegate back to the base layer.
//!   This is scaffolding for measurements and P1; game instructions replace it.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::CreateEphemeralPermissionCpi,
        structs::{
            EphemeralMembersArgs, EphemeralPermission, Member, PERMISSION_SEED, TX_BALANCES_FLAG,
            TX_LOGS_FLAG, TX_MESSAGE_FLAG,
        },
    },
    anchor::{commit, delegate, ephemeral},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
};

declare_id!("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");

/// Bumped whenever an on-chain account layout or instruction changes.
pub const PROTOCOL_VERSION: u16 = 0;

pub const PROBE_SEED: &[u8] = b"probe";

#[ephemeral]
#[program]
pub mod card_flex {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("card-flex protocol v{}", PROTOCOL_VERSION);
        Ok(())
    }

    /// Base layer. Creates the probe account and pre-funds it with the rent the
    /// ephemeral permission account will need inside PER.
    pub fn probe_init(ctx: Context<ProbeInit>) -> Result<()> {
        let rent =
            ephemeral_rollups_sdk::ephemeral_accounts::rent(EphemeralPermission::size_of(1) as u32);
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
        probe.writes = probe.writes.checked_add(1).ok_or(ProbeError::Overflow)?;
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

#[account]
#[derive(InitSpace)]
pub struct Probe {
    pub authority: Pubkey,
    pub value: u64,
    pub writes: u64,
}

#[error_code]
pub enum ProbeError {
    #[msg("counter overflow")]
    Overflow,
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
