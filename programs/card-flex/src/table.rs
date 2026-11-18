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
pub const HAND_LOG_SEED: &[u8] = b"hand-log";
pub const VAULT_SEED: &[u8] = b"table-vault";
pub const LEDGER_SEED: &[u8] = b"seat-ledger";
/// ADR 0004: bounds for the per-table refund timeout.
pub const REFUND_TIMEOUT_MIN_SECS: u32 = 60;
pub const REFUND_TIMEOUT_MAX_SECS: u32 = 86_400;
pub const REFUND_TIMEOUT_DEFAULT_SECS: u32 = 3_600;
/// Rules v1 §6: buy-in between 40 and 200 boots.
pub const MIN_BUY_IN_BOOTS: u64 = 40;
pub const MAX_BUY_IN_BOOTS: u64 = 200;
/// Rules v1 §3: seconds a player has to act before anyone may time them out.
pub const TURN_SECS: i64 = 25;
/// Highest rake the program accepts: 10% of a won pot.
pub const MAX_RAKE_BPS: u16 = 1_000;

/// MagicBlock's TEE validator (Devnet and Mainnet PER). The only validator a
/// table may be delegated to; a table's committed state is trusted for money
/// only from it (security review: the authority must not choose).
pub const TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
/// Local MagicBlock stack validator, accepted only with feature `local-stack`.
pub const LOCAL_STACK_VALIDATOR: Pubkey = pubkey!("mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev");

pub fn allowed_validator(key: &Pubkey) -> bool {
    *key == TEE_VALIDATOR || (cfg!(feature = "local-stack") && *key == LOCAL_STACK_VALIDATOR)
}

/// Base-layer table status (ADR 0004). 0 is never a valid status.
pub mod status {
    pub const ACTIVE: u8 = 1;
    /// Emergency refund started: each seat claims its own payout.
    pub const REFUNDED: u8 = 2;
}
pub const SALT_TAG: &[u8; 8] = b"CFSALT02";
/// tag(8) + runtime(32) + seat(1) + hand_no(8) + salt(32)
pub const SALT_LEN: u32 = 81;
/// Teen Patti rules version bound into the hand context (PRD §11).
pub const RULES_VERSION: u16 = 1;
/// Slots to wait for a VRF callback before the hand may be cancelled.
/// About 30 s at the ~10 ms PER slot time measured in CF-003.
pub const VRF_TIMEOUT_SLOTS: u64 = 3_000;

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
    /// Deck shuffled from the seed, hands written, Merkle root public (CF-011).
    pub const DEALT: u8 = 5;
    /// Hand finished; only now may it be revealed. Set only by the game
    /// (`act` settling the hand: last player, Show or pot limit).
    pub const HAND_COMPLETE: u8 = 6;
    /// Seed inputs published in `HandLog` (spec §9, CF-012).
    pub const REVEALED: u8 = 7;
    /// P1 test-deck hand finished (feature `poc-test-deck` only). Not a real
    /// hand, so there is nothing to reveal and cleanup is allowed.
    pub const POC_DONE: u8 = 8;
}

pub const SEAT_HAND_TAG: &[u8; 8] = b"CFSEATHD";
pub const DEALER_TAG: &[u8; 8] = b"CFDEALER";
/// SeatHand layout (CF-011): tag(8), runtime(32), seat(1), hand_no(8),
/// cards(3), positions(3), leaf_salts(3×32), proofs(3×6×32).
/// Everything a player needs to check their own cards against the public
/// Merkle root during play (spec §7).
pub const SEAT_HAND_LEN: u32 = 727;
pub const HAND_CARDS: usize = 49;
pub const HAND_POSITIONS: usize = 52;
pub const HAND_LEAF_SALTS: usize = 55;
pub const HAND_PROOFS: usize = 151;
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
    // ---- ADR 0004 (P3) ----
    pub status: u8,
    /// Validator the runtime was delegated to (checked by `sync_hand`).
    pub validator: Pubkey,
    pub refund_timeout_secs: u32,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    /// Bit i set = seat i has a `SeatLedger` (bought in).
    pub seated: u8,
    /// Liveness clock: base-layer time of the last accepted `sync_hand`.
    pub last_sync_time: i64,
    pub last_synced_seq: u64,
    pub vault_bump: u8,
}

/// Holds every lamport of the table (ADR 0002/0004). Never delegated.
#[account]
#[derive(InitSpace)]
pub struct TableVault {}

