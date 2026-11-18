//! P1 table accounts (CF-006), laid out per ADR 0002.
//!
//! - `TableConfig` (base, never delegated) and `TableRuntime` (delegated,
//!   public to seated players, never holds secrets).
//! - `DealerState` and `SeatHand[i]`: ephemeral-only accounts inside PER,
//!   never committed. Each has an explicit permission list: a seat's hand is
//!   readable only by that seat's session key; the dealer state's only member
//!   is the `TableRuntime` PDA, which can't sign, so nobody can read it.
//!
//! P1 deals from a fixed **test deck** (`poc_test_deck`) to prove privacy.
//! It is not random and must never reach a public environment; P2 replaces it
//! with CF-Fairness v2.

use anchor_lang::prelude::*;
use card_types::{ordered_deck, Card, DECK_SIZE};
use ephemeral_rollups_sdk::{
    access_control::structs::{EphemeralPermission, PERMISSION_SEED},
    anchor::{commit, delegate},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    ephemeral_accounts::rent as ephemeral_rent,
};

pub const MAX_SEATS: usize = 6;
pub const CARDS_PER_SEAT: usize = 3;
/// Maximum readers of one seat hand (owner + Side Show opponent + spare).
pub const MAX_HAND_READERS: usize = 3;

pub const TABLE_SEED: &[u8] = b"table";
pub const RUNTIME_SEED: &[u8] = b"table-runtime";
pub const SEAT_HAND_SEED: &[u8] = b"seat-hand";
pub const DEALER_SEED: &[u8] = b"dealer";

pub const SALT_SEED: &[u8] = b"salt";
pub const SALT_TAG: &[u8; 8] = b"CFSALT02";
/// tag(8) + runtime(32) + seat(1) + hand_no(8) + salt(32)
pub const SALT_LEN: u32 = 81;
/// Teen Patti rules version bound into the hand context (PRD §11).
pub const RULES_VERSION: u16 = 1;

/// SHA-256 for `fairness-core`: the `sol_sha256` syscall on-chain, software
/// on the host. Same bytes either way (checked against the CF-Fairness v2
/// vectors in tests).
pub struct SolSha256;
impl fairness_core::Sha256 for SolSha256 {
    fn hashv(parts: &[&[u8]]) -> [u8; 32] {
        solana_sha256_hasher::hashv(parts).to_bytes()
    }
}

/// Hand phases (PRD §11.4). P2 adds VRF_PENDING and DEALT in CF-010/011.
pub mod phase {
    pub const IDLE: u8 = 0;
    pub const SALTS_PENDING: u8 = 1;
    pub const SALTS_DONE: u8 = 2;
    /// VRF requested; waiting for the callback (CF-010).
    pub const VRF_PENDING: u8 = 3;
    /// Callback arrived; shuffle seed derived and stored privately.
    pub const SEEDED: u8 = 4;
}

pub const SEAT_HAND_TAG: &[u8; 8] = b"CFSEATHD";
pub const DEALER_TAG: &[u8; 8] = b"CFDEALER";
/// tag(8) + runtime(32) + seat(1) + hand_no(8) + cards(3)
pub const SEAT_HAND_LEN: u32 = 52;
/// tag(8) + runtime(32) + hand_no(8) + deck(52) + vrf_output(32) + seed(32)
pub const DEALER_LEN: u32 = 164;
pub const DEALER_VRF_OFFSET: usize = 100;
pub const DEALER_SEED_OFFSET: usize = 132;

/// Lamports `TableRuntime` must carry into PER to sponsor every ephemeral
/// account and permission it creates.
pub const fn ephemeral_budget() -> u64 {
    // Seat permissions are budgeted at their maximum size (MAX_HAND_READERS)
    // because Side Show grows them; an update that grows the permission is
    // paid by this budget (CF-007 found InsufficientFundsForRent otherwise).
    let seat = ephemeral_rent(SEAT_HAND_LEN)
        + ephemeral_rent(EphemeralPermission::size_of(MAX_HAND_READERS) as u32);
    let dealer =
        ephemeral_rent(DEALER_LEN) + ephemeral_rent(EphemeralPermission::size_of(1) as u32);
    let runtime_permission = ephemeral_rent(EphemeralPermission::size_of(MAX_SEATS + 1) as u32);
    let salt = ephemeral_rent(SALT_LEN) + ephemeral_rent(EphemeralPermission::size_of(1) as u32);
    (seat + salt) * MAX_SEATS as u64 + dealer + runtime_permission
}

