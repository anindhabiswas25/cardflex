# CARD FLEX

## Product Requirements Document (PRD)

### End-to-End Devnet Implementation --- Engineering Specification

**Product:** Card Flex\
**Flagship Game:** Teen Patti\
**Network:** Solana Devnet\
**Document Type:** Product Requirements + Technical Implementation
Specification\
**Version:** 1.1\
**Status:** Updated Development Specification — MagicBlock-first Devnet architecture

------------------------------------------------------------------------

# 1. Executive Summary

Card Flex is a multiplayer Teen Patti gaming platform built on Solana.
It combines traditional Teen Patti gameplay with wallet-based funding,
real-time multiplayer infrastructure, cryptographically verifiable card
distribution, and on-chain financial records and settlement.

The initial release will run entirely on Solana Devnet. Players will
connect wallets, obtain Devnet SOL, join tables, play games, and test
deposits, gameplay accounting, withdrawals, and fairness verification
using test assets.

The objective is to build a production-oriented architecture during the
Devnet phase rather than a throwaway prototype.

The initial system uses:

-   Solana Devnet as the base layer for wallet funding, game registration,
    escrow, durable commitments, and final settlement.
-   MagicBlock Ephemeral Rollups (ER) for fast delegated game-state
    execution where public, high-frequency state is appropriate.
-   MagicBlock Private Ephemeral Rollups (PER) as the preferred
    TEE-backed execution environment for the private dealer and
    player-specific hidden-card state, subject to the Devnet POC gates
    in this document.
-   MagicBlock Solana VRF for verifiable deck randomness.
-   Rust for the Teen Patti engine, deterministic shuffle, and
    independent fairness verifier.
-   Anchor for Card Flex Solana programs and MagicBlock integration.
-   A backend for matchmaking, orchestration, authentication, and
    real-time communication.
-   PostgreSQL for durable records and Redis for presence and
    coordination.
-   WebSockets for client gameplay updates.
-   Next.js and TypeScript for the player application.

MagicBlock integrations must be hidden behind stable interfaces. The
game engine and fairness protocol must remain portable so a different
PER/TEE provider can replace MagicBlock without changing Teen Patti
rules, card serialization, or the public fairness-record format.

**Devnet security disclosure:** PER is a TEE-backed execution and
permissioning environment, not a claim that the entire application is
trustless. Card Flex must validate the actual deployed PER configuration,
attestation and permission behavior, account lifecycle, and failure
recovery. Ordinary ER state must be treated as publicly observable;
hidden card data must never be placed in an ordinary public ER account.
The local development fallback is not TEE-secure and must be visibly
labelled as such.

# 2. Product Vision and Principles

## 2.1 Vision

Build a globally accessible, reliable, and transparent multiplayer Teen
Patti platform where players enjoy familiar gameplay and can
independently verify completed games.

## 2.2 Product principles

1.  **Fairness first:** Card distribution must be reproducible and
    independently verifiable after a game.
2.  **Wallet simplicity:** Players should not sign a transaction for
    every Blind, Seen, or Chaal action.
3.  **Fast gameplay:** Normal gameplay actions should not require
    blockchain transactions.
4.  **Transparent accounting:** Game balances must reconcile with the
    underlying vault assets and recorded fees.
5.  **Security by design:** Private cards, player actions, wallet
    authorization, and settlement must have explicit security
    boundaries.
6.  **Modularity:** Major components must be independently testable and
    replaceable.
7.  **Production-oriented engineering:** Devnet code should follow
    production engineering standards even when infrastructure is
    simulated.
8.  **Honest trust assumptions:** Never describe a local dealer as a TEE
    or claim that a trusted-dealer settlement is trustless.

# 3. Scope

## 3.1 Included in Devnet V1

-   Wallet connection and signature-based authentication.
-   Player registration and profiles.
-   Devnet SOL balance display.
-   Test deposits and withdrawals.
-   Internal game balance and ledger.
-   Table discovery, creation, and joining.
-   Multiplayer matchmaking.
-   Waiting room and game lobby.
-   Real-time Teen Patti gameplay.
-   Blind, Seen, Chaal, Pack, Show, and Side Show.
-   Turn management and timeouts.
-   Disconnect and reconnect support.
-   Deterministic shuffle.
-   Private card distribution.
-   Authenticated card encryption.
-   Merkle deck commitment.
-   Public fairness records.
-   Independent fairness verification.
-   Result calculation and settlement.
-   Game history.
-   Admin monitoring.
-   Unit, integration, security, and end-to-end tests.

## 3.2 Explicitly out of scope for V1

-   Mainnet real-value gameplay.
-   AWS Nitro Enclave deployment.
-   Production TEE attestation verification.
-   Production custody infrastructure.
-   Tournaments.
-   Referral and affiliate systems.
-   FLEX token or NFTs.
-   Spectator betting.
-   Cross-chain functionality.
-   Advanced ranking and seasonal reward systems.
-   Additional card-game variants.

# 4. Users and Roles

### Player

Connects a Solana wallet, funds a Devnet game balance, joins a table,
and plays Teen Patti.

### Table creator

Creates a table with a boot amount, player capacity, and versioned
rules.

### Platform administrator

Monitors games, services, dealer health, financial reconciliation, and
incidents. Admins must not have an unaudited ability to alter cards or
completed results.

### Fairness verifier

Downloads a completed game's fairness record and independently checks
the shuffle, deck commitment, card assignment, result, and payout.

# 5. System Architecture

## 5.1 Logical architecture

``` text
Player Browser
    |
    v
Next.js Frontend
    |
    +--> Solana wallet / session authorization
    |
    v
Backend API / WebSocket Gateway
    |
    +--> Authentication and Player Module
    +--> Wallet and Ledger Module
    +--> Table and Matchmaking Module
    +--> Game Orchestrator
    +--> Teen Patti Engine (Rust)
    +--> Fairness / Verification Service
    +--> MagicBlock Adapter
    |       +--> Solana VRF request + verified callback
    |       +--> PER private dealer + private card accounts
    |       +--> ER/PER delegated gameplay state
    |
    v
Solana Devnet / Anchor Programs
    +--> Player vaults and escrow
    +--> Game registry and roster lock
    +--> VRF randomness record
    +--> Deck commitment / fairness record
    +--> Result verification and settlement

Infrastructure:
PostgreSQL | Redis | Object Storage | Background Workers
MagicBlock RPC / PER endpoints | Monitoring | CI/CD
```

## 5.1.1 MagicBlock execution boundary

-   Base Solana owns player vaults, escrow, deposits, withdrawals,
    durable game identity, and final payout authority.
-   MagicBlock PER executes the private dealer and enforces the
    configured account-level read/write permissions for hidden cards.
-   MagicBlock ER may execute high-frequency public gameplay state.
    Do not put hidden card plaintext in ordinary ER state.
-   Delegated game accounts must have explicit delegate, commit,
    finalize, and undelegate lifecycle handling.
-   Only the minimum state required for gameplay should be delegated.
-   Prize funds and withdrawal authority remain on base Solana. A
    delegated game account must never become the sole record of custody.
-   A PER outage must not make base-layer escrow inaccessible. The
    documented recovery path is to pause/void the game and refund or
    resolve according to the on-chain game policy.

## 5.1.2 MagicBlock integration references

Engineering must use the current official MagicBlock documentation and
pin compatible SDK/program versions at implementation time:

-   Ephemeral Rollups SDK: https://github.com/magicblock-labs/ephemeral-rollups-sdk
-   Solana VRF: https://github.com/magicblock-labs/solana-vrf
-   Private PER example: https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo
-   Delegation program: https://github.com/magicblock-labs/delegation-program

The examples are integration references, not production-ready Card Flex
dealer code. Confirm the actual Devnet endpoints, program IDs, queue
addresses, permission-program IDs, SDK compatibility, and service
availability before implementation.

## 5.2 Service responsibilities

### Frontend

Wallet connection, dashboard, table discovery, lobby, game UI, private
card rendering, betting controls, transaction status, history, and
fairness verification. The frontend must never determine the
authoritative game result.

### Backend

Authentication, sessions, player profiles, matchmaking, game
orchestration, action validation, WebSockets, persistence, transaction
orchestration, and fairness record publication.