/// One per bought-in seat. `synced_stack` is the only amount the base layer
/// will ever pay out for this seat (ADR 0004).
#[account]
#[derive(InitSpace)]
pub struct SeatLedger {
    pub config: Pubkey,
    pub seat: u8,
    /// Payout address, fixed at buy-in.
    pub wallet: Pubkey,
    pub buy_in: u64,
    pub synced_stack: u64,
    pub bump: u8,
}

/// Public record of the last revealed hand (ADR 0002 `HandLog`, spec §9).
/// Delegated with the runtime, committed back to Solana with it. Everything
/// here is public by design: it is what any verifier needs.
#[account]
#[derive(InitSpace)]
pub struct HandLog {
    pub runtime: Pubkey,
    pub config: Pubkey,
    pub hand_no: u64,
    pub rules_version: u16,
    pub protocol_version: u16,
    pub dealing_count: u8,
    /// Seat indices in dealing order.
    pub seats: [u8; MAX_SEATS],
    /// Wallets in dealing order.
    pub wallets: [Pubkey; MAX_SEATS],
    /// Salts in dealing order (revealed).
    pub salts: [[u8; 32]; MAX_SEATS],
    /// Commitments in dealing order.
    pub salt_commitments: [[u8; 32]; MAX_SEATS],
    pub hand_ctx: [u8; 32],
    pub roster_hash: [u8; 32],
    pub vrf_caller_seed: [u8; 32],
    pub vrf_output: [u8; 32],
    pub merkle_root: [u8; 32],
    pub revealed: bool,
    // ---- CF-021: the betting, for replay by any verifier ----
    // The action log itself lives in the raw tail after this struct (see
    // `ACTION_LOG_OFFSET`): Borsh would copy 1,600 bytes onto the 4 KB stack.
    /// Written at reveal: rules, starting stacks and the result, in dealing
    /// order. The verifier replays `actions` from `start_stacks` on the
    /// rebuilt deck and must arrive at exactly this result.
    pub boot: u64,
    pub rake_bps: u16,
    pub rake_cap: u64,
    pub start_stacks: [u64; MAX_SEATS],
    pub end_reason: u8,
    /// Bit i = seat index i won.
    pub winners: u8,
    pub payouts: [u64; MAX_SEATS],
    pub rake: u64,
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
    /// Deck commitment (spec §7), public once dealt.
    pub merkle_root: [u8; 32],
    /// Slot of the VRF request; `cancel_hand` is allowed after
    /// `VRF_TIMEOUT_SLOTS` without a callback.
    pub vrf_request_slot: u64,
    /// Hands cancelled at this table (public, for selective-abort monitoring).
    pub cancelled_hands: u32,
    /// Chip stacks per seat index, in lamports (ADR 0004; betting in P5).
    pub stacks: [u64; MAX_SEATS],
    /// Bumped by every `commit_hand`; `sync_hand` accepts only newer ones.
    pub commit_seq: u64,
    // ---- CF-020: rules and live hand ----
    pub boot: u64,
    pub rake_bps: u16,
    pub rake_cap: u64,
    /// Rake collected and not yet swept to the treasury (P6).
    pub rake_owed: u64,
    /// Bumped by every accepted `act`; callers pass the value they expect.
    pub action_seq: u64,
    pub game: GameState,
    /// CF-022: `side_show_viewers[s]` bit j = seat j's session may read seat
    /// s's hand this hand (granted by an accepted Side Show only).
    pub side_show_viewers: [u8; MAX_SEATS],
    /// Hand the viewers belong to.
    pub side_show_hand_no: u64,
    /// CF-023: unix time after which `timeout_turn` may act for the player to
    /// act (or the Side Show target). Reset by every action except See.
    pub turn_deadline: i64,
    /// CF-024: dealing starts with the first dealt seat after the button.
    /// Starts at `max_seats - 1` (first hand deals from seat 0); `next_hand`
    /// moves it to the seat that was dealt first.
    pub button: u8,
    pub bump: u8,
}

impl TableRuntime {
    /// True from `start_hand` until the hand is revealed (or cancelled). The
    /// ephemeral accounts that hold its salts, deck and hands must not be
    /// opened or closed then (security review: before the deal it would
    /// change the seed; after it, closing salts before the reveal would make
    /// the hand impossible to verify).
    pub fn hand_in_progress(&self) -> bool {
        matches!(
            self.phase,
            phase::SALTS_PENDING
                | phase::SALTS_DONE
                | phase::VRF_PENDING
                | phase::SEEDED
                | phase::DEALT
                | phase::HAND_COMPLETE
        )
    }

