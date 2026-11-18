# CARD FLEX

## Product Requirements Document (PRD)

### End-to-End Devnet Implementation --- Engineering Specification

**Product:** Card Flex\
**Flagship Game:** Teen Patti\
**Network:** Solana Devnet\
**Document Type:** Product Requirements + Technical Implementation
Specification\
**Version:** 1.2\
**Date:** 2026-11-18\
**Status:** Engineering baseline — supersedes v1.1. Sections 2, 4, 22, 27,
31 and 32 are unchanged from v1.1; §35 changes one sentence.\
**Companion documents:** `Card_Flex_Delivery_Plan.md`,
`Card_Flex_MagicBlock_Implementation_Research_v1.2.md`, `docs/adr/`

------------------------------------------------------------------------

# 0. Changes from v1.1

v1.1 contradicted the research document on who runs the game, and its
shuffle seed could be computed by anyone. v1.2 adopts ten decisions from the
delivery plan. Where this document and v1.1 differ, this document wins.

  ------------------------------------------------------------------------------------
  ID    Decision                                    Replaces in v1.1
  ----- ------------------------------------------- ----------------------------------
  D1    The Teen Patti game runs as the Card Flex   §12, §20 backend orchestrator and
        Anchor program inside MagicBlock PER. The   off-chain engine as authority
        program is the only authority for cards,
        turns, pots and winners.

  D2    The NestJS backend is non-authoritative:    §5.2, §17 game-action routes
        lobby, matchmaking, profiles, history
        indexer, admin, alerts.

  D3    Shuffle seed = HKDF over the VRF output     §13.3 step 5 and §13.7 step 5
        plus every seated player's secret salt.     (VRF-only seed, which is public)

  D4    Table-session money model: buy-in to a      §10 per-player vault, internal
        base-layer TableVault, chip stacks in PER,  ledger and per-game settlement
        cash-out from the last committed state.

  D5    TableVault is never delegated;              —
        `emergency_refund` works while PER is down.

  D6    Hidden cards are protected by PER read      §13.7 steps 11–12 (X25519
        permissions, a client-side Intel TDX        packets, dealer Ed25519 key)
        attestation check and per-card Merkle
        proofs. No custom packet encryption in V1.

  D7    After every hand all seed inputs are        —
        revealed so anyone can verify the hand.

  D8    Players sign game actions with a scoped     —
        session key and read private state with a
        PER auth token. The main wallet signs only
        buy-in and cash-out.

  D9    Turn timeouts run on MagicBlock cranks      §20, §25.2 backend timers
        (`ScheduleTask`), with a permissionless
        keeper as backup.

  D10   No public local-dealer fallback.            §28.3 `DEALER_MODE=local`
        `DEALER_MODE` has no default.
  ------------------------------------------------------------------------------------

Other corrections:

-   Duplicate section numbers in §14 are removed; `local-dealer` is a test
    adapter only.
-   Definition of Done item 14 ("identify the dealer as non-TEE") is
    replaced; it contradicted the PER design.
-   Release timing is gate-driven, not date-driven (§33).
-   **Amendment 1 (ADR 0002, CF-005):** account lifecycle. Secret accounts
    (`DealerState`, `SaltAccount`, `SeatHand`) are ephemeral-only and never
    committed. `HandRecord` and `HandSecrets` merge into a delegated
    `HandLog`. Money follows committed state through a base-layer
    `sync_hand`, and a refunded table ignores later commits instead of
    "rejecting" them. ADR 0002 overrides this document where they differ.
-   **Amendment 2 (ADR 0003, CF-008):** the byte-level fairness protocol is
    frozen in `docs/spec/cf-fairness-v2.md` with test vectors. The stream
    is a SHA-256 counter construction (not ChaCha20); leaf salts are
    `SHA256("CF_LEAF_SALT_V2" || seed || i)`; `caller_seed` has its own
    domain string. The spec overrides §13.3–13.4 where they differ.
-   In unchanged sections kept from v1.1, "game" means one **hand**, and
    "deposit/withdrawal/game balance" means **buy-in/cash-out/table stack**.

# 1. Executive Summary

Card Flex is a multiplayer Teen Patti platform on Solana. Players sit at a
table with a Devnet SOL buy-in, play hands with no wallet pop-ups, see only
their own cards, and can independently verify every completed hand.

The release runs on Solana Devnet with test assets. It is built to production
engineering standards rather than as a prototype.

The system uses:

-   **Solana base layer** for money and durable records: table vaults,
    buy-ins, cash-outs, refunds, configuration, committed hand records.
-   **MagicBlock Private Ephemeral Rollup (PER)** to run the Card Flex
    program for live play: table state, private hands, the dealer, betting
    and showdown. PER runs in Intel TDX and enforces per-account read
    permissions.
-   **MagicBlock VRF** for verifiable randomness, combined with secret
    per-player salts so nobody can predict the deck.
-   **MagicBlock cranks** for turn timeouts.
-   **Rust** for the program, the shared Teen Patti rules crate and the
    independent verifier (also compiled to WebAssembly for the browser).
-   **Next.js + TypeScript** for the player app, talking to PER directly.
-   **NestJS, PostgreSQL and Redis** for a non-authoritative backend:
    lobby, matchmaking, profiles, history indexing, admin and monitoring.

The fairness protocol and rules stay provider-neutral so a different
private-execution provider can replace MagicBlock without changing rules,
card encoding or the public fairness record.

**Security disclosure:** PER is a TEE-backed environment operated by
MagicBlock. Card privacy and correct execution depend on that TEE and its
operator. Card Flex verifies attestation client-side, publishes every
hand's seed inputs for independent verification, keeps all money on the
base layer, and says this plainly in the product. It is not described as
trustless.

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

-   Wallet connection and signature-based authentication (backend login).
-   Scoped session keys for in-game actions; PER auth token for private
    reads.
-   Player profiles and history.
-   Table discovery, creation, joining and leaving.
-   Table buy-in and cash-out in Devnet SOL; chip stacks per seat.
-   Real-time Teen Patti: Blind, See, Chaal, Pack, Show, Side Show.
-   Turn management and crank-driven timeouts.
-   Disconnect and reconnect to the same hand.
-   Fairness protocol CF-Fairness v2: salts + VRF, deterministic shuffle,
    Merkle commitment, full reveal after each hand.
-   Private hands in permissioned PER accounts.
-   On-chain showdown, pot settlement and rake.
-   Independent verifier (CLI and in-browser).
-   Emergency refund when PER is unavailable.
-   Admin monitoring (read-only over chain state).
-   Unit, program, privacy, recovery and end-to-end tests.