### Teen Patti engine

A standalone deterministic Rust module. It must not depend on HTTP,
PostgreSQL, Redis, or Solana RPC.

### Private dealer

Receives a locked game context, obtains the configured randomness input,
derives the shuffle seed, shuffles, generates salts and Merkle root,
assigns cards, encrypts private cards, and produces fairness artifacts.

### Blockchain service

Handles PDA derivation, program instructions, deposits, withdrawals,
commitment recording, result recording, settlement, transaction
confirmation, and reconciliation.

### Fairness verifier

Independently verifies randomness evidence, shuffle reconstruction, deck
uniqueness, Merkle root, card proofs, dealing map, hand ranking, result,
and payout. It must not simply trust a dealer response such as
`verified: true`.

# 6. Technology Stack

  Layer                Technology
  -------------------- ------------------------------------------
  Web frontend         Next.js + TypeScript
  UI                   Tailwind CSS
  Wallet integration   Solana Wallet Adapter
  Solana client        A pinned Solana SDK / Solana Kit version
  Smart contracts      Rust + Anchor
  Game engine          Rust
  Fairness engine      Rust
  Backend              NestJS + TypeScript
  Real-time            WebSockets
  Database             PostgreSQL
  Cache and presence   Redis
  Background jobs      BullMQ initially
  Object storage       S3-compatible storage or MinIO
  API documentation    OpenAPI
  Rust tests           Cargo test + Proptest
  Contract tests       Anchor tests
  Frontend tests       Playwright
  Backend tests        Jest
  Monitoring           OpenTelemetry
  Local deployment     Docker Compose

Pin dependencies and commit lockfiles. Keep program IDs and deployment
configuration environment-specific. Never commit private keys or
production secrets.

# 7. Repository Structure

``` text
card-flex/
├── apps/
│   ├── web/
│   └── admin/
├── services/
│   ├── api/
│   ├── auth/
│   ├── player/
│   ├── wallet/
│   ├── matchmaking/
│   ├── game-orchestrator/
│   ├── fairness/
│   ├── blockchain/
│   └── verification/
├── crates/
│   ├── card-types/
│   ├── teen-patti-engine/
│   ├── shuffle-engine/
│   ├── fairness-core/
│   ├── private-dealer/
│   ├── local-dealer/
│   ├── fairness-verifier/
│   └── protocol-types/
├── programs/
│   └── card-flex/
├── packages/
│   ├── shared-types/
│   ├── api-client/
│   ├── ui/
│   └── config/
├── infra/
│   ├── docker/
│   ├── postgres/
│   ├── redis/
│   └── monitoring/
├── tests/
│   ├── integration/
│   ├── e2e/
│   ├── fairness/
│   └── security/
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── blockchain/
│   ├── fairness/
│   ├── game-rules/
│   └── operations/
├── docker-compose.yml
├── Cargo.toml
└── pnpm-workspace.yaml
```

A modular monolith is acceptable for the first deployment, but module
boundaries must remain explicit.

# 8. Wallet Integration and Authentication

## 8.1 Supported wallets

Initial support should include Phantom and Solflare through a compatible
Solana wallet adapter.

## 8.2 Authentication flow

1.  Player selects Connect Wallet.
2.  Wallet returns the public key.
3.  Frontend requests an authentication challenge.
4.  Backend generates a cryptographically random, single-use nonce.
5.  Player signs a domain-bound message.
6.  Backend verifies the signature and nonce.
7.  Backend issues a short-lived access token and refresh session.

The signed message must include domain, wallet address, nonce, issued
time, expiry, chain environment, and message version. Prevent nonce
reuse and validate the expected domain.

A wallet connection alone is not proof of wallet ownership. Never
request or store a seed phrase or wallet private key.

## 8.3 Session requirements

-   Access tokens expire.
-   Refresh sessions are revocable.
-   Sessions are bound to the wallet identity.
-   Sensitive actions require appropriate fresh authorization.
-   WebSocket connections authenticate using the established session.
-   Disconnecting a wallet must not erase persisted game history.

# 9. Player Profile and Dashboard

A profile should contain wallet address, display name, avatar,
registration time, games played, wins, losses, hands played, game
volume, history, and balance information.

The dashboard must display:

-   Connected wallet.
-   Wallet's Devnet SOL balance.
-   Card Flex game balance.
-   Available balance.
-   Locked balance.
-   Deposit and withdrawal actions.
-   Available tables.
-   Recent games.

The wallet's on-chain SOL balance and Card Flex's internal game balance
are different values and must be labelled clearly.

# 10. Deposits, Withdrawals, and Internal Ledger

## 10.1 Objective

A player funds their Card Flex balance once and can play multiple games
without approving a wallet transaction for every gameplay action.

## 10.2 Devnet model

Use a program-controlled vault and an internal player ledger. For the
initial implementation, prefer per-player vault PDAs for simpler
attribution and reconciliation.

The player deposits Devnet SOL. The backend credits the internal ledger
only after the deposit is confirmed and independently checked. Gameplay
updates the internal ledger. A player can withdraw only their available
funds through an authorized on-chain instruction.

## 10.3 Amount representation

All amounts must be represented as integer lamports. Never use
floating-point arithmetic for financial accounting.

Each player has:

-   `available_balance`
-   `locked_balance`
-   `withdrawable_balance`

Ledger entry types include deposit, lock, unlock, debit, credit, fee,
refund, and withdrawal.

## 10.4 Accounting invariants

1.  Available and locked balances cannot be negative.
2.  A game cannot debit more than the player's authorized balance.
3.  A deposit cannot be credited twice.
4.  A withdrawal cannot execute twice.
5.  A game settlement cannot execute twice.
6.  Total player liabilities must reconcile with vault assets,
    accounting for recorded fees and explicitly documented pending
    transfers.
7.  Every mutation must have a unique ID, idempotency key, and audit
    reference.

## 10.5 Deposit flow

1.  Player enters an amount.
2.  Blockchain service prepares a deposit transaction.
3.  Backend derives the player's vault PDA.
4.  Frontend receives an unsigned transaction.
5.  Wallet signs and submits it.
6.  Blockchain service waits for the configured confirmation level.
7.  Backend verifies program ID, instruction, signer, destination vault,
    amount, success, and unique transaction signature.
8.  Backend records the ledger credit.
9.  Frontend refreshes the balance.

A frontend success message is never evidence that a deposit succeeded.

## 10.6 Withdrawal flow

1.  Player requests a withdrawal.
2.  Backend checks available balance.
3.  Blockchain service prepares the instruction.
4.  Player authorizes the transaction.
5.  Program checks ownership, balance, and vault state.
6.  Program transfers SOL.
7.  Backend confirms the transaction.
8.  Ledger records the completed withdrawal.

If a transaction fails, the balance remains available. Pending
transactions must not be silently discarded.

# 11. Teen Patti Rules

## 11.1 Initial game configuration

-   Standard 52-card deck, no jokers.
-   Minimum players: 2.
-   Maximum players: 6.
-   Cards per player: 3.

All rules must be versioned.

## 11.2 Hand rankings

Highest to lowest:

1.  Trail / Trio.
2.  Pure Sequence.
3.  Sequence.
4.  Color / Flush.
5.  Pair.
6.  High Card.

## 11.3 Rules requiring explicit decisions

The game-rules document must specify:

-   Ace-high and Ace-low behavior.
-   A-2-3 ordering.
-   Tie-breaking rules.
-   Whether suit ranking exists.
-   Blind and Seen chaal multipliers.
-   Minimum and maximum chaal.
-   Show eligibility.
-   Side Show eligibility and acceptance.
-   Pack behavior.
-   Last-player behavior.
-   Timeout behavior.
-   Disconnect behavior.
-   All-in behavior, if supported.
-   Maximum pot.
-   Table closure.
-   Refund conditions.

No rule may be left to individual frontend or backend interpretation.

## 11.4 State machine

``` text
WAITING_FOR_PLAYERS
        |
        v
READY
        |
        v
ROSTER_LOCKED
        |
        v
RANDOMNESS_PENDING
        |
        v
DECK_COMMITTED
        |
        v
DEALING
        |
        v
BETTING_ROUND <----> SIDE_SHOW
        |
        v
SHOWDOWN
        |
        v
RESULT_VERIFICATION
        |
        v
SETTLEMENT_PENDING
        |
        v
COMPLETED
```