    pub fn seated(&self) -> impl Iterator<Item = usize> + '_ {
        (0..self.max_seats as usize).filter(move |i| self.occupied & (1 << i) != 0)
    }

    /// Seated seats in clockwise order starting left of the button.
    pub fn seated_from_button(&self) -> impl Iterator<Item = usize> + '_ {
        let m = self.max_seats as usize;
        let first = (self.button as usize + 1) % m.max(1);
        (0..m)
            .map(move |d| (first + d) % m)
            .filter(move |i| self.occupied & (1 << i) != 0)
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

/// `HandLog` action tail (CF-021), right after the Borsh struct:
/// `actions_hand_no` u64, `action_count` u16, then one byte per action
/// (`teen_patti_core::game::encode_action`).
pub const ACTION_LOG_OFFSET: usize = 8 + HandLog::INIT_SPACE;
pub const ACTION_LOG_ACTIONS: usize = ACTION_LOG_OFFSET + 10;
pub const HAND_LOG_LEN: usize = ACTION_LOG_ACTIONS + teen_patti_core::game::MAX_ACTIONS;

/// Reads (hand_no, count) of the action log tail.
pub fn action_log_header(data: &[u8]) -> (u64, u16) {
    let o = ACTION_LOG_OFFSET;
    (
        u64::from_le_bytes(data[o..o + 8].try_into().unwrap()),
        u16::from_le_bytes([data[o + 8], data[o + 9]]),
    )
}

/// One seat of the on-chain copy of `teen_patti_core::game::Hand`.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug,
)]
pub struct GameSeat {
    pub dealt: bool,
    pub active: bool,
    pub seen: bool,
    pub blind_turns: u8,
    pub stack: u64,
    pub contributed: u64,
}

/// On-chain copy of the rules engine's hand state (CF-020). Public: it holds
/// stacks, bets and turns, never cards.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug,
)]
pub struct GameState {
    pub boot: u64,
    pub chaal_limit_boots: u64,
    pub pot_limit_boots: u64,
    pub max_blind_turns: u8,
    pub rake_bps: u16,
    pub rake_cap: u64,
    pub seats: [GameSeat; MAX_SEATS],
    pub order: [u8; MAX_SEATS],
    pub n: u8,
    pub turn: u8,
    pub stake: u64,
    pub pot: u64,
    /// 0 betting, 1 side show pending, 2 over.
    pub phase: u8,
    pub ss_requester: u8,
    pub ss_target: u8,
    /// Settlement (valid when phase = 2): 0 last player, 1 show, 2 pot limit.
    pub end_reason: u8,
    pub winners: u8,
    pub payouts: [u64; MAX_SEATS],
    pub rake: u64,
}

impl GameState {
    pub fn from_hand(h: &teen_patti_core::game::Hand) -> GameState {
        use teen_patti_core::game::{EndReason, Phase};
        let (phase, ss_requester, ss_target) = match h.phase {
            Phase::Betting => (0, 0, 0),
            Phase::SideShow { requester, target } => (1, requester, target),
            Phase::Over => (2, 0, 0),
        };
        let st = h.settlement;
        GameState {
            boot: h.rules.boot,
            chaal_limit_boots: h.rules.chaal_limit_boots,
            pot_limit_boots: h.rules.pot_limit_boots,
            max_blind_turns: h.rules.max_blind_turns,
            rake_bps: h.rules.rake_bps,
            rake_cap: h.rules.rake_cap,
            seats: h.seats.map(|s| GameSeat {
                dealt: s.dealt,
                active: s.active,
                seen: s.seen,
                blind_turns: s.blind_turns,
                stack: s.stack,
                contributed: s.contributed,
            }),
            order: h.order,
            n: h.n,
            turn: h.turn,
            stake: h.stake,
            pot: h.pot,
            phase,
            ss_requester,
            ss_target,
            end_reason: match st.map(|s| s.reason) {
                Some(EndReason::Show) => 1,
                Some(EndReason::PotLimit) => 2,
                _ => 0,
            },
            winners: st.map(|s| s.winners).unwrap_or(0),
            payouts: st.map(|s| s.payouts).unwrap_or([0; MAX_SEATS]),
            rake: st.map(|s| s.rake).unwrap_or(0),
        }
    }