## 3.2 Explicitly out of scope for V1

-   Mainnet real-value gameplay.
-   Custom application-layer card encryption (X25519 packets).
-   AWS Nitro Enclaves or any second TEE provider.
-   Tournaments, referrals, affiliates.
-   FLEX token or NFTs.
-   Spectator betting.
-   Cross-chain functionality.
-   Ranking and seasonal rewards.
-   Card games other than Teen Patti.

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
Player browser (Next.js)
  |  wallet: buy-in, cash-out only
  |  session key: every game action
  |  PER auth token + TDX attestation check: private reads
  |
  +--------------------> Backend (NestJS, non-authoritative)
  |   lobby, history       auth, profiles, matchmaking, indexer, admin
  |                        PostgreSQL | Redis | monitoring
  |                              ^ reads committed state
  v                              |
MagicBlock PER (devnet-tee, Intel TDX) ---- commit per hand ----+
  Card Flex program (delegated accounts)                        |
    TableRuntime   seats, turn, pot, stacks   readers: seated   |
    SeatHand[0..5] 3 cards + proofs           reader: owner     |
    SaltAccount[]  player salts               readers: none     |
    DealerState    deck, seed inputs          readers: none     |
    crank          turn timeouts                                |
  ^                                                             v
  | VRF callback                                  Solana base layer
MagicBlock VRF                                      Card Flex program
                                                    GlobalConfig, TableConfig
                                                    TableVault (never delegated)
                                                    SeatLedger, HandRecord
                                                    cash_out, emergency_refund
```

## 5.1.1 Execution boundary

-   The base layer holds all lamports. `TableVault` is never delegated, so
    cash-out and emergency refund never depend on PER.
-   The Card Flex program runs inside PER for live play. It is the only
    writer of table, hand, dealer and salt state.
-   V1 uses one PER environment and no ordinary public ER. Hidden data is
    never placed in an account without an explicit permission list.
-   Only `TableRuntime` and `HandLog` are delegated. `DealerState`,
    `SaltAccount` and `SeatHand` are ephemeral-only accounts inside PER and
    are never committed (ADR 0002).
-   State returns to the base layer by commit after each hand and by
    commit-and-undelegate when a table closes.
-   If PER is unavailable, the table pauses. After the configured timeout,
    anyone can trigger `emergency_refund`, which pays seats from the last
    synced stacks.

## 5.1.2 MagicBlock integration references

Pinned versions and devnet addresses are recorded in
`docs/adr/0001-toolchain-pins.md`. References:

-   Docs: https://docs.magicblock.gg/
-   Ephemeral Rollups SDK: https://github.com/magicblock-labs/ephemeral-rollups-sdk
-   Solana VRF: https://github.com/magicblock-labs/solana-vrf
-   Delegation program: https://github.com/magicblock-labs/delegation-program
-   Engine examples: https://github.com/magicblock-labs/magicblock-engine-examples
-   Private payments demo: https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo

Devnet values from the docs (re-verify in CF-003/CF-004):

  Item                    Value
  ----------------------- ---------------------------------------------------
  TEE RPC                 `https://devnet-tee.magicblock.app`
  TEE validator           `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
  Delegation program      `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
  Permission program      `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`
  VRF program             `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`
  VRF callback identity   `9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw`
  VRF base queue          `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh`
  VRF ephemeral queue     `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`

## 5.2 Component responsibilities

### Player client

Wallet connection, session-key creation, PER auth token and attestation
check, table UI, private hand view, action submission straight to PER, live
updates via PER account subscriptions, in-browser verification. The client
never decides results; it renders confirmed program state.

### Backend

Login and profiles, lobby and matchmaking, indexing committed chain state
into PostgreSQL for history and search, publishing fairness records,
admin, alerts. The backend holds no keys that can move funds, change cards,
alter results or sign game actions. It is not in the action path; the game
keeps running if the backend is down.

### Card Flex program

One Anchor program with base-layer instructions (configuration, tables,
buy-in, cash-out, refunds, hand records) and PER instructions (permissions,
salts, VRF request and callback, dealing, actions, timeouts, showdown,
commits). Rules come from the shared `teen-patti-core` crate.

### Keeper

A permissionless script that calls timeout and liveness instructions if a
crank misses. Anyone may run it; it holds no special authority.

### Fairness verifier

Rebuilds a hand from its public record: seed, deck, Merkle root, dealing
map, actions, ranking, pot, rake and payouts. Uses `teen-patti-core`, but
not the program binary, and never asks the program or backend whether a
hand was fair.

# 6. Technology Stack

Versions are pinned in `toolchain.env` and enforced by
`scripts/check-toolchain.sh` (ADR 0001).

  Layer                     Technology
  ------------------------- ------------------------------------------------
  On-chain program          Rust 1.89.0, Anchor 1.1.2, Solana/Agave 3.1.10
  MagicBlock                ephemeral-rollups-sdk 0.17.3 (anchor, vrf,
                            access-control, crank); local stack via
                            @magicblock-labs/ephemeral-validator 1.1.1
  Rules and fairness        Rust `no_std` crates, also built to WASM
  Program tests             LiteSVM, local MagicBlock stack
  Web frontend              Next.js + TypeScript, Tailwind CSS
  Wallets                   Solana Wallet Adapter (Phantom, Solflare)
  Session keys              MagicBlock session keys (GPL Session)
  Backend                   NestJS + TypeScript (non-authoritative)
  Database / cache          PostgreSQL / Redis
  Jobs                      BullMQ (indexer, reconciliation)
  Monitoring                OpenTelemetry
  Frontend tests            Playwright
  Backend tests             Jest
  Rust tests                cargo test + proptest
  Package managers          cargo, pnpm 11.17.0 (Node 24.21.0)
  CI                        GitHub Actions

Commit lockfiles. Never commit keypairs, `.env` files or secrets.

# 7. Repository Structure