Cancellation and refund states must be defined separately. A completed
game must never return to an active betting state.

## 11.5 Player actions

-   JOIN
-   READY
-   BLIND
-   SEE
-   CHAAL
-   PACK
-   SHOW
-   SIDE_SHOW_REQUEST
-   SIDE_SHOW_ACCEPT
-   SIDE_SHOW_REJECT
-   RECONNECT

Every action contains game ID, player wallet, unique action ID, expected
sequence number, action type, payload, authenticated session, and
timestamp.

The server validates the action before applying it. Duplicate action IDs
must not debit a player twice or advance a turn twice.

# 12. Teen Patti Engine

The Rust engine is deterministic and independent of external
infrastructure.

## 12.1 Responsibilities

-   Validate game configuration.
-   Initialize games.
-   Track players and seats.
-   Track active players and blind/seen state.
-   Validate actions and turn order.
-   Calculate chaal amounts and pot.
-   Validate Side Show requests.
-   Handle packs and showdown eligibility.
-   Evaluate hands and select the winner.
-   Calculate fees and payouts.
-   Emit deterministic state transitions.

## 12.2 Illustrative types

``` rust
pub struct GameId(pub [u8; 32]);
pub struct PlayerId(pub [u8; 32]);

pub enum PlayerMode {
    Blind,
    Seen,
}

pub enum PlayerStatus {
    Active,
    Packed,
    Disconnected,
    Eliminated,
}

pub enum GameAction {
    Blind,
    See,
    Chaal { amount: u64 },
    Pack,
    Show,
    SideShowRequest,
    SideShowAccept,
    SideShowReject,
}

pub struct GameConfig {
    pub boot_amount: u64,
    pub min_players: u8,
    pub max_players: u8,
    pub max_pot: u64,
    pub fee_bps: u16,
    pub rules_version: u16,
}
```

The final types must include all state needed to reproduce a game from
its event history.

## 12.3 Engine invariants

-   Only the current player can act.
-   Only active players can perform gameplay actions.
-   A player cannot act twice in one turn.
-   A packed player cannot return to the same game.
-   Pot accounting reconciles after every accepted action.
-   Invalid chaal amounts are rejected.
-   A terminal game cannot accept further gameplay actions.
-   Hand ranking is deterministic.

Test all hand categories, ties, boundaries, invalid actions, turn order,
and state transitions. Use property-based tests for hand ranking and
accounting.

# 13. Fairness Protocol --- CF-Fairness v1

This is a core subsystem. Its exact serialization and cryptographic
behavior must be frozen and tested before implementation is considered
complete.

## 13.1 Objectives

-   Prevent card changes after commitment.
-   Ensure each player receives the assigned cards.
-   Ensure the deck contains exactly 52 unique cards.
-   Let players verify their cards against a public commitment.
-   Let independent verifiers reconstruct the completed shuffle.
-   Prevent normal application APIs from disclosing cards to
    unauthorized players.
-   Preserve evidence for dispute investigation.

## 13.2 Devnet trust model

The preferred Devnet dealer runs inside MagicBlock PER. PER is used for
TEE-backed execution and account-level read/write permissioning. The
Card Flex team must not assume that a permission configuration is
correct merely because the program deployed: the POC must prove that
unauthorized wallets, ordinary RPC clients, backend services, and other
table participants cannot retrieve another seat's plaintext cards.

Ordinary MagicBlock ER is not a privacy boundary. Hidden cards must
remain in PER-protected accounts or another explicitly approved
confidential channel.

For local unit tests, a deterministic in-process dealer may be used as
a test adapter. It is not a security boundary and must never be
presented as TEE-secure. The public Devnet environment must not silently
fall back from PER to a local or public-ER dealer if PER is unavailable;
the game must pause or follow its explicit cancellation/refund policy.

MagicBlock PER's TEE and permission behavior, including its current
hardware/attestation model, must be verified against the deployed
environment and current provider documentation before the system makes
a security claim.

## 13.3 Protocol architecture and MagicBlock flow

The fairness protocol remains provider-neutral at its core. MagicBlock
is the Devnet execution provider, not the definition of the card
cryptography.

**Selected Devnet flow:**

1. Create the canonical game and player roster on Solana. Assign stable
   seats, lock the roster, and derive a unique immutable game context.
2. Request randomness using MagicBlock Solana VRF. For the first Devnet
   integration, use the documented base-layer queue (`DEFAULT_QUEUE`)
   and verified callback path. This keeps the randomness record on
   Solana while the team validates the integration. A later experiment
   may use the Ephemeral queue after parity tests.
3. The callback must validate the VRF program identity/signer and bind
   the output to the exact game ID, locked roster hash, rules version,
   and one-time request seed. Reject duplicate or stale fulfillment.
4. Delegate only the required game-state accounts to the selected
   MagicBlock PER/ER environment. Hidden card state and dealer execution
   must use PER, not ordinary public ER.
5. Inside PER, derive the shuffle seed from the verified VRF output and
   canonical game context using the versioned CF-Fairness KDF. Run the
   deterministic Fisher-Yates shuffle with unbiased rejection sampling.
6. Generate per-position salts and a domain-separated Merkle root.
   Persist the commitment to the canonical base-layer game record before
   any card is delivered. If the chosen account lifecycle requires a
   PER commit/undelegate to make the commitment durable, complete and
   confirm that transition before dealing.
7. Create player-specific private card state. Configure read permissions
   so each wallet/session can read only its own cards. Configure writes
   so clients cannot alter card values, deck positions, salts, or dealer
   outputs. The dealer alone may initialize those fields.
8. Deliver cards through the PER-approved authenticated access path.
   The backend may relay encrypted or permissioned responses but must
   never receive a complete plaintext deck or another player's cards.
9. Execute real-time actions in the delegated game state. Use ER only
   for state that is intentionally public. If private game actions or
   card state are required, keep them in PER and validate access rules.
10. At game completion, commit/finalize/undelegate the required game
    record and return to base Solana. Publish the fairness record and
    reveal only the data required by the verification protocol.
11. The independent verifier reconstructs the deck from the published
    VRF output and protocol version, verifies the commitment and card
    assignment, evaluates the hand, and recomputes the payout.
12. The base-layer settlement instruction validates the approved
    result evidence and pays exactly once. The PER/backend result is
    evidence, not an unchecked authority to transfer escrow.

**Randomness choice:** MagicBlock Solana VRF uses a request-and-callback
model. The VRF program verifies the proof before invoking the consumer
callback. The callback must validate the VRF program identity and must
consume the output only for the matching pending game request. The
exact SDK version, queue address, callback account metas, and Devnet
deployment must be pinned in the implementation lockfile and deployment
manifest.

**Shuffle specification:** Keep the CF-Fairness deterministic shuffle,
HKDF-SHA256 domain separation, ChaCha20-based deterministic stream,
Fisher-Yates, rejection sampling, 52-card uniqueness checks, salts, and
Merkle commitment. Freeze the byte-consumption rules and publish test
vectors. Do not substitute a different PRNG merely because an example
application uses one.

**PER permission policy:** Define and test permissions for (a) dealer
initialization, (b) each player's read access to their own card account,
(c) denial of all other players' reads, (d) denial of all player writes
to card/deck data, and (e) controlled reveal after showdown. Session
authentication must bind the wallet, game, seat, expiry, and nonce.
Reconnection must restore the same cards and must not create a new
deal.

**Provider portability:** Define a `PrivateExecutionProvider` interface
for account creation, permission setup, dealer execution, private card
read, state recovery, commit, and undelegation. Keep MagicBlock-specific
account metas and RPC routing inside the adapter.

## 13.4 MagicBlock proof-of-concept acceptance gate

Do not mark the private dealer complete until all of the following
pass on the actual target Devnet environment:

-   Six distinct wallets join one locked-roster game.
-   MagicBlock VRF returns a verified callback for the exact game
    context; invalid proofs and wrong callback signers are rejected.
-   A deterministic deck is generated once and its commitment is
    recorded before the first card response.