#[account]
#[derive(InitSpace)]
pub struct TableConfig {
    pub authority: Pubkey,
    pub table_id: u64,
    pub max_seats: u8,
    pub runtime: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TableRuntime {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub max_seats: u8,
    /// Bit i set = seat i occupied.
    pub occupied: u8,
    pub wallets: [Pubkey; MAX_SEATS],
    /// Per-seat session keys; the only readers of each seat's hand.
    pub session_keys: [Pubkey; MAX_SEATS],
    pub hand_no: u64,
    pub dealt: bool,
    /// Set once permissions are built; no seat changes afterwards.
    pub locked: bool,
    /// Bit i set = seat i's hand currently has a second (Side Show) reader.
    pub grants: u8,
    /// CF-Fairness v2 state for the current hand (public, never secret).
    pub phase: u8,
    pub hand_ctx: [u8; 32],
    pub roster_hash: [u8; 32],
    /// Bit i set = seat i has submitted its salt this hand.
    pub salts_in: u8,
    /// Seats in dealing order for this hand, `dealing_count` entries.
    pub dealing_order: [u8; MAX_SEATS],
    pub dealing_count: u8,
    /// `c_i` per seat index (spec §3); zero until submitted.
    pub salt_commitments: [[u8; 32]; MAX_SEATS],
    /// `caller_seed` sent with the VRF request (spec §3), public for audit.
    pub vrf_caller_seed: [u8; 32],
    pub bump: u8,
}

impl TableRuntime {
    pub fn seated(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.max_seats as usize).filter(move |i| self.occupied & (1 << i) != 0)
    }

    /// A key that may become a session key (and so a hand reader): never the
    /// table authority, a seated wallet, an existing session key, the default
    /// key or one of the table's own addresses (security review).
    pub fn is_valid_new_session(
        &self,
        key: &Pubkey,
        own_key: &Pubkey,
        config: &Pubkey,
        wallet: &Pubkey,
    ) -> bool {
        *key != Pubkey::default()
            && *key != self.authority
            && key != own_key
            && key != config
            && key != wallet
            && !self
                .seated()
                .any(|i| self.wallets[i] == *key || self.session_keys[i] == *key)
    }
}

/// P1 test deck: the canonical deck rotated by a value derived from the hand
/// number. Deterministic and NOT random; replaced by CF-Fairness v2 in P2.
pub fn poc_test_deck(hand_no: u64) -> [Card; DECK_SIZE] {
    let ordered = ordered_deck();
    let shift = ((hand_no.wrapping_mul(7) + 3) % DECK_SIZE as u64) as usize;
    let mut deck = ordered;
    for (i, slot) in deck.iter_mut().enumerate() {
        *slot = ordered[(i + shift) % DECK_SIZE];
    }
    deck
}

/// Round-robin deal: the k-th occupied seat (in seat order) of n receives deck
/// positions k, k+n, k+2n (PRD v1.2 §13.3 step 6, button fixed at seat 0 in P1).
pub fn deal_positions(rank_among_seated: usize, seated: usize) -> [usize; CARDS_PER_SEAT] {
    [
        rank_among_seated,
        rank_among_seated + seated,
        rank_among_seated + 2 * seated,
    ]
}