``` text
cardflex/
├── programs/
│   └── card-flex/           Anchor program (base + PER instructions)
├── crates/
│   ├── card-types/          canonical card encoding (done, CF-001)
│   ├── teen-patti-core/     rules, betting, ranking, settlement (no_std)
│   ├── fairness-core/       encodings, HKDF, shuffle, Merkle (no_std)
│   └── fairness-verifier/   CLI + WASM verifier
├── apps/
│   ├── web/                 player app
│   └── admin/               admin app
├── services/
│   └── api/                 NestJS backend + indexer
├── packages/
│   ├── client-sdk/          TS: PDAs, instructions, PER auth, subscriptions
│   └── protocol-types/      TS types generated from the IDL
├── scripts/                 toolchain check, keeper, probes
├── tests/
│   ├── privacy/             PER permission probe suite
│   ├── recovery/            outage and refund drills
│   └── e2e/                 six-player end-to-end
├── docs/
│   └── adr/                 architecture decision records
├── toolchain.env
├── Anchor.toml
├── Cargo.toml
└── pnpm-workspace.yaml
```

`crates/` must not depend on Solana, MagicBlock or network crates, so the
verifier can run anywhere.

# 8. Wallet Integration and Authentication

## 8.1 Supported wallets

Phantom and Solflare through the Solana Wallet Adapter.

## 8.2 Backend login

1.  Player selects Connect Wallet.
2.  Frontend requests a challenge.
3.  Backend returns a single-use random nonce.
4.  Player signs a domain-bound message containing domain, wallet
    address, nonce, issued time, expiry, cluster and message version.
5.  Backend verifies the signature and nonce, rejects reuse, and issues a
    short-lived access token and a revocable refresh session.

A wallet connection alone is not proof of ownership. Never request or store
a seed phrase or private key.

## 8.3 In-game authorization

Game actions do not go through the backend.

1.  When a player sits down, the client creates an ephemeral session
    keypair in memory (sessionStorage at most; never localStorage).
2.  The `buy_in` transaction, signed by the main wallet, also creates a
    session token bound to: wallet, table, seat, program ID, expiry
    (12 hours maximum) and allowed instructions.
3.  Allowed: `submit_salt`, `act`, `side_show_respond`, `leave_after_hand`.
    Denied: anything that moves lamports, changes configuration or touches
    dealer state.
4.  `cash_out` and `emergency_refund` always need the main wallet (or, for
    refund, are permissionless and pay only to the recorded wallet).
5.  The session is revoked on cash-out or expiry.

## 8.4 Private reads

To read its own `SeatHand`, the client:

1.  calls `verifyTeeRpcIntegrity` against the PER endpoint and refuses to
    continue if attestation fails;
2.  calls `getAuthToken` with the session key or wallet;
3.  reads and subscribes with that token.

PER login tokens and on-chain session tokens are separate mechanisms. The
token lifetime and refresh flow are open questions for MagicBlock (§35,
delivery plan §11).

# 9. Player Profile and Dashboard

A profile shows wallet address, display name, avatar, registration time,
hands played, hands won, total buy-ins, total cash-outs and history.

The dashboard shows:

-   Connected wallet and its Devnet SOL balance.
-   Open table seats and the stack at each (from committed chain state).
-   Pending cash-outs or refunds.
-   Available tables.
-   Recent hands with links to their verification pages.

Wallet balance and table stacks are different values and must be labelled
clearly.

# 10. Table Buy-in, Chip Stacks and Cash-out

## 10.1 Objective

A player funds a seat once and plays any number of hands without signing a
wallet transaction, and can always get their money back from the base layer.

## 10.2 Model

-   Each table has one `TableVault` PDA on the base layer holding all
    buy-ins in lamports. It is never delegated.
-   Each seat has a `SeatLedger` on the base layer recording the wallet,
    buy-in total, payout address (fixed at sit-down) and last committed
    stack.
-   Live stacks are fields in `TableRuntime` inside PER. They change with
    every bet and pot; no lamports move during play.
-   After each hand, the program commits `TableRuntime` and `HandLog` to
    the base layer. The permissionless base instruction `sync_hand` then
    updates `SeatLedger` stacks from the committed state (ADR 0002).

## 10.3 Amounts

All amounts are integer lamports (`u64`). Checked arithmetic everywhere; no
floating point.

## 10.4 Invariants

1.  `TableVault` lamports = sum of committed seat stacks + uncollected
    rake + rent reserve, exactly.
2.  A stack can never go negative.
3.  A player can't bet more than their stack.
4.  Buy-in is between the table's minimum and maximum (§11.3).
5.  No top-up during a hand.
6.  A seat can be cashed out only once per sit-down.
7.  Cash-out pays only to the payout address recorded at sit-down.
8.  Rake moves to the treasury only from committed hand results.

## 10.5 Buy-in flow

1.  Player picks a seat and amount.
2.  Client builds `buy_in` (wallet signs): transfers lamports to
    `TableVault`, creates `SeatLedger`, creates the session token.
3.  Program confirms the seat is free and the amount is in range.
4.  The seat enters `TableRuntime` at the next hand boundary through
    `join_seat` in PER.

## 10.6 Cash-out flow

1.  Player chooses Leave. The seat leaves at the end of the current hand.
2.  The hand result is committed; `SeatLedger` holds the final stack.
3.  Player signs `cash_out` on the base layer.
4.  Program checks the seat has left `TableRuntime` in committed state, then
    transfers the stack from `TableVault` to the payout address and closes
    `SeatLedger`.

## 10.7 Emergency refund

If no hand commit has arrived for `refund_timeout_secs` (proposed 900
seconds, stored in `GlobalConfig`) while a table is active, anyone can call
`emergency_refund`. It sets `TableConfig.status = REFUNDED` and pays every
seat its last synced stack. The interrupted hand was never synced, so its
boots and bets are returned automatically. Commits from PER can still land
afterwards, but `sync_hand` ignores them for a refunded table, so they can't
move money (ADR 0002).

# 11. Teen Patti Rules

All rules are versioned. This section defines `rules_version = 1`. No client
or backend may interpret them differently from `teen-patti-core`.

## 11.1 Configuration

-   52-card deck, no jokers.
-   2–6 players. 3 cards each, dealt round-robin starting at the seat left
    of the dealer button. The button moves one seat each hand.

## 11.2 Hand rankings

Highest to lowest: Trail, Pure Sequence, Sequence, Color, Pair, High Card.