-   Each player can retrieve exactly their own three cards.
-   Each player is denied access to all five other players' private card
    accounts through every supported RPC/subscription/API path.
-   Backend operators and ordinary ER clients cannot retrieve the
    complete plaintext deck from the configured PER interfaces.
-   Players cannot write or mutate private card data.
-   Reconnect returns the same cards and proof material.
-   PER restart, provider unavailability, and failed commit/undelegate
    transitions do not cause a second shuffle or duplicate deal.
-   After showdown, an independent Rust verifier reconstructs and
    validates the deck, dealing map, hand ranking, and payout.
-   Base-layer escrow remains safe and can be refunded under the
    documented failure policy if PER is unavailable.

If any privacy, permission, recovery, or attestation test fails, stop
the integration and do not advertise private/TEE-secure card dealing.
Use the local dealer only for isolated development tests, never as an
undisclosed public Devnet fallback.

## 13.7 Fairness lifecycle

### Step 1 --- Create game

Generate a unique cryptographic game ID. Record the program ID, rules
version, deck version, shuffle version, dealer protocol version, and
table configuration.

### Step 2 --- Join players

Players join using authenticated wallet identities. Assign unique seat
indices.

### Step 3 --- Lock roster

Freeze the roster and seat assignments. Compute a canonical roster hash.
Reject late joins. Bind the randomness request to this locked roster.

### Step 4 --- Obtain randomness

Use a documented randomness-provider adapter. A local deterministic
fixture may be used for development tests, but it must be labelled as a
test fixture, never as VRF.

A real Devnet VRF provider may be integrated after its current program
deployment, SDK, proof format, and verification method have been
confirmed.

Suggested interface:

``` rust
pub trait RandomnessProvider {
    fn request_randomness(
        &self,
        context: RandomnessContext
    ) -> Result<RandomnessRequest, RandomnessError>;

    fn get_randomness(
        &self,
        request_id: &str
    ) -> Result<RandomnessResult, RandomnessError>;
}
```

### Step 5 --- Derive shuffle seed

Conceptual derivation:

``` text
shuffle_seed = HKDF-SHA256(
    input_key_material = verified_randomness,
    salt = game_id,
    info = "CARD_FLEX_SHUFFLE_V1"
)
```

The protocol specification must define exact byte encodings, output
length, and domain separation. The randomness provider's actual output
format must be verified rather than assumed.

### Step 6 --- Shuffle deck

Use deterministic Fisher--Yates with a cryptographically secure
deterministic stream such as ChaCha20. Use rejection sampling for
bounded random integers; do not use naive modulo reduction.

Freeze the RNG algorithm, version, seed encoding, nonce encoding, byte
consumption rules, and shuffle iteration order.

### Step 7 --- Generate salts

Generate an independent cryptographically secure salt for every card
position. Bind each salt to the game and position.

### Step 8 --- Build Merkle commitment

Conceptual leaf:

``` text
leaf = SHA256(
    protocol_domain ||
    game_id ||
    position ||
    card_id ||
    salt
)
```

Define exact field encoding, integer byte order, domain separation,
padding from 52 to 64 leaves, empty-leaf behavior, parent hashing, and
proof ordering.

### Step 9 --- Commit root on-chain

Submit the root to the Anchor program before distributing private cards.
Reject unregistered dealers, incorrect game states, duplicate
commitments, mismatched game IDs, and commitments that do not match the
locked roster.

### Step 10 --- Deal cards

Use round-robin dealing. For six players:

  Player   Deck positions
  -------- ----------------
  P0       0, 6, 12
  P1       1, 7, 13
  P2       2, 8, 14
  P3       3, 9, 15
  P4       4, 10, 16
  P5       5, 11, 17

Record the complete dealing map in the fairness record.

### Step 11 --- Encrypt private cards

Use established authenticated cryptographic libraries:

-   X25519 for ephemeral key agreement.
-   HKDF-SHA256 for key derivation.
-   ChaCha20-Poly1305 for authenticated encryption.
-   Ed25519 for dealer signatures.

Bind ciphertext to game ID, player wallet, seat, card positions, packet
version, and packet sequence. Use unique nonces and separate signing and
encryption keys. Define key rotation and lifetime rules.

### Step 12 --- Deliver cards

The frontend receives only the requesting player's encrypted packet,
dealer ephemeral public key, nonce, metadata, signature, and Merkle
proofs. The player client decrypts locally and verifies the signature
and proofs before rendering the cards.

The backend must not receive plaintext card values through normal
application APIs.

### Step 13 --- Finalize game

Publish a fairness record containing game context, locked roster,
randomness evidence or test-fixture label, shuffle version, deck
commitment, dealing map, result, event-log hash, dealer signature, and
full deck/salts when disclosure is permitted.

Define reveal behavior for completed, cancelled, abandoned, and disputed
games. Do not reveal information that could compromise another active
game.

### Step 14 --- Independently verify

The verifier must:

1.  Validate game context and protocol versions.
2.  Validate randomness evidence according to the provider.
3.  Re-derive the shuffle seed.
4.  Reconstruct the shuffled deck.
5.  Confirm 52 unique cards.
6.  Reconstruct the Merkle root.
7.  Verify disclosed card proofs.
8.  Verify the dealing map and seat assignments.
9.  Recompute the showdown result.
10. Recompute fee and payout.
11. Compare computed values with published and on-chain records.

Return a detailed report. Any failed step must be visible.

# 14. Rust Crate Specifications

## 14.1 `card-types`

Shared card, suit, rank, game ID, player ID, position, rules version,
and serialization types.

## 14.2 `shuffle-engine`

Seed derivation, deterministic RNG initialization, Fisher--Yates
shuffle, unbiased bounded integer generation, and deck validation.

Illustrative API:

``` rust
pub struct ShuffleEngine;

impl ShuffleEngine {
    pub fn derive_seed(
        randomness: &[u8],
        game_context: &[u8]
    ) -> Result<[u8; 32], ShuffleError>;

    pub fn shuffle(
        seed: [u8; 32]
    ) -> Result<[u8; 52], ShuffleError>;
}
```

Replace ambiguous byte arrays with strongly typed protocol inputs in the
final implementation.

## 14.3 `fairness-core`

Card salts, Merkle leaves, root generation, proof generation, proof
verification, and fairness record serialization.

## 14.4 `private-dealer`

Defines the provider-neutral dealer interface and deterministic dealer
workflow. It must not import MagicBlock SDK types into the core protocol.

## 14.5 `magicblock-adapter`

Contains MagicBlock-specific integration only:

-   Solana VRF request instruction construction and callback account
    validation.
-   PER account creation and permission-program interactions.
-   ER/PER delegation, commit, finalize, and undelegation lifecycle.
-   RPC/WS routing based on account delegation status.
-   Provider error mapping, retry policy, and health checks.
-   Integration-test fixtures for the actual Devnet deployment.

Expose typed interfaces to the orchestrator. Keep provider-specific
account layouts and instruction builders out of `fairness-core`.

## 14.6 `fairness-verifier`

Independent offline verifier. It must not depend on MagicBlock runtime
availability to verify a completed public fairness record.

``` rust
pub trait PrivateDealer {
    async fn initialize_game(
        &self,
        context: GameContext
    ) -> Result<DealerGame, DealerError>;

    async fn commit_deck(
        &self,
        game_id: GameId
    ) -> Result<DeckCommitment, DealerError>;

    async fn get_private_cards(
        &self,
        request: CardRequest
    ) -> Result<EncryptedCardPacket, DealerError>;

    async fn finalize_game(
        &self,
        request: FinalizeRequest
    ) -> Result<FairnessRecord, DealerError>;
}
```

## 14.5 `local-dealer`

Devnet implementation. It must enforce state transitions and player
authorization, keep complete deck values out of normal API responses,
generate encrypted packets, and produce fairness artifacts.

## 14.6 `fairness-verifier`

Independent verifier. It must not ask the dealer whether the game is
fair.

## 14.7 `teen-patti-engine`

All game rules and deterministic state transitions.

The `MagicBlockPrivateDealer` must implement the provider-neutral
`PrivateDealer` interface. A local deterministic implementation exists
only for unit tests and must not be exposed as a public confidential
dealer.