    pub fn to_hand(&self) -> teen_patti_core::game::Hand {
        use teen_patti_core::game::{EndReason, Hand, Phase, Rules, Seat, Settlement};
        let phase = match self.phase {
            0 => Phase::Betting,
            1 => Phase::SideShow {
                requester: self.ss_requester,
                target: self.ss_target,
            },
            _ => Phase::Over,
        };
        let settlement = (self.phase == 2).then_some(Settlement {
            reason: match self.end_reason {
                1 => EndReason::Show,
                2 => EndReason::PotLimit,
                _ => EndReason::LastPlayer,
            },
            winners: self.winners,
            payouts: self.payouts,
            rake: self.rake,
        });
        Hand {
            rules: Rules {
                boot: self.boot,
                chaal_limit_boots: self.chaal_limit_boots,
                pot_limit_boots: self.pot_limit_boots,
                max_blind_turns: self.max_blind_turns,
                rake_bps: self.rake_bps,
                rake_cap: self.rake_cap,
            },
            seats: self.seats.map(|s| Seat {
                dealt: s.dealt,
                active: s.active,
                seen: s.seen,
                blind_turns: s.blind_turns,
                stack: s.stack,
                contributed: s.contributed,
            }),
            order: self.order,
            n: self.n,
            turn: self.turn,
            stake: self.stake,
            pot: self.pot,
            phase,
            settlement,
        }
    }
}

/// Ranks of the hands dealt this hand, read from the private seat hands by
/// the program (never exposed). Implements the rules engine's oracle.
pub struct SeatHandOracle {
    pub ranks: [teen_patti_core::HandRank; MAX_SEATS],
}

impl teen_patti_core::game::HandOracle for SeatHandOracle {
    fn rank(&self, seat: u8) -> teen_patti_core::HandRank {
        self.ranks[seat as usize]
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

/// Result of dealing from a seed (spec §5–8), computed on the heap because
/// the full Merkle tree doesn't fit one 4 KB SBF stack frame.
pub struct DealOut {
    pub deck: [Card; DECK_SIZE],
    pub root: [u8; 32],
    /// For dealing-order seat k, card j: proofs[3k + j].
    pub proofs: Vec<[[u8; 32]; fairness_core::TREE_DEPTH]>,
}

pub fn compute_deal(hand_ctx: &[u8; 32], seed: &[u8; 32], seats: usize) -> DealOut {
    let (deck, _) = fairness_core::shuffle::<SolSha256>(seed);
    let mut level = vec![[0u8; 32]; fairness_core::TREE_LEAVES];
    fairness_core::fill_leaves::<SolSha256>(hand_ctx, seed, &deck, &mut level);
    let positions: Vec<usize> = (0..seats)
        .flat_map(|k| fairness_core::deal_positions(k, seats))
        .collect();
    let mut proofs = vec![[[0u8; 32]; fairness_core::TREE_DEPTH]; positions.len()];
    let root =
        fairness_core::root_and_proofs_in_place::<SolSha256>(&mut level, &positions, &mut proofs);
    DealOut { deck, root, proofs }
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
    pub config: Box<Account<'info, TableConfig>>,
    #[account(
        init,
        payer = authority,
        space = 8 + TableRuntime::INIT_SPACE,
        seeds = [RUNTIME_SEED, config.key().as_ref()],
        bump
    )]
    pub runtime: Box<Account<'info, TableRuntime>>,
    #[account(
        init,
        payer = authority,
        space = HAND_LOG_LEN,
        seeds = [HAND_LOG_SEED, runtime.key().as_ref()],
        bump
    )]
    pub hand_log: Box<Account<'info, HandLog>>,
    #[account(
        init,
        payer = authority,
        space = 8 + TableVault::INIT_SPACE,
        seeds = [VAULT_SEED, config.key().as_ref()],
        bump
    )]
    pub vault: Box<Account<'info, TableVault>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// `configure_table`: authority sets boot, rake and timeout before anyone
/// buys in (base layer, before delegation).
#[derive(Accounts)]
pub struct ConfigureTable<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub config: Box<Account<'info, TableConfig>>,
    #[account(mut, seeds = [RUNTIME_SEED, config.key().as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
}