## 11.3 Rule decisions (v1, pending sign-off in CF-014)

  -----------------------------------------------------------------------
  Rule             Decision
  ---------------- ------------------------------------------------------
  Sequences        A-K-Q highest, A-2-3 second, then K-Q-J down to 4-3-2

  Ties             No suit ranking. Compare the highest card down. An
                   exact tie splits the pot; any odd lamport goes to the
                   first tied seat clockwise from the button

  Boot             Fixed per table, collected from every seat at deal

  Blind bet        1× or 2× current stake. Maximum 4 blind turns, then
                   the player must See

  Seen bet         2× or 4× current stake

  Chaal limit      128× boot per bet

  Pot limit        1,024× boot; reaching it forces Show among active
                   players

  Show             Only with 2 players left. Costs the player's normal
                   bet. A blind player can't force Show on a seen player

  Side Show        A seen player asks the previous seen player; costs a
                   normal seen bet. The recipient accepts or rejects. On
                   accept the lower hand packs; on a tie the requester
                   packs

  Timeout          25 seconds per turn, then auto-pack. Disconnect counts
                   as timeout

  Last player      Wins the pot without showing; cards are still revealed
                   in the hand record

  Buy-in           Minimum 40× boot, maximum 200× boot. No top-up during a
                   hand. A stack below the boot sits out

  Rake             Basis points of the won pot, capped per hand, set in
                   `GlobalConfig` (maximum enforced by the program)

  Table close      Idle 10 minutes or all seats empty: commit, undelegate,
                   stacks cashable
  -----------------------------------------------------------------------

All-in is not supported in V1: a player who can't cover the required bet
must pack.

## 11.4 State machines

Table:

``` text
CREATED -> OPEN -> DELEGATED -> ACTIVE <-> BETWEEN_HANDS -> CLOSING -> CLOSED
                                  |
                                  +-> PAUSED -> REFUNDED   (PER unavailable)
```

Hand (inside PER):

``` text
WAITING_FOR_SEATS
  -> ROSTER_LOCKED        boot collected, hand_ctx fixed
  -> SALTS_PENDING        each seat submits a salt (deadline)
  -> VRF_PENDING          randomness requested
  -> DEALT                shuffle, deal, Merkle root
  -> BETTING <-> SIDE_SHOW
  -> SHOWDOWN
  -> SETTLED              pot and rake applied to stacks
  -> REVEALED             seed inputs published
  -> COMMITTED            hand record on base layer
```

Terminal alternative: `CANCELLED` (only before `DEALT`, e.g. too few salts;
boots returned). After `DEALT` a hand always finishes or the table is
refunded; it is never redealt.

## 11.5 Player actions

`submit_salt`, `blind`, `see`, `chaal{amount}`, `pack`, `show`,
`side_show_request`, `side_show_accept`, `side_show_reject`,
`leave_after_hand`.

Each action carries table, hand number, seat and the expected
`action_seq`, and is signed by the seat's session key. The program rejects
it unless the hand is in the right state, it is that seat's turn, the
sequence matches and the amount is legal. A replayed or stale action fails
on the sequence check and changes nothing.

# 12. Teen Patti Engine (`teen-patti-core`)

A deterministic `no_std` Rust crate used by the program, the verifier and
the browser (WASM). It has no I/O, clock, randomness or Solana types.

## 12.1 Responsibilities

-   Validate table configuration and rules version.
-   Track seats, button, active/packed status, blind/seen mode.
-   Validate actions: turn order, state, amounts, limits.
-   Pot, stake, rake and payout arithmetic.
-   Side Show and Show eligibility.
-   Hand evaluation and comparison.
-   Emit a deterministic next state for every accepted action.

## 12.2 Interface sketch

``` rust
pub fn apply(state: &HandState, seat: Seat, action: Action)
    -> Result<HandState, RuleError>;
pub fn timeout(state: &HandState) -> Result<HandState, RuleError>;
pub fn evaluate(cards: [Card; 3]) -> HandRank;   // total order
pub fn settle(state: &HandState, hands: &[[Card; 3]])
    -> Result<Settlement, RuleError>;          // payouts + rake
```

`HandState` contains everything needed to replay a hand from its action
log; the verifier replays the log and must reach the same settlement.

## 12.3 Invariants

-   Only the seat whose turn it is can act.
-   Packed seats never act again in that hand.
-   Sum of stacks + pot is constant within a hand except for rake at
    settlement.
-   Invalid amounts are rejected, never clamped.
-   A settled hand accepts no actions.
-   Ranking is a total order and deterministic.

## 12.4 Constraints from running on-chain

Every function must fit the Solana compute budget with margin. CF-011
measures evaluation, shuffle and settlement in compute units. No heap
allocation in hot paths. Test with property tests for ranking, betting
legality and stack conservation.

# 13. Fairness Protocol --- CF-Fairness v2

Exact byte encodings, test vectors and the Merkle construction are frozen in
CF-008 before any P2 code merges. This section is normative for the design;
CF-008 is normative for bytes.

## 13.1 Objectives

-   Nobody, including the operator, VRF oracle, backend or any player, can
    predict or bias the deck.
-   Cards can't change after the deal.
-   Each player sees only their own cards during play.
-   Anyone can rebuild and check any completed hand.
-   Failures lead to a recorded cancellation or refund, never a silent
    redeal.

## 13.2 Trust model

  -------------------------------------------------------------------------
  Party            Can                          Cannot
  ---------------- ---------------------------- ---------------------------
  VRF oracle       Know the VRF output          Know the salts, so can't
                                                predict the deck

  Each player      Know their own salt          Know others' salts or
                                                change theirs after the
                                                VRF request

  Backend          Read public and committed    Read hands, salts or
                   state                        DealerState; sign actions

  PER / TEE        See all state while running  Change rules or a committed
  operator         (trusted for privacy and     result without breaking
                   execution)                   attestation; avoid public
                                                verification of every hand
  -------------------------------------------------------------------------

The remaining trust is in the TEE and its operator. Mitigations are client
attestation checks, full public reveal, stake caps and the refund path.

## 13.3 Protocol

1.  **Lock roster.** At hand start the program fixes the seated roster and
    computes
    `hand_ctx = SHA256("CF_CTX_V2" || program_id || table || hand_no || roster_hash || rules_version || protocol_version)`.
2.  **Salt round.** Each seated client generates 32 random bytes with the
    browser CSPRNG and sends them in a `submit_salt` transaction into its
    own `SaltAccount` (no readers). The program stores the public
    commitment `c_i = SHA256("CF_SALT_V2" || hand_ctx || seat_i || salt_i)`
    in `TableRuntime`. A seat that misses the deadline is sat out for this
    hand and its boot is returned; the round restarts without it. This is
    allowed because no VRF request exists yet.
3.  **Request randomness** once every remaining seat has a salt, with
    `caller_seed = SHA256(hand_ctx || c_0 || ... || c_n)`. The callback
    uses `#[vrf_callback]` and checks the VRF program identity.