# 15. Anchor Smart Contract Architecture

The Anchor program owns on-chain vault accounting, game commitments, and
permitted settlement transitions.

## 15.1 Program responsibilities

-   Initialize global configuration.
-   Register and revoke dealer keys.
-   Create games.
-   Register players.
-   Lock the roster.
-   Record randomness evidence or references.
-   Commit the deck root.
-   Record result evidence.
-   Manage player vaults.
-   Lock and unlock game funds.
-   Settle games.
-   Process refunds and withdrawals.

## 15.2 Accounts

### `GlobalConfig`

Authority, treasury, protocol version, fee basis points, pause state,
and bump.

### `DealerRegistry`

Approved MagicBlock PER execution/dealer identity, approved program
build or measurement reference where exposed by the provider, protocol
version, expiry, revoked flag, authority, and bump.

Do not treat a normal signing key as proof of TEE attestation. The
provider identity and attestation evidence must be checked according to
the current MagicBlock deployment's documented verification model.
Record what was actually verified; do not invent or assume a PCR/TDX
measurement field if the provider does not expose one to Card Flex.

### `GameAccount`

Game ID, creator, dealer key, rules version, shuffle version, status,
player count, roster hash, randomness reference, deck Merkle root,
fairness record hash, result hash, event sequence, pot, fee, winner, and
bump.

### `PlayerEntry`

Game account, wallet, seat index, status, locked amount, and bump.

### `PlayerVault`

Owner, available balance, locked balance, withdrawal accounting state,
and bump.

### `ResultAccount`

Game account, winner, result hash, pot, fee, payout, settlement status,
and bump.

## 15.3 PDA seeds

``` text
["global-config"]
["dealer-registry", dealer_pubkey]
["game", game_id]
["player-entry", game_pubkey, player_wallet]
["player-vault", player_wallet]
["result", game_pubkey]
```

Share PDA derivation test vectors between Rust and client code.

## 15.4 Instructions

-   `initialize`
-   `register_dealer`
-   `revoke_dealer`
-   `create_game`
-   `join_game`
-   `lock_roster`
-   `record_randomness`
-   `commit_deck`
-   `mark_dealt`
-   `record_result`
-   `settle_game`
-   `cancel_game`
-   `deposit`
-   `withdraw`

The exact account constraints, signer requirements, instruction
arguments, and state transitions must be documented in the Anchor IDL
and engineering specification.

## 15.5 Contract invariants

-   Only configured authority can change global configuration.
-   Only authorized dealer keys can perform dealer-specific actions.
-   A deck can be committed only once.
-   A game can settle only once.
-   A player can register only once per game.
-   Seat indices are unique.
-   Locked funds cannot be withdrawn.
-   Settlement cannot exceed the pot.
-   Fee basis points cannot exceed the configured maximum.
-   Winner must belong to the locked roster.
-   All state transitions are valid.
-   Account ownership, PDA seeds, and signer constraints are checked.

## 15.6 Settlement trust boundary

A provider/dealer signature proves only that the corresponding
registered identity signed the result. It does not independently prove
that the shuffle, card assignment, showdown, or payout is correct.

For Devnet V1, the settlement flow may use a clearly documented
provider-attested dealer result as an integration milestone, but it
must remain labelled as a trust assumption. The independent Rust
verifier must check the completed fairness record. Do not describe
signature-only settlement as trustless.

Before Mainnet, settlement needs stronger independent verification of
card assignment, showdown, hand ranking, winner, fee, and payout. A
Merkle proof alone proves membership in a committed deck; it does not
prove correct seat assignment or correct winner calculation.

# 16. Blockchain Transaction Design

Normal gameplay is off-chain. Do not submit a Solana transaction for
every Blind, Seen, or Chaal action.

On-chain transactions are reserved for deposits, required game
initialization, roster and deck commitments, fund locking where
applicable, result recording, settlement, refunds, and withdrawals.

The blockchain service must track signatures, confirm transactions at
the configured commitment level, handle expired blockhashes, retry
safely, prevent duplicate processing, reconcile on-chain state, and
distinguish pending, confirmed, finalized, and failed transactions.

A timed-out RPC request does not prove a transaction failed. Query the
signature and account state before retrying.

# 17. Backend API Specification

Base path: `/api/v1`

All endpoints require consistent validation, authentication, response
envelopes, and error codes.

## 17.1 MagicBlock orchestration

``` text
POST /games/:gameId/fairness/vrf-request
GET  /games/:gameId/fairness/vrf-status
POST /games/:gameId/delegation/prepare
POST /games/:gameId/delegation/confirm
GET  /games/:gameId/private-cards
POST /games/:gameId/private-session
POST /games/:gameId/commit
POST /games/:gameId/undelegate
GET  /games/:gameId/fairness/record
```

These are Card Flex backend routes, not MagicBlock provider endpoints.
The backend builds or relays transactions and reports confirmed state;
it must not forge VRF fulfillment, bypass PER permissions, or expose
private card account data. All mutating routes require authenticated
wallet/session authorization, idempotency keys, game-state checks, and
on-chain/PER confirmation.

## 17.2 Authentication

``` text
POST /auth/challenge
POST /auth/verify
POST /auth/refresh
POST /auth/logout
```

## 17.3 Player

``` text
GET    /players/me
PATCH  /players/me
GET    /players/me/balance
GET    /players/me/history
GET    /players/:wallet/profile
```

## 17.4 Wallet and ledger

``` text
POST /wallet/deposit/prepare
POST /wallet/deposit/confirm
POST /wallet/withdraw/prepare
POST /wallet/withdraw/confirm
GET  /wallet/transactions
GET  /wallet/balance
```

Confirmation endpoints must verify blockchain evidence and must not
accept arbitrary client claims.

## 17.5 Tables

``` text
GET  /tables
POST /tables
GET  /tables/:tableId
POST /tables/:tableId/join
POST /tables/:tableId/leave
POST /tables/:tableId/ready
```

## 17.6 Games

``` text
POST /games
GET  /games/:gameId
GET  /games/:gameId/history
POST /games/:gameId/actions
POST /games/:gameId/reconnect
POST /games/:gameId/cancel
```

## 17.7 Fairness

``` text
POST /fairness/:gameId/request-randomness
GET  /fairness/:gameId/status
POST /fairness/:gameId/commit
GET  /fairness/:gameId/commitment
GET  /fairness/:gameId/proof/:wallet
GET  /fairness/:gameId/record
GET  /fairness/:gameId/verification
```

## 17.8 Private card delivery

``` text
POST /games/:gameId/private-key
GET  /games/:gameId/private-cards
```

The client must authenticate and prove possession of the registered
encryption key. Return only the requesting player's encrypted packet.

## 17.9 Admin

``` text
GET /admin/health
GET /admin/games
GET /admin/dealer/status
GET /admin/ledger/reconciliation
GET /admin/transactions
GET /admin/incidents
```

Admin routes require role-based authorization and audit logging.

# 18. WebSocket Protocol

## 18.1 Client events

``` text
GAME_JOIN
PLAYER_READY
PLAYER_ACTION
PLAYER_RECONNECT
PRIVATE_KEY_REGISTER
REQUEST_PRIVATE_CARDS
PING
```

## 18.2 Server events

``` text
GAME_STATE
PLAYER_JOINED
PLAYER_LEFT
PLAYER_TURN
PLAYER_ACTION_ACCEPTED
PLAYER_ACTION_REJECTED
PRIVATE_CARD_PACKET
POT_UPDATED
PLAYER_PACKED
SIDE_SHOW_REQUESTED
SHOWDOWN
GAME_COMPLETED
FAIRNESS_STATUS
ERROR
PONG
```

## 18.3 Event envelope

``` json
{
  "event_id": "unique-event-id",
  "game_id": "game-id",
  "sequence": 42,
  "event_type": "PLAYER_ACTION_ACCEPTED",
  "timestamp": "ISO-8601",
  "payload": {}
}
```

## 18.4 WebSocket security

Authenticate connections, authorize game membership, validate schemas,
rate-limit events, prevent replay, validate action sequence, and never
broadcast private card values to the room. The server snapshot is
authoritative during reconnect.

# 19. Database Design