/// `timeout_turn`: anyone, after the turn deadline. Seat hands of the dealt
/// seats follow in `remaining_accounts`, in dealing order (as for `act`).
#[derive(Accounts)]
pub struct TimeoutTurn<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    #[account(mut, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump = hand_log.bump)]
    pub hand_log: Box<Account<'info, HandLog>>,
}

/// `side_show_view`: updates the reader lists of two seat hands after an
/// accepted Side Show (grant) or after the hand (revoke). Permissionless.
#[derive(Accounts)]
pub struct SideShowView<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: seat hand PDA of `seat_a`, checked in the handler.
    #[account(mut)]
    pub hand_a: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `hand_a`.
    #[account(mut, seeds = [PERMISSION_SEED, hand_a.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_a: UncheckedAccount<'info>,
    /// CHECK: seat hand PDA of `seat_b`, checked in the handler.
    #[account(mut)]
    pub hand_b: UncheckedAccount<'info>,
    /// CHECK: permission PDA of `hand_b`.
    #[account(mut, seeds = [PERMISSION_SEED, hand_b.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub permission_b: UncheckedAccount<'info>,
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

/// `act`: one player action, signed by the seat's session key. Seat hands of
/// every dealt seat follow in `remaining_accounts`, in dealing order (the
/// program compares hands for Show, Side Show and the pot limit).
#[derive(Accounts)]
pub struct Act<'info> {
    pub session: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// Public action log (CF-021).
    #[account(mut, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump = hand_log.bump)]
    pub hand_log: Box<Account<'info, HandLog>>,
}

/// `buy_in`: a wallet takes a seat with lamports (base layer, before the
/// table is delegated).
#[derive(Accounts)]
#[instruction(seat: u8)]
pub struct BuyIn<'info> {
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, config.authority.as_ref(), &config.table_id.to_le_bytes()], bump = config.bump)]
    pub config: Box<Account<'info, TableConfig>>,
    #[account(mut, seeds = [RUNTIME_SEED, config.key().as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    #[account(mut, seeds = [VAULT_SEED, config.key().as_ref()], bump = config.vault_bump)]
    pub vault: Box<Account<'info, TableVault>>,
    #[account(
        init,
        payer = wallet,
        space = 8 + SeatLedger::INIT_SPACE,
        seeds = [LEDGER_SEED, config.key().as_ref(), &[seat]],
        bump
    )]
    pub ledger: Box<Account<'info, SeatLedger>>,
    pub system_program: Program<'info, System>,
}

/// `sync_hand`: anyone copies committed runtime state into the seat ledgers.
/// Seat ledgers of every bought-in seat follow in `remaining_accounts`, in
/// seat order.
#[derive(Accounts)]
pub struct SyncHand<'info> {
    #[account(mut, seeds = [TABLE_SEED, config.authority.as_ref(), &config.table_id.to_le_bytes()], bump = config.bump)]
    pub config: Box<Account<'info, TableConfig>>,
    /// CHECK: committed base-layer copy of the runtime; PDA, owner and
    /// delegation record are checked in the handler (ADR 0004).
    pub runtime: UncheckedAccount<'info>,
    /// CHECK: delegation record PDA of the runtime, checked in the handler.
    pub delegation_record: UncheckedAccount<'info>,
}

/// `emergency_refund`: anyone, after the liveness timeout. Only switches the
/// table to REFUNDED; payouts are claimed per seat (security review: one
/// failing payout must not block the others).
#[derive(Accounts)]
pub struct EmergencyRefund<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [TABLE_SEED, config.authority.as_ref(), &config.table_id.to_le_bytes()], bump = config.bump)]
    pub config: Box<Account<'info, TableConfig>>,
}