4.  **Derive the seed** in the callback:
    `seed = HKDF-SHA256(ikm = vrf_output || salt_0 || ... || salt_n, salt = hand_ctx, info = "CARD_FLEX_SHUFFLE_V2", L = 32)`.
5.  **Shuffle.** Fisher-Yates over the canonical deck (`card-types`) with
    an unbiased bounded generator (rejection sampling) driven by a
    deterministic stream from `seed`. The stream algorithm (ChaCha20 or a
    SHA-256 counter DRBG) is chosen in CF-011 by compute cost and frozen
    with test vectors.
6.  **Commit and deal.** Per-position salts are derived from `seed`; the
    Merkle root over the 52 positions is written to `TableRuntime`. Cards
    go to `SeatHand_i` round-robin from the seat left of the button
    (seat k of n receives deck positions k, k+n, k+2n). `DealerState` keeps
    the deck.
7.  **Play** under §11. Side Show temporarily grants the two players read
    access to each other's `SeatHand`, then revokes it.
8.  **Reveal.** At settlement the program copies `vrf_output`, all salts
    and the action log hash into `HandLog` (public) and commits it with
    `TableRuntime` to the base layer. The ephemeral secret accounts are
    reset for the next hand and are never committed.
9.  **Verify.** Anyone recomputes `hand_ctx`, every `c_i`, the seed, the
    deck, the Merkle root, the deal, the action replay, the ranking, the
    pot, rake and stacks, and compares them with the committed record.

## 13.4 Encoding rules (frozen in CF-008)

-   Integers little-endian, fixed width; strings are ASCII without a
    terminator; `||` is plain concatenation.
-   `roster_hash = SHA256("CF_ROSTER_V2" || n || (seat || wallet)*)`.
-   Merkle leaf:
    `SHA256(0x00 || "CF_CARD_LEAF_V2" || hand_ctx || position(u8) || card_id(u8) || leaf_salt(32))`;
    parent `SHA256(0x01 || left || right)`; 52 leaves padded to 64 with
    `SHA256(0x00 || "CF_EMPTY_LEAF_V2" || position)`.
-   `leaf_salt_i = HKDF-SHA256(seed, salt = hand_ctx, info = "CF_LEAF_SALT_V2" || i)`.

## 13.5 Rules that never bend

-   One shuffle per `hand_ctx`; a second VRF request for the same hand is
    rejected.
-   No reroll after a VRF request, for any reason.
-   Every cancellation records its reason and is visible in the hand record.
-   No hand data or salt appears in logs, events or errors.

## 13.6 Proof-of-concept gates

From the delivery plan; nothing is called private or fair until they pass
on the real Devnet PER.

-   **G1 privacy:** six wallets each read exactly their own three cards;
    every other `SeatHand`, `SaltAccount` and `DealerState` read fails
    through RPC, WebSocket, `getTransaction`, logs and session reuse;
    salt transaction contents are hidden from other seats; no player can
    write card state.
-   **G2 fairness:** the verifier rebuilds 10,000 test hands; spoofed VRF
    callbacks are rejected; a second shuffle is impossible; compute cost is
    measured.
-   **G3 recovery:** a PER outage mid-hand resumes the same state or
    refunds every seat exactly; no hand is dealt twice.

If any gate fails, stop and evaluate another provider (§35). Never fall
back to a non-confidential dealer in a public environment.

# 14. Rust Crate Specifications

## 14.1 `card-types` (done in CF-001)

Canonical one-byte card ids: `id = suit × 13 + (rank − 2)`, ids 0–51.
Frozen test vectors; changing them is a protocol version change.

## 14.2 `fairness-core`

`hand_ctx`, roster hash, salt commitments, HKDF seed, deterministic
stream, bounded sampling, Fisher-Yates, leaf salts, Merkle tree and proofs.
`no_std`, shared by program and verifier.

## 14.3 `teen-patti-core`

Rules, betting, evaluation, settlement (§12).

## 14.4 `fairness-verifier`

CLI and WASM. Input: a committed hand record. Output: a report of every
check in §22 with VALID, INVALID or INCOMPLETE. Depends on `card-types`,
`fairness-core` and `teen-patti-core`; never on the program crate or network
access.

## 14.5 `programs/card-flex`

The Anchor program (§15). MagicBlock-specific code (delegation, permission
CPIs, VRF, cranks) stays in program modules and `packages/client-sdk`, never
in the `crates/` above.

## 14.6 Test adapters

A deterministic in-process dealer may exist inside test code to generate
fixtures. It is never shipped, never deployed and never called a dealer in
product UI.

# 15. Card Flex Program Architecture

## 15.1 Responsibilities

Configuration and pause; table creation; buy-in and cash-out; delegation and
commits; permission setup; salt round; VRF request and callback; shuffle and
deal; actions and timeouts; showdown and settlement; reveal; emergency
refund.

## 15.2 Accounts

  --------------------------------------------------------------------------------
  Account          Layer          Readers (PER)        Writer      Purpose
  ---------------- -------------- -------------------- ----------- ---------------
  GlobalConfig     Base           public               authority   fee bps, max
                                                       (multisig)  rake, refund
                                                                   timeout, pause,
                                                                   treasury

  TableConfig      Base           public               creator,    boot, seats,
                                                       program     limits, rules
                                                                   version

  TableVault       Base, never    public               program     all lamports of
                   delegated                                       the table

  SeatLedger       Base           public               program     wallet, payout
                                                                   address,
                                                                   committed
                                                                   stack, session

  HandRecord       Base           public               program     committed hand
                                                       (commit)    result, root,
                                                                   reveal hash

  TableRuntime     PER            seated players +     program     seats, button,
                   (delegated)    backend indexer                  turn, pot,
                                                                   stacks,
                                                                   action_seq,
                                                                   salt
                                                                   commitments,
                                                                   Merkle root

  SeatHand[i]      PER            owner wallet and     program     3 cards, leaf
                   (delegated)    session key only                 salts, proofs

  SaltAccount[i]   PER            nobody               program     player salt
                   (delegated)                         (from owner
                                                       tx)

  DealerState      PER            nobody               program     deck, seed
                   (delegated)                                     inputs

  HandSecrets      PER, then      public after reveal  program     vrf output,
                   committed                                       salts, action
                                                                   log hash
  --------------------------------------------------------------------------------

Every delegated account must have its permission list set explicitly before
it holds any data. Empty-member-list behaviour is ambiguous in the docs and
is never relied on.

## 15.3 PDA seeds