Use PostgreSQL for durable application records. Redis must not be the
only location for financial or important game state.

Required tables:

### `users`

`id`, `wallet_address`, `display_name`, `avatar_url`, `created_at`,
`updated_at`.

### `sessions`

`id`, `user_id`, `token_hash`, `expires_at`, `revoked_at`.

### `player_balances`

`user_id`, `available_lamports`, `locked_lamports`, `updated_at`.

### `ledger_entries`

`id`, `user_id`, `game_id`, `transaction_id`, `entry_type`,
`amount_lamports`, `direction`, `idempotency_key`, `created_at`.

### `tables`

`id`, `creator_id`, `boot_amount`, `min_players`, `max_players`,
`status`, `rules_version`, `created_at`.

### `games`

`id`, `table_id`, `status`, `rules_version`, `shuffle_version`,
`roster_hash`, `deck_root`, `result_hash`, `total_pot`, `fee_amount`,
`winner_id`, `created_at`, `completed_at`.

### `game_players`

`game_id`, `user_id`, `wallet_address`, `seat_index`, `player_status`,
`locked_amount`.

### `game_events`

`id`, `game_id`, `sequence`, `event_type`, `public_payload`,
`payload_hash`, `previous_event_hash`, `created_at`.

### `fairness_records`

`game_id`, `protocol_version`, `randomness_metadata`, `deck_root`,
`record_hash`, `storage_reference`, `signature`, `verification_status`.

### `blockchain_transactions`

`id`, `signature`, `wallet_address`, `transaction_type`,
`amount_lamports`, `status`, `confirmation_slot`, `created_at`.

### `dealer_sessions`

`game_id`, `dealer_key`, `dealer_version`, `state`, `created_at`.

Database requirements:

-   Use database transactions for ledger mutations.
-   Enforce unique idempotency keys.
-   Enforce unique game sequence numbers.
-   Keep append-only game events.
-   Do not overwrite completed game records.
-   Encrypt sensitive stored data.
-   Apply retention rules to private card delivery data.
-   Avoid plaintext private cards in general-purpose application tables.

# 20. Game Orchestrator

The orchestrator coordinates the complete game lifecycle:

1.  Receive game creation request.
2.  Verify player eligibility.
3.  Lock player funds.
4.  Wait for table readiness.
5.  Lock roster.
6.  Trigger randomness.
7.  Invoke dealer.
8.  Record commitment.
9.  Deliver private cards.
10. Start game engine.
11. Process player actions.
12. Persist events.
13. Manage timers.
14. Handle disconnections.
15. Trigger showdown.
16. Request result verification.
17. Trigger settlement.
18. Publish fairness record.

Every accepted state transition creates an event. Example event types:

``` text
GAME_CREATED
PLAYER_JOINED
PLAYER_READY
ROSTER_LOCKED
RANDOMNESS_REQUESTED
RANDOMNESS_RECEIVED
DECK_COMMITTED
CARDS_DISTRIBUTED
PLAYER_ACTION_ACCEPTED
PLAYER_PACKED
SHOWDOWN_STARTED
RESULT_VERIFIED
SETTLEMENT_SUBMITTED
GAME_COMPLETED
```

The current state must be reconstructible from persisted events and
validated snapshots.

# 21. Private Card Security

-   Store hidden cards in PER-protected player-specific accounts or an
    equivalently approved confidential channel; never in ordinary
    publicly readable ER state.
-   Enforce read access for only the assigned wallet/session and deny
    all player writes to card/deck fields.
-   Never send all player cards to the frontend.
-   Never broadcast private cards through room events.
-   Never expose plaintext card values in ordinary logs or analytics.
-   Bind every private response to game, wallet, seat, protocol version,
    request nonce, and packet sequence.
-   Verify the dealer/provider response and Merkle proofs before
    displaying cards.
-   Reject packets for another game or wallet and reject stale/replayed
    sequences.
-   Reconnect must retrieve the original deal, never trigger a redraw.
-   PER outage must pause or void the game under explicit policy; never
    silently switch to a less private execution mode.

The security test suite must probe direct RPC, subscriptions, backend
routes, session reuse, account enumeration, permission changes, and
unauthorized writes. A successful UI test is not evidence of privacy.

# 22. Fairness Verification Interface

Every completed game must have a public verification page showing:

-   Game ID.
-   Player roster and seats.
-   Protocol version.
-   Randomness source and whether it was a real provider or test
    fixture.
-   Deck Merkle root.
-   On-chain commitment transaction.
-   Result transaction.
-   Winner, pot, fee, and payout.
-   Verification status.

The downloadable fairness record must be independently verifiable.

Example report:

``` text
Game context: VALID
Roster hash: VALID
Randomness evidence: VALID / TEST FIXTURE
Shuffle reconstruction: VALID
Deck uniqueness: VALID
Merkle root: VALID
Player card proofs: VALID
Dealing map: VALID
Hand ranking: VALID
Winner: VALID
Payout calculation: VALID
On-chain commitment: VALID
On-chain settlement: VALID
```

A failure in any required check must make the overall result INVALID or
INCOMPLETE. Never hide individual failures behind a green status.

# 23. Frontend Requirements

## 23.1 Screens

1.  Landing page.
2.  Connect wallet modal.
3.  Player dashboard.
4.  Table lobby.
5.  Create table modal.
6.  Waiting room.
7.  Active Teen Patti table.
8.  Deposit screen.
9.  Withdrawal screen.
10. Game history.
11. Game result screen.
12. Fairness verification page.
13. Player profile.
14. Error and transaction status screens.

## 23.2 Game table

Display table ID, boot amount, pot, player seats, display names, player
status, current turn, Blind/Seen status, the player's own three cards,
opponents' hidden cards, action timer, chaal amount, and available
actions.

## 23.3 Actions

Blind, See Cards, Chaal, Pack, Show, and Side Show. Only valid actions
are enabled. The UI must reflect authoritative server confirmation and
must not assume an action succeeded before acknowledgement.

## 23.4 UX

-   Responsive desktop and mobile layouts.
-   Smooth card animations.
-   Clear turn indicators.
-   Visible pot updates.
-   Reconnect support.
-   Loading and error states.
-   Transaction confirmation indicators.
-   Access to fairness verification after completion.

## 23.5 Visual direction

Use a premium, modern gaming aesthetic. Keep the table as the visual
focus and avoid clutter. Brand line: **Card Flex --- Play Blind. Play
Bold.**

# 24. Matchmaking and Table Management

Each table contains a unique ID, boot amount, minimum and maximum
players, rules version, game type, status, creator, and creation time.

Lifecycle:

``` text
CREATED -> WAITING -> READY -> STARTING -> IN_PROGRESS -> COMPLETED
```

Terminal alternatives include `CANCELLED`, `EXPIRED`, and `FAILED`.

Matchmaking must find compatible tables, respect boot amounts and
capacity, prevent duplicate membership, reject joins to locked tables,
remove stale reservations, and handle concurrent joins safely. Use
database transactions or another concurrency-safe mechanism to prevent
two players taking the same final seat.

# 25. Disconnects, Timeouts, and Recovery

## 25.1 Reconnection

1.  Authenticate the session.
2.  Validate game membership.
3.  Load authoritative game state.
4.  Return a snapshot and current event sequence.
5.  Re-establish private card delivery.
6.  Deliver only that player's authorized encrypted card packet.

## 25.2 Timeouts

Define action timeout, grace period, automatic action, pack behavior,
pause conditions, and behavior when all players disconnect. Rules must
be deterministic and versioned.

## 25.3 Dealer restart

A restart must not generate a different deck for the same game, create
another commitment, or trust a stale snapshot. Recover from the latest
valid durable state and validate it against immutable game context and
on-chain commitments.

# 26. Security Requirements

## 26.1 Application security

Validate inputs, rate-limit APIs, authenticate and authorize all
sensitive operations, protect against replay, apply CSRF protection
where applicable, use secure cookie settings, enforce admin roles,
protect secrets, scan dependencies, and maintain audit logs.

## 26.2 Blockchain security

Verify PDAs, account ownership, signers, state transitions, lamport
accounting, and fee limits. Prevent duplicate settlement and
unauthorized withdrawal. Guard against integer overflow and account
substitution.

