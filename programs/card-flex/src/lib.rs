//! Card Flex on-chain program.
//!
//! P0 skeleton: it only exposes `ping`, which logs the protocol version. Its
//! job is to prove the pinned toolchain (Anchor + MagicBlock ER SDK) builds,
//! deploys and runs. Game instructions arrive in later phases.

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

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
}

#[derive(Accounts)]
pub struct Ping {}