``` text
["global-config"]
["table", table_id]
["table-vault", table]
["seat-ledger", table, seat_index]
["table-runtime", table]
["seat-hand", table, seat_index]
["salt", table, seat_index]
["dealer", table]
["hand-secrets", table]
["hand-record", table, hand_no]
```

PDA derivation test vectors are shared between Rust and `client-sdk`.

## 15.4 Instructions

Base layer: `initialize_config`, `update_config`, `set_pause`,
`create_table`, `buy_in`, `delegate_table`, `sync_hand`, `cash_out`,
`emergency_refund`, `close_table`. Account placement and lifecycle: ADR 0002,
which supersedes the §15.2 table where they differ.

PER: `setup_permissions`, `join_seat`, `start_hand`, `submit_salt`,
`request_shuffle`, `deal_callback` (VRF), `blind`, `see`, `chaal`, `pack`,
`show`, `side_show_request`, `side_show_respond`, `timeout_turn` (crank or
keeper), `settle_hand`, `commit_hand`, `leave_after_hand`,
`undelegate_table`.

Exact accounts, signers and arguments are defined in the Anchor IDL.

## 15.5 Invariants

-   Only the configured authority (a Squads multisig before public Devnet)
    changes `GlobalConfig`.
-   Rake bps never exceeds the configured maximum.
-   A hand is shuffled once and settled once.
-   A seat is taken once; seat indices are unique.
-   Committed stacks + rake + rent = vault lamports.
-   Cash-out pays only the recorded payout address, once.
-   `sync_hand` ignores commits for a refunded table.
-   PDAs, owners and signers are checked on every instruction; arithmetic
    is checked.

## 15.6 Settlement trust boundary

Settlement inside PER is computed by the program from on-chain rules. The
base layer accepts the result because the TEE validator committed it through
the delegation program. That relies on the TEE operator. It is mitigated,
not removed, by: public reveal and independent verification of every hand,
alerts on verification failures, table stake caps, and the ability to pause
tables. Before Mainnet, review whether additional on-chain checks of the
committed hand record are needed.

# 16. Blockchain Transaction Design

  -------------------------------------------------------------------------
  Signer              Transactions
  ------------------- -----------------------------------------------------
  Main wallet         `buy_in`, `cash_out`

  Session key         `submit_salt`, game actions, `leave_after_hand`

  Crank / keeper      `timeout_turn`, `start_hand`, `commit_hand`,
                      `emergency_refund` (permissionless where safe)

  Authority multisig  `initialize_config`, `update_config`, `set_pause`
  -------------------------------------------------------------------------

Game actions are PER transactions, not base-layer transactions. Each hand
produces one commit to the base layer; fund the commit fee payer so commits
never stall.

Clients and keepers track signatures, handle expired blockhashes, treat a
timeout as unknown (not failed) until the signature is checked, and never
resubmit an action with a stale `action_seq`.

# 17. Backend API Specification

Base path `/api/v1`. The backend serves reads and lobby features only.
No route builds, signs or relays a game action, and no route returns a
`SeatHand`, salt or `DealerState`.

## 17.1 Authentication

``` text
POST /auth/challenge
POST /auth/verify
POST /auth/refresh
POST /auth/logout
```

## 17.2 Players

``` text
GET   /players/me
PATCH /players/me
GET   /players/me/history
GET   /players/:wallet/profile
```

## 17.3 Tables and lobby

``` text
GET  /tables                 filter by boot, seats, status
GET  /tables/:tableId        config + latest committed state
POST /tables/:tableId/watch  lobby notifications
```

Table creation, buy-in and cash-out are wallet transactions built by
`client-sdk`; the backend indexes them.

## 17.4 Hands and fairness

``` text
GET /tables/:tableId/hands
GET /hands/:handId                   committed hand record
GET /hands/:handId/fairness-record   downloadable record
GET /hands/:handId/verification      server-side verifier report
```

The browser runs its own verifier; the server report is a convenience.

## 17.5 Admin

``` text
GET  /admin/health
GET  /admin/tables
GET  /admin/reconciliation
GET  /admin/verification-failures
GET  /admin/incidents
```

Admin routes are read-only, role-restricted and audited. Pausing or
config changes happen through the multisig, not the backend.

# 18. Real-time Protocol

## 18.1 Game state

Clients subscribe directly to PER over WebSocket:

-   `TableRuntime` for seats, turn, pot, stacks and the action sequence.
-   Their own `SeatHand` with the PER auth token.
-   `HandSecrets` after reveal.

Clients submit actions directly to the PER RPC. The UI shows an action as
pending until the program state reflects it.

## 18.2 Backend WebSocket

Used only for lobby, presence and notifications:

``` text
Client -> server: LOBBY_SUBSCRIBE, TABLE_WATCH, PING
Server -> client: TABLE_LISTED, TABLE_UPDATED, SEAT_OPENED,
                  HAND_COMMITTED, VERIFICATION_RESULT, ERROR, PONG
```

Envelope: `event_id`, `table_id`, `sequence`, `event_type`, `timestamp`,
`payload`. Authenticated, rate-limited, schema-validated. It never carries
card data.

# 19. Database Design

PostgreSQL is an index of chain state and app data. It is never the source
of truth for money, cards or results; on conflict, chain state wins.

Tables:

-   `users` (id, wallet_address, display_name, avatar_url, created_at)
-   `sessions` (id, user_id, token_hash, expires_at, revoked_at)
-   `tables` (table_pubkey, creator, boot, max_seats, rules_version,
    status, created_at)
-   `seats` (table_pubkey, seat_index, wallet, buy_in_lamports,
    committed_stack_lamports, status, joined_at, left_at)
-   `hands` (table_pubkey, hand_no, hand_ctx, merkle_root, pot_lamports,
    rake_lamports, winners, commit_signature, committed_at)
-   `hand_actions` (table_pubkey, hand_no, action_seq, seat, action,
    amount_lamports)
-   `fairness_records` (table_pubkey, hand_no, record_hash,
    storage_reference, verification_status, verified_at)
-   `chain_transactions` (signature, kind, wallet, amount_lamports, slot,
    status)
-   `incidents` (id, table_pubkey, kind, details, created_at, resolved_at)

Rules: idempotent indexing keyed by signature and `(table, hand_no,
action_seq)`; append-only hand data; a reconciliation job compares indexed
totals with vault balances and alerts on any difference. No plaintext
hands are stored before reveal.

# 20. Hand Lifecycle and Liveness