## 26.3 Fairness security

Use cryptographically secure randomness, domain-separated hashing,
versioned deterministic shuffle, authenticated encryption, separate
signing and encryption keys, Merkle verification, and public
completed-game records. Never silently reshuffle or reroll randomness
because an outcome is inconvenient.

## 26.4 Threat model

  -----------------------------------------------------------------------
  Threat                              Required protection / limitation
  ----------------------------------- -----------------------------------
  Backend modifies cards              Commitment and independent
                                      verification

  Backend leaks cards                 Encryption and explicit Devnet
                                      trust disclosure

  Player replays actions              Idempotency and sequence validation

  Player joins twice                  Unique membership constraint

  Dealer changes deck                 On-chain root commitment

  Invalid card proof                  Independent Merkle verification

  Duplicate settlement                On-chain state checks

  Unauthorized withdrawal             Program-level authorization

  RPC timeout                         Transaction reconciliation

  Dealer restart                      Durable recovery and commitment
                                      checks

  Malicious admin                     Restricted permissions and audit
                                      logs

  Compromised local host              Not fully mitigated in Devnet;
                                      requires real TEE or stronger trust
                                      model
  -----------------------------------------------------------------------

# 27. Observability and Monitoring

Track:

-   Active players, tables, and games.
-   Table occupancy.
-   Game creation and completion rates.
-   Failed games.
-   Action acknowledgement latency.
-   WebSocket disconnects.
-   Dealer processing and card delivery latency.
-   Fairness verification failures.
-   Blockchain confirmation times.
-   Deposit and withdrawal failures.
-   Ledger reconciliation mismatches.
-   Settlement failures.

Logs should include request ID, game ID, table ID, action ID,
transaction signature, and service name where relevant.

Never log seed phrases, private keys, encryption private keys, plaintext
card data, or authentication tokens.

Alert on dealer unavailability, stuck games, repeated transaction
failures, ledger mismatch, invalid proofs, duplicate settlement
attempts, unusual withdrawals, and WebSocket failure spikes.

# 28. Devnet Deployment

## 28.1 Local development

Use Docker Compose for PostgreSQL, Redis, backend, workers, local object
storage, and monitoring. Run Rust crates locally and the frontend
through the monorepo development scripts.

## 28.2 Public Devnet environment

A public testing environment requires:

-   Public frontend hosting and API hosting.
-   Persistent PostgreSQL, Redis, and durable object storage.
-   Solana Devnet RPC access and deployed Card Flex Anchor programs.
-   MagicBlock Devnet access for the selected ER/PER environment.
-   MagicBlock Solana VRF Devnet queue/program configuration.
-   PER permission program and approved account permission policy.
-   Health monitoring, provider status checks, and error reporting.

Do not deploy a public local-dealer fallback. Local dealer mode is
restricted to local development and automated tests and must be clearly
labelled non-confidential.

A developer's laptop is suitable for private development, not a reliable
public game service. Free hosting tiers may sleep or impose bandwidth
and storage limits; validate them before promising continuous
availability.

## 28.3 Example environment

``` env
APP_ENV=development

SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=
CARD_FLEX_PROGRAM_ID=

DATABASE_URL=
REDIS_URL=

JWT_SECRET=
SESSION_SECRET=

DEALER_MODE=local
DEALER_SIGNING_KEY=
DEALER_PROTOCOL_VERSION=1

OBJECT_STORAGE_ENDPOINT=
OBJECT_STORAGE_BUCKET=

FRONTEND_URL=
API_BASE_URL=
```

Inject secrets securely and exclude them from Git. Do not use a real
wallet private key as a general application administrator key.

# 29. Testing Strategy

## 29.1 Rust unit tests

Shuffle: - Same seed produces same deck. - Different seeds produce
varied outputs. - Deck contains 52 unique cards. - No invalid card
IDs. - Rejection sampling is correct. - Version changes are explicit.

Merkle: - Valid proof succeeds. - Altered card, salt, position, game ID,
or root fails. - Malformed proof fails. - Padding rules are tested.

Game engine: - All six hand categories. - Tie-breaking. - Blind and Seen
transitions. - Valid and invalid chaal. - Pack, Show, Side Show. -
Timeout and disconnection. - Terminal states.

## 29.2 Backend integration tests

Wallet authentication, nonce replay rejection, table creation,
concurrent joins, game initialization, duplicate action rejection,
reconnection, private card authorization, dealer failure, database
recovery, and transaction reconciliation.

## 29.3 Anchor tests

Initialization, dealer registration/revocation, game creation, player
registration, roster locking, commitment, vault deposit, balance
locking, result recording, settlement, refund, and withdrawal. Include
negative tests for unauthorized and invalid operations.

## 29.4 Mandatory six-player E2E test

1.  Create six independent test wallets.
2.  Fund each with Devnet SOL.
3.  Connect all six players.
4.  Deposit a test amount.
5.  Create a Teen Patti table.
6.  Join all six players.
7.  Lock the roster.
8.  Generate the configured randomness input.
9.  Generate and shuffle the deck.
10. Create and record the Merkle root.
11. Distribute encrypted cards.
12. Verify each player's packet.
13. Play a complete game.
14. Exercise at least one Pack action.
15. Reach showdown.
16. Determine the winner.
17. Calculate pot and fee.
18. Record the result.
19. Settle the game.
20. Publish the fairness record.
21. Run independent verification.
22. Compare verifier output with the game result.
23. Verify ledger entries.
24. Verify on-chain vault balances.

The test fails if any stage produces inconsistent state.

## 29.5 Additional E2E scenarios

-   Two-player and six-player games.
-   Disconnect and reconnect.
-   Dealer restart during a game.
-   Duplicate action.
-   Duplicate settlement.
-   Invalid Merkle proof.
-   Player requests another player's cards.
-   RPC timeout during settlement.
-   Withdrawal of locked funds.
-   Cancellation and refund.
-   Database restart and recovery.

# 30. Performance Targets

These are initial targets, not measured claims.

  Metric                                 Initial target
  -------------------------------------- -----------------------------------
  Normal action acknowledgement          p95 below 200 ms
  Private card delivery                  p95 below 500 ms after commitment
  Reconnection                           Below 5 seconds
  Duplicate accepted actions             Zero
  Duplicate settlements                  Zero
  Unauthorized private card disclosure   Zero
  Financial reconciliation mismatch      Zero
  Completed game verification            100% of completed games

Measure backend, dealer, WebSocket, and Solana confirmation latency
separately. Do not include Solana finality in normal gameplay latency.

# 31. Admin Dashboard

### Overview

Total players, active players, active tables, active games, completed
games, and failed games.

### Game monitoring

Game ID, roster, state, current turn, pot, dealer status, commitment
status, and settlement status.

### Financial monitoring

Deposits, withdrawals, locked and available balances, vault balances,
pending transactions, and reconciliation discrepancies.

### Fairness monitoring

Dealer version, protocol version, deck commitment, fairness record
status, verification status, and failed verification attempts.

Admin access must be role-restricted and audited. There must be no
hidden ability to rewrite cards or completed results.

# 32. Required Engineering Documentation

Deliver and maintain:

1.  System architecture.
2.  Repository setup.
3.  Environment configuration.
4.  Database schema and migrations.
5.  API specification.
6.  WebSocket event specification.
7.  Teen Patti rules.
8.  Game state machine.
9.  Fairness protocol.
10. Cryptographic test vectors.
11. Anchor account and instruction specification.
12. PDA derivation specification.
13. Deposit and withdrawal flows.
14. Settlement specification.
15. Threat model.
16. Deployment instructions.
17. Incident and recovery procedures.
18. Devnet testing instructions.

All protocol fields need exact serialization definitions. Do not rely on
informal assumptions between services.

# 33. Development Phases and Milestones

## Phase 1 --- Foundation

Deliver monorepo, Rust workspace, Next.js app, NestJS backend,
PostgreSQL, Redis, Docker Compose, CI, environment configuration, and
shared types.

**Acceptance:** All services start locally, CI runs, migrations work,
health checks pass, and Rust tests execute.

## Phase 2 --- Wallet and player infrastructure

Deliver wallet adapter, authentication challenge, signature
verification, profiles, sessions, and Devnet balance display.