// ---------- base layer ----------

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreateTable<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + TableConfig::INIT_SPACE,
        seeds = [TABLE_SEED, authority.key().as_ref(), &table_id.to_le_bytes()],
        bump
    )]
    pub config: Account<'info, TableConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + TableRuntime::INIT_SPACE,
        seeds = [RUNTIME_SEED, config.key().as_ref()],
        bump
    )]
    pub runtime: Account<'info, TableRuntime>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PocJoin<'info> {
    /// The player's wallet. In P6 this becomes `buy_in`.
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Account<'info, TableRuntime>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateTable<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority)]
    pub config: Account<'info, TableConfig>,
    /// CHECK: the runtime PDA, checked by seeds; delegated by the SDK.
    #[account(mut, del, seeds = [RUNTIME_SEED, config.key().as_ref()], bump)]
    pub runtime: UncheckedAccount<'info>,
    /// CHECK: validator identity, checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

// ---------- PER ----------

/// Shared by the permission and ephemeral-account instructions.
#[derive(Accounts)]
pub struct TablePer<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump, has_one = authority)]
    pub runtime: Account<'info, TableRuntime>,
    /// CHECK: the ephemeral or permissioned target; PDA checked in the handler.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `target`, checked against the permission program.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, target.key().as_ref()],
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

/// `set_hand_readers`: like `TablePer` plus the hand owner's session key,
/// which must sign any grant of a second reader.
#[derive(Accounts)]
pub struct SetHandReaders<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump, has_one = authority)]
    pub runtime: Account<'info, TableRuntime>,
    /// CHECK: the seat hand PDA, checked in the handler.
    #[account(mut)]
    pub target: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `target`.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, target.key().as_ref()],
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
    pub owner_session: Option<Signer<'info>>,
}

/// `start_hand`: authority starts the salt round for the next hand.
#[derive(Accounts)]
pub struct StartHand<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [TABLE_SEED, authority.key().as_ref(), &config.table_id.to_le_bytes()], bump = config.bump, has_one = authority)]
    pub config: Account<'info, TableConfig>,
    #[account(mut, seeds = [RUNTIME_SEED, config.key().as_ref()], bump = runtime.bump, has_one = authority, has_one = config)]
    pub runtime: Account<'info, TableRuntime>,
}

/// `submit_salt`: signed by the seat's session key.
#[derive(Accounts)]
pub struct SubmitSalt<'info> {
    pub session: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Account<'info, TableRuntime>,
    /// CHECK: ephemeral salt PDA, checked by seeds, owner and tag.
    #[account(mut, owner = crate::ID)]
    pub salt: UncheckedAccount<'info>,
}

/// `rotate_session`: signed by the seat's wallet inside PER.
#[derive(Accounts)]
pub struct RotateSession<'info> {
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Account<'info, TableRuntime>,
    /// CHECK: the seat hand PDA, checked in the handler.
    #[account(mut)]
    pub hand: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `hand`.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, hand.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub hand_permission: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `runtime`.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, runtime.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub runtime_permission: UncheckedAccount<'info>,
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

/// `poc_deal`: dealer state + one seat hand per occupied seat in
/// `remaining_accounts`, in seat order.
#[derive(Accounts)]
pub struct PocDeal<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump, has_one = authority)]
    pub runtime: Account<'info, TableRuntime>,
    /// CHECK: ephemeral dealer PDA, checked by seeds, owner and tag.
    #[account(mut, seeds = [DEALER_SEED, runtime.key().as_ref()], bump, owner = crate::ID)]
    pub dealer: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitTable<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump, has_one = authority)]
    pub runtime: Account<'info, TableRuntime>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use card_types::is_complete_deck;

    #[test]
    fn test_deck_is_a_full_deck_for_many_hands() {
        for hand in 0..200 {
            assert!(is_complete_deck(&poc_test_deck(hand)));
        }
    }

    #[test]
    fn six_seat_deal_matches_prd_map() {
        assert_eq!(deal_positions(0, 6), [0, 6, 12]);
        assert_eq!(deal_positions(5, 6), [5, 11, 17]);
        assert_eq!(deal_positions(1, 3), [1, 4, 7]);
    }

    #[test]
    fn ephemeral_budget_is_small_but_nonzero() {
        let b = ephemeral_budget();
        assert!(b > 0 && b < 1_000_000, "budget {b}");
    }
}