The program enforces every transition; nothing off-chain is required for
correctness. Liveness comes from:

  -----------------------------------------------------------------------
  Transition                   Triggered by
  ---------------------------- ------------------------------------------
  `start_hand`                 crank after the previous commit; keeper
                               fallback

  `submit_salt`                each seated client automatically

  Salt deadline                crank calls `start_hand` again without
                               the missing seats

  `request_shuffle`            last salt submission, or crank

  `deal_callback`              VRF program

  Player actions               session keys

  `timeout_turn`               crank at turn deadline; keeper fallback

  `settle_hand`, reveal,       program at showdown; crank fallback
  `commit_hand`

  `emergency_refund`           anyone, after `refund_timeout_secs`
  -----------------------------------------------------------------------

Every transition is idempotent or rejected on repeat. The backend may run
the keeper, but so may anyone else.

# 21. Private Card Security

-   Hidden data lives only in `SeatHand`, `SaltAccount` and `DealerState`,
    each with an explicit permission list (§15.2).
-   `TableRuntime` never contains card values or salts.
-   Program logs, events and error messages never contain card values,
    salts or seeds.
-   Salt transactions must not be visible to other seats; G1 tests this
    (`TX_MESSAGE` visibility).
-   The client checks TDX attestation before every new PER session and
    refuses to play if it fails.
-   Side Show grants read access to exactly two seats for exactly that
    comparison, then revokes it in the same hand.
-   Reconnect reads the same `SeatHand`; it never triggers a new deal.
-   PER outage pauses the table; there is no less private fallback.
-   The probe suite tests direct RPC, WebSocket subscriptions,
    `getTransaction`, `getProgramAccounts`, logs, session reuse after
    leaving, permission changes and unauthorized writes. A working UI is
    not evidence of privacy.

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

Landing, connect wallet, dashboard, table lobby, create table, table (with
buy-in), cash-out, hand history, hand result, verification page, profile,
transaction and error states, PER-unavailable and refund states.

## 23.2 Table view

Table ID, boot, pot, seats with names, stacks and status, button, current
turn and timer, blind/seen state, the player's own three cards, opponents'
hidden cards, legal actions with amounts.

## 23.3 Actions

Blind, See, Chaal, Pack, Show, Side Show. Only legal actions are enabled.
An action shows as pending until PER state confirms it.

## 23.4 UX

Responsive desktop and mobile; card animations; clear turn indicator;
visible pot changes; automatic reconnect; no wallet pop-ups during play;
an attestation badge with a plain-language explanation of what is trusted;
a link to verify every finished hand.

## 23.5 Visual direction

Premium, modern gaming look with the table as the focus. Brand line:
**Card Flex --- Play Blind. Play Bold.**

# 24. Matchmaking and Table Management

A table has an ID, boot, minimum and maximum seats, buy-in range, rules
version, creator and creation time, all in `TableConfig`.

The table lifecycle is the state machine in §11.4. The backend lists open
tables, filters by boot and seats, and suggests a table; seating itself is a
`buy_in` transaction, so two players can't take the same seat: the second
transaction fails on-chain. Players join at the next hand boundary.

# 25. Disconnects, Timeouts, and Recovery

## 25.1 Reconnect

1.  Re-check attestation and get a fresh PER auth token.
2.  Re-subscribe to `TableRuntime` and the player's `SeatHand`.
3.  Render from current program state; the session key resumes acting.

Target: under 3 seconds.

## 25.2 Timeouts

25 seconds per turn. At the deadline the crank calls `timeout_turn`, which
packs the seat. Disconnected players are treated the same; the table never
waits for one player.

## 25.3 PER outage

1.  Clients and the backend detect missing blocks or commits and show the
    table as paused.
2.  If PER recovers with state intact, the hand continues from the same
    state.
3.  If no commit arrives within `refund_timeout_secs`, anyone calls
    `emergency_refund` on the base layer (§10.7).
4.  A refunded table never resumes; `sync_hand` ignores its later commits.
5.  An incident record is created.

# 26. Security Requirements

## 26.1 Application security

Validate input, rate-limit APIs, authenticate sensitive routes, prevent
replay, secure cookies, CSRF protection where relevant, least-privilege
admin roles, audit logs, dependency scanning, secrets outside the repo.

## 26.2 Program security

Check PDAs, owners, signers and state on every instruction. Checked
arithmetic. Guard against account substitution, double settlement,
double cash-out, commits after refund and CPI spoofing (VRF callback
identity, `#[action]` handlers callable by anyone). Upgrade authority is a
Squads multisig with a timelock before public Devnet.

## 26.3 Fairness security

Salts plus VRF, frozen encodings, domain-separated hashing, no reroll, full
reveal, independent verification, alerts on any failed verification.

## 26.4 Threat model

  -------------------------------------------------------------------------
  Threat                         Protection
  ------------------------------ ------------------------------------------
  Player reads another hand      PER permissions; G1 probe suite

  Backend reads cards            Backend has no PER read rights to hidden
                                 accounts; nothing hidden passes through it

  VRF output predicts deck       Seed also needs every player's secret
                                 salt

  Player biases deck             Salts fixed before the VRF request

  Fake VRF callback              `#[vrf_callback]` / identity check

  Duplicate or stale action      `action_seq` check

  Session key theft              Scoped to one seat and table, short
                                 expiry, cannot move funds

  PER outage                     Pause; `emergency_refund` from base vault

  Operator aborts unfavourable   Cancellations recorded; alerts on
  hands                          abnormal rates; refunds published

  TEE or operator compromise     Attestation check, public reveal and
                                 verification, stake caps, disclosure

  Double cash-out                One-time `SeatLedger` close

  Malicious admin                No admin path to funds or cards;
                                 multisig for config

  Program upgrade abuse          Multisig + timelock
  -------------------------------------------------------------------------

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

`pnpm mb-stack` starts the local MagicBlock stack:

  Service                     Endpoint
  --------------------------- -----------------------------------------
  Solana base layer           http://127.0.0.1:8899 (ws :8900)
  Ephemeral rollup            http://127.0.0.1:7799 (ws :7800)
  Query filtering service     http://127.0.0.1:6699 (ws :6700)

The query filtering service emulates permission filtering without a TEE.
Local privacy tests do not prove Devnet privacy.

## 28.2 Public Devnet

Requires: deployed program with multisig upgrade authority, funded commit
fee payer, MagicBlock Devnet TEE endpoint, crank configuration, at least one
keeper, hosted frontend and backend, PostgreSQL, Redis, monitoring and
alerting. There is no local or non-TEE dealer in any public environment.

## 28.3 Environment