**Acceptance:** Players can connect and authenticate, nonce replay is
rejected, session revocation works, and wallet identity is consistent.

## Phase 3 --- Financial infrastructure

Deliver Anchor vault accounts, deposit/withdraw instructions, internal
ledger, balance locking, transaction monitoring, and reconciliation.

**Acceptance:** Deposits are credited once, withdrawals work, locked
balances cannot be withdrawn, and ledger reconciles with on-chain
assets.

## Phase 4 --- Teen Patti engine

Deliver card types, hand evaluator, state machine, action validation,
pot accounting, timeout handling, and rules versioning.

**Acceptance:** Rules tests pass, invalid actions fail, state is
deterministic, and pot calculations reconcile.

## Phase 5 --- MagicBlock and fairness foundation

Deliver the provider-neutral fairness core, MagicBlock VRF adapter,
PER account/permission adapter, delegation lifecycle, deterministic
shuffle, Merkle commitment, private card retrieval, and independent
verifier. First complete a six-wallet PER privacy POC before wiring it
into the full product.

**Acceptance:** Verified VRF callback is bound to the locked roster;
deck commitment precedes dealing; each wallet reads only its own cards;
unauthorized reads/writes fail across RPC and API paths; restart and
reconnect preserve the same deal; independent verification succeeds.

## Phase 6 --- Multiplayer backend

Deliver table management, matchmaking, orchestrator, WebSocket gateway,
event log, reconnection, and private card delivery.

**Acceptance:** Six players can join, each receives only their cards,
turn order is enforced, reconnect restores state, and duplicate actions
fail.

## Phase 7 --- Solana and MagicBlock game programs

Deliver configuration, game accounts, player entries, MagicBlock VRF
request/callback integration, delegation lifecycle, durable
commitments, result recording, base-layer settlement, cancellation,
and refunds.

**Acceptance:** Instructions work on Devnet, invalid transitions and
unauthorized signers fail, duplicate settlement fails, and vault
accounting passes.

## Phase 8 --- Frontend completion

Deliver dashboard, lobby, create table, game table, private cards,
actions, result, fairness page, and transaction screens.

**Acceptance:** Full player journey works without developer tools;
authoritative state and errors are reflected correctly; desktop and
mobile layouts work.

## Phase 9 --- E2E Devnet release

Deliver public frontend, backend, persistent database, MagicBlock
VRF/PER integration, Devnet programs, monitoring, test instructions,
and end-to-end security/fairness report.

**Acceptance:** Six-player game completes, funds reconcile, settlement
is on-chain, fairness record is published, independent verification
succeeds, and recovery tests pass.

# 34. Definition of Done

A feature is not complete merely because its UI works. It must include
implementation, validation, error handling, tests, logging,
documentation, security review, and acceptance tests.

The Devnet release is complete only when:

1.  Players can connect wallets.
2.  Players can deposit Devnet SOL.
3.  Players can create and join tables.
4.  Six players can complete a Teen Patti game.
5.  Players receive private encrypted cards.
6.  Deck commitment is recorded on Solana.
7.  Actions are validated by the authoritative engine.
8.  Results are recorded.
9.  Settlement executes exactly once.
10. Balances reconcile.
11. The fairness record is published.
12. An independent verifier reconstructs and verifies the game.
13. Supported failures recover safely.
14. The interface clearly identifies the dealer as non-TEE.

# 35. MagicBlock Operations, Provider Portability, and Mainnet Readiness

## 35.1 Provider abstraction

``` text
PrivateExecutionProvider
    |
    +-- MagicBlockProvider (Devnet target)
    |      +-- Solana VRF adapter
    |      +-- PER private execution / permissions
    |      +-- ER/PER delegation lifecycle
    |
    +-- LocalTestProvider (tests only; never confidential)
    |
    +-- AlternativeTEEProvider (future, if required)
```

The orchestrator depends on the provider-neutral interface. The core
shuffle, dealing, rules, event model, fairness record, and verifier must
not depend on MagicBlock-specific types.

## 35.2 Required provider lifecycle

Implement and test:

-   Provider capability discovery and health checks.
-   Game/account delegation and confirmation.
-   PER permission initialization and verification.
-   VRF request, fulfillment, callback validation, and timeout handling.
-   Private dealer execution and per-player card retrieval.
-   Monotonic game sequence and replay protection.
-   Commit/finalize/undelegate operations.
-   Recovery from interrupted delegation and failed commits.
-   Provider outage handling and deterministic game cancellation.
-   Provider configuration, program IDs, queue addresses, and SDK
    versions pinned in deployment manifests.

Do not assume ephemeral-only accounts persist on Solana. Use delegated
accounts for state that must be committed back; use ephemeral-only
accounts only for data whose loss is explicitly acceptable.

## 35.3 Security and operational review before Mainnet

-   Independently review MagicBlock's current PER architecture,
    TEE/attestation model, permission program, and operator trust
    assumptions.
-   Verify deployed program IDs and code versions against approved
    artifacts.
-   Test unauthorized reads and writes at the RPC, subscription, and
    backend layers.
-   Test restart, rollback, replay, and state recovery behavior.
-   Review VRF request binding, callback signer validation, and
    randomness non-reuse.
-   Independently verify showdown logic and payout calculation.
-   Keep escrow and payout authority on base Solana.
-   Complete smart contract, backend, cryptographic, and infrastructure
    audits.
-   Complete incident response, monitoring, and provider-outage drills.
-   Complete legal and regulatory review in the operator's and target
    players' jurisdictions.

AWS Nitro Enclaves are no longer the planned Devnet dealer. They remain
a possible future alternative provider if Card Flex's security review,
availability requirements, or provider risk assessment justify a
migration. Do not implement a second TEE stack during the initial
Devnet milestone.

## 35.4 Mainnet security upgrade

Devnet success alone does not establish Mainnet readiness. Mainnet
requires production-grade provider review, independent result and
payout verification, audited escrow/settlement, permission and
confidentiality testing, key/session lifecycle review, operational
recovery, penetration testing, and jurisdiction-specific legal review.

# 36. Non-Negotiable Engineering Rules

1.  Do not build the entire game inside the smart contract.
2.  Do not submit a blockchain transaction for every player action.
3.  Do not expose the complete deck to the frontend.
4.  Do not trust client-reported game results.
5.  Do not allow the backend to silently modify committed cards.
6.  Do not use floating-point values for lamport accounting.
7.  Do not put hidden cards in ordinary public ER state.
8.  Do not describe local test mode as TEE-secure.
9.  Do not publish a test fixture as VRF.
10. Do not allow duplicate settlement.
11. Do not silently reroll randomness.
12. Do not invent custom cryptography when established libraries are
    available.
13. Do not skip negative tests.
14. Do not hardcode program IDs or wallet secrets.
15. Do not mark a feature complete without tests and documentation.
16. Do not launch Mainnet real-value gameplay based only on successful
    Devnet tests.

# 37. Final Deliverable

The completed Devnet platform must include:

-   Player-facing web application.
-   Wallet authentication.
-   Devnet SOL deposit and withdrawal.
-   Internal player ledger.
-   Multiplayer table management.
-   Full Teen Patti rules engine.
-   Real-time gameplay.
-   Private card distribution.
-   MagicBlock VRF integration.
-   MagicBlock PER private dealer and per-player permissioned card state.
-   MagicBlock ER/PER delegated gameplay-state lifecycle.
-   Cryptographic shuffle.
-   Merkle commitments.
-   Encrypted card delivery.
-   Independent fairness verifier.
-   Anchor smart contracts.
-   On-chain game records.
-   On-chain settlement.
-   Game history.
-   Admin dashboard.
-   Monitoring and logs.
-   Automated tests.
-   Deployment scripts.
-   Complete engineering documentation.

**End-to-end product goal:** A user opens Card Flex, connects a Solana
wallet, funds their Devnet game balance, joins a six-player Teen Patti
table, plays a complete game, receives a verifiable result, withdraws
their remaining Devnet SOL, and independently verifies the fairness
record.

That complete journey must work before the Devnet release is considered
complete.

------------------------------------------------------------------------

**CARD FLEX --- PLAY BLIND. PLAY BOLD.**