/// `claim_refund`: anyone pays one seat its synced stack after a refund.
#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [TABLE_SEED, config.authority.as_ref(), &config.table_id.to_le_bytes()], bump = config.bump)]
    pub config: Box<Account<'info, TableConfig>>,
    #[account(mut, seeds = [VAULT_SEED, config.key().as_ref()], bump = config.vault_bump)]
    pub vault: Box<Account<'info, TableVault>>,
    #[account(mut, seeds = [LEDGER_SEED, config.key().as_ref(), &[ledger.seat]], bump = ledger.bump, has_one = config, has_one = wallet)]
    pub ledger: Box<Account<'info, SeatLedger>>,
    /// CHECK: must equal the payout wallet recorded at buy-in (has_one).
    #[account(mut)]
    pub wallet: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateTable<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub config: Box<Account<'info, TableConfig>>,
    /// CHECK: the runtime PDA, checked by seeds; delegated by the SDK.
    #[account(mut, del, seeds = [RUNTIME_SEED, config.key().as_ref()], bump)]
    pub runtime: UncheckedAccount<'info>,
    /// CHECK: the hand-log PDA, checked by seeds; delegated with the runtime.
    #[account(mut, del, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump)]
    pub hand_log: UncheckedAccount<'info>,
    /// CHECK: validator identity, checked by the delegation program.
    pub validator: Option<UncheckedAccount<'info>>,
}

// ---------- PER ----------

/// Shared by the permission and ephemeral-account instructions.
#[derive(Accounts)]
pub struct TablePer<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump, has_one = authority)]
    pub runtime: Box<Account<'info, TableRuntime>>,
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
    pub runtime: Box<Account<'info, TableRuntime>>,
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
}

/// `start_hand`: authority starts the salt round for the next hand.
#[derive(Accounts)]
pub struct StartHand<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [TABLE_SEED, authority.key().as_ref(), &config.table_id.to_le_bytes()], bump = config.bump, has_one = authority)]
    pub config: Account<'info, TableConfig>,
    #[account(mut, seeds = [RUNTIME_SEED, config.key().as_ref()], bump = runtime.bump, has_one = authority, has_one = config)]
    pub runtime: Box<Account<'info, TableRuntime>>,
}

/// `submit_salt`: signed by the seat's session key.
#[derive(Accounts)]
pub struct SubmitSalt<'info> {
    pub session: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: ephemeral salt PDA, checked by seeds, owner and tag.
    #[account(mut, owner = crate::ID)]
    pub salt: UncheckedAccount<'info>,
}

/// `deal_hand`: anyone may trigger it once seeded; the result is fully
/// determined by the private seed. Seat hands follow in `remaining_accounts`
/// in dealing order.
#[derive(Accounts)]
pub struct DealHand<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: ephemeral dealer PDA, checked by seeds, owner and tag.
    #[account(mut, seeds = [DEALER_SEED, runtime.key().as_ref()], bump, owner = crate::ID)]
    pub dealer: UncheckedAccount<'info>,
}

/// `cancel_hand`: anyone may cancel a hand whose VRF callback is overdue.
#[derive(Accounts)]
pub struct CancelHand<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
}

/// `bench_deal`: no accounts, no state. Lets LiteSVM measure the compute
/// cost of the real deal path (PER hides compute units from clients).
/// TODO(P8): remove before public Devnet.
#[derive(Accounts)]
pub struct BenchDeal {}

/// `rotate_session`: signed by the seat's wallet inside PER.
#[derive(Accounts)]
pub struct RotateSession<'info> {
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
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
    pub runtime: Box<Account<'info, TableRuntime>>,
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
    pub runtime: Box<Account<'info, TableRuntime>>,
    #[account(mut, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump = hand_log.bump)]
    pub hand_log: Box<Account<'info, HandLog>>,
}

/// `commit_hand`: anyone may commit the table state (heartbeat / end of
/// hand) without undelegating (ADR 0004).
#[commit]
#[derive(Accounts)]
pub struct CommitHand<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    #[account(mut, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump = hand_log.bump)]
    pub hand_log: Box<Account<'info, HandLog>>,
}

/// `next_hand`: anyone, after a hand is revealed.
#[derive(Accounts)]
pub struct NextHand<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
}

/// `reveal_hand`: anyone may publish a dealt hand's seed inputs. Salt
/// accounts follow in `remaining_accounts`, in dealing order.
#[derive(Accounts)]
pub struct RevealHand<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [RUNTIME_SEED, runtime.config.as_ref()], bump = runtime.bump)]
    pub runtime: Box<Account<'info, TableRuntime>>,
    /// CHECK: ephemeral dealer PDA, checked by seeds, owner and tag.
    #[account(seeds = [DEALER_SEED, runtime.key().as_ref()], bump, owner = crate::ID)]
    pub dealer: UncheckedAccount<'info>,
    #[account(mut, seeds = [HAND_LOG_SEED, runtime.key().as_ref()], bump = hand_log.bump)]
    pub hand_log: Box<Account<'info, HandLog>>,
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