``` env
APP_ENV=
SOLANA_CLUSTER=
SOLANA_RPC_URL=
CARD_FLEX_PROGRAM_ID=
MB_TEE_RPC_URL=
MB_ROUTER_URL=
DEALER_MODE=          # no default; services refuse to start without it
DATABASE_URL=
REDIS_URL=
```

Secrets are injected at runtime and never committed.

# 29. Testing Strategy

## 29.1 Rust unit tests

-   `card-types`: encoding round trip and frozen vectors (done).
-   `fairness-core`: same inputs give the same deck; 52 unique cards;
    rejection sampling unbiased; frozen vectors for `hand_ctx`, seed, deck
    and Merkle root; altered card, salt, position or root fails.
-   `teen-patti-core`: every hand category, every tie rule, A-2-3 and
    A-K-Q, all betting limits, Show, Side Show, timeouts, stack
    conservation (property tests).

## 29.2 Program tests

LiteSVM for instruction logic; local MagicBlock stack for delegation,
permissions, cranks and VRF. Negative tests for every signer, state and
amount check.

## 29.3 Privacy probe suite (G1)

Run against local QFS and the real Devnet PER: every read path from §21 for
every hidden account, from each other seat, a fresh wallet, the backend's
key and an expired session.

## 29.4 Mandatory six-player E2E on Devnet

1.  Six funded test wallets connect and buy in.
2.  Attestation passes for each client.
3.  Salts submitted; VRF callback received; deal committed.
4.  Each player reads only their own cards; probes for others fail.
5.  A full hand is played including Pack, Side Show and Show.
6.  Settlement, reveal and commit succeed.
7.  The independent verifier passes on the hand record.
8.  Vault lamports equal committed stacks + rake + rent.
9.  All six cash out; balances match.

The test fails on any inconsistency.

## 29.5 Additional scenarios

Two-player hand; disconnect and reconnect mid-hand; missed salt; crank
timeout; keeper fallback; duplicate and stale actions; PER restart
mid-hand; PER outage leading to `emergency_refund`; commit after refund
rejected; double cash-out rejected; spoofed VRF callback rejected.

## 29.6 Backend tests

Login and nonce replay, indexer idempotency, reconciliation alerts,
admin authorization.

# 30. Performance Targets

Initial targets, to be measured from CF-003 onward. Base-layer finality is
never part of in-hand latency.

  Metric                                  Target (p95)
  --------------------------------------- ----------------------------------
  Action confirmed in PER                 < 200 ms
  Turn update to all seats                < 250 ms
  Own cards visible after deal            < 500 ms
  Next hand dealt (ephemeral / base VRF)  < 1 s / 1–5 s
  Reconnect to same hand                  < 3 s
  Duplicate accepted actions              0
  Unauthorized card disclosure            0
  Vault reconciliation mismatch           0
  Hands verified                          100%

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

Phases, gates and the backlog are in `Card_Flex_Delivery_Plan.md`. Progress
is gate-driven with no fixed release date; launch follows within one week of
P9 passing.

  ----------------------------------------------------------------------------
  Phase                  Exit / gate
  ---------------------- -----------------------------------------------------
  P0 Tooling and probes  Clean-checkout CI; latency and access measured
                         per region

  P1 Privacy POC         **G1**

  P2 Fairness v2         **G2**

  P3 Recovery            **G3**, go/no-go on MagicBlock

  P4 Rules engine        Rule vectors frozen (parallel from P0)

  P5 Game program        Two- and six-player hands on Devnet, no backend in
                         the action path

  P6 Money               Vault reconciles to the lamport; no double cash-out

  P7 Product             Full journey on desktop and mobile (parallel from
                         G1)

  P8 Hardening           50 concurrent tables; no open high-severity issues;
                         multisig in place

  P9 Devnet release      Six-player E2E passes on public Devnet
  ----------------------------------------------------------------------------

# 34. Definition of Done

A feature is done when it has implementation, validation, error handling,
tests (including negative tests), logging without secrets, documentation,
security review and passing acceptance tests. A working UI alone is not done.

The Devnet release is done when:

1.  Players connect wallets and pass attestation checks.
2.  Players buy in and cash out Devnet SOL.
3.  Players create, join and leave tables.
4.  Six players complete hands with no wallet pop-ups during play.
5.  Each player can read only their own cards (G1 on Devnet).
6.  Every hand uses salts + VRF and is committed to Solana.
7.  The program alone enforces rules, settlement and rake.
8.  Every hand is revealed and passes independent verification.
9.  Vault balances reconcile exactly.
10. Timeouts work without the backend.
11. PER outage leads to resume or exact refund (G3).
12. The UI states plainly what is trusted (the PER TEE and its operator)
    and links to verification.

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

MagicBlock-specific code stays in the program's provider modules and
`client-sdk` (§14.5). The core
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

1.  Never put hidden data in an account without an explicit permission
    list.
2.  Never let the backend sign game actions, move funds or read hidden
    accounts.
3.  Never delegate `TableVault`.
4.  Never derive the deck from public data alone.
5.  Never reroll or redeal a hand.
6.  Never log card values, salts or seeds.
7.  Never use floating point for lamports.
8.  Never trust client-reported results.
9.  Never run a non-confidential dealer in a public environment.
10. Never call the system trustless.
11. Never allow double settlement or double cash-out.
12. Never invent cryptography where established primitives exist.
13. Never skip negative tests.
14. Never hardcode secrets or commit keypairs.
15. Never change a pinned version or frozen encoding without an ADR.
16. Never launch real-value play on Devnet results alone.

# 37. Final Deliverable

-   Player web app and admin app.
-   Wallet login, session keys and attestation checks.
-   Table buy-in, chip stacks and cash-out in Devnet SOL.
-   Card Flex program running on the base layer and in MagicBlock PER.
-   Salt + VRF fairness protocol with Merkle commitments and full reveal.
-   Permissioned private hands.
-   Crank-driven timeouts and a permissionless keeper.
-   Emergency refund path.
-   Independent verifier (CLI and browser).
-   Indexer, history and fairness records.
-   Monitoring, alerts and runbooks.
-   Automated tests including the privacy probe suite and six-player E2E.
-   Engineering documentation and ADRs.

**End-to-end goal:** a player opens Card Flex, connects a wallet, buys in
to a six-player table, plays hands with no wallet pop-ups, sees only their
own cards, cashes out, and verifies every hand they played.

------------------------------------------------------------------------

**CARD FLEX --- PLAY BLIND. PLAY BOLD.**
