# Card Flex --- MagicBlock Implementation Research

**Version:** 1.2\
**Date:** 18 November 2026\
**Target:** Card Flex Teen Patti on Solana Devnet\
**Architecture:** MagicBlock Private Ephemeral Rollup (PER), MagicBlock
VRF, Solana base-layer escrow and settlement.

## 1. Executive summary

Card Flex should use MagicBlock for confidential game execution, private
card delivery, verifiable randomness, and low-latency gameplay. Solana
base layer should remain responsible for durable financial records,
deposits, escrow, commitments, and settlement.

Recommended implementation order:

1.  Start the MagicBlock local stack and validate the toolchain.
2.  Build a six-wallet private-card proof of concept.
3.  Implement the VRF-plus-secret-nonce fairness protocol.
4.  Implement the Teen Patti rules and state machine in Rust/Anchor.
5.  Add scoped session keys and reconnect support.
6.  Add base-layer SOL escrow, settlement, and refunds.
7.  Run security, privacy, recovery, and load tests before any
    real-value launch.

**Do not launch real-value games until privacy, fairness, recovery,
settlement, legal, and security gates have passed.**

## 2. Product requirements

-   Teen Patti table size: typically 3--6 players.
-   Players deposit SOL into a Card Flex balance and use an internal
    game balance.
-   No wallet popup should be required for every blind, chaal, pack,
    side show, or show action.
-   Players must see only their own cards.
-   Players must be able to reconnect to the same game and same deal.
-   Backend must not choose cards, determine winners, alter pots, or
    redirect payouts.
-   Every action and settlement must be replay-safe and idempotent.
-   A failure must restore the same game or cause an auditable
    cancellation/refund---not a hidden redeal.

**Legal note:** Not targeting India does not remove legal obligations.
Real-money card games, custody, payments, age checks, sanctions, tax,
licensing, and consumer-protection rules depend on the operator's
jurisdiction and players' locations. Obtain qualified legal advice
before real-value play.

## 3. What MagicBlock provides

### 3.1 Ephemeral Rollups (ER)

ER is an SVM execution environment designed for fast state transitions.
It supports delegated execution, commit/finalize flows, RPC, and
WebSocket subscriptions.

Potential uses: - Frequent game actions. - Fast table-state updates. -
Live state subscriptions.

**Important:** ordinary public ER state is not private by default. Never
put plaintext hidden cards into a public ER account.

### 3.2 Private Ephemeral Rollups (PER)

PER adds confidential execution and account-level access controls.
MagicBlock's private-payments example demonstrates a TEE-backed
environment and middleware-enforced account read/write permissions.

Potential uses: - Private dealer execution. - Hidden deck and dealer
state. - Per-player hand accounts. - Restricted card reads.

PER does not make every account private automatically. Configure
permissions and test direct RPC, subscriptions, middleware, APIs, logs,
errors, and backend access.

A TEE is not the same as a trustless proof. Verify the actual Devnet
deployment, hardware and attestation model, approved software
measurement, key provisioning, provider controls, and recovery
guarantees.

### 3.3 MagicBlock VRF

MagicBlock VRF provides verifiable randomness and a callback flow. Use
the official protected callback mechanism (for example, the documented
`#[vrf_callback]` pattern). Do not replace it with a public instruction
that accepts caller-supplied random bytes.

VRF alone does not prove that the dealer shuffled correctly, dealt
correctly, or selected the correct winner. Card Flex still needs
deterministic rules, commitments, a complete reveal, and an independent
verifier.

### 3.4 Session Keys

Session Keys provide scoped secondary signing authority for frequent
actions. A session should be bound to a player and game, expire quickly,
and permit only approved gameplay instructions.

Allow: - Blind, see, chaal, pack, side show, show. - Carefully scoped
reconnect or timeout actions if required.

Deny: - Deck or card mutation. - Dealer nonce or randomness changes. -
Withdrawals. - Platform configuration changes. - Arbitrary instructions.

PER middleware sessions and on-chain Session Keys are separate
mechanisms. Prove how wallet challenge authentication, middleware
credentials, ephemeral signers, and on-chain session-token checks work
together. Do not assume they are interchangeable.

## 4. Recommended architecture

Start with **one PER execution environment and per-game account
namespaces**. Avoid splitting the first prototype across a public ER and
a separate PER until the privacy and lifecycle model is proven.

``` text
Next.js / TypeScript client
  ├─ Wallet connect, table UI, private hand view, session key
  │
NestJS backend
  ├─ Auth, matchmaking, table orchestration, WebSocket relay
  ├─ Transaction relay, presence, monitoring
  └─ Not authoritative for cards, winners, pots, or payouts
  │
MagicBlock PER
  ├─ Anchor Teen Patti program
  ├─ Public GameRuntime (turn, pot, seats, action sequence)
  ├─ Restricted DealerState (deck, nonce, shuffle state)
  └─ SeatHand[0..5] (each readable only by its owner)
  │
Solana base layer
  ├─ Config, player vaults, stake escrow
  ├─ VRF record, nonce commitment, fairness commitment
  └─ Final result, payout, refund
```

### Base layer versus PER

  Function                    Recommended location
  --------------------------- ---------------------------------------
  Platform configuration      Solana base layer
  Deposits and withdrawals    Solana base layer
  Stake escrow and payout     Solana base layer
  Game roster lock            Solana base layer
  VRF request/result record   Solana base layer, per supported flow
  Dealer nonce commitment     Solana base layer
  Hidden deck and hands       PER with restrictive permissions
  Frequent game actions       PER
  Final fairness record       Reveal after game
  Final settlement            Solana base layer

Delegated accounts and ephemeral-only accounts have different
lifecycles. Ephemeral-only accounts do not persist on Solana. Decide the
lifecycle of every account. Do not assume private state can be recovered
after a PER restart. If safe recovery is not available, fail closed and
refund.

## 5. Critical fairness correction: public VRF output must not reveal the deck

### 5.1 Unsafe approach

Do not derive the complete shuffle seed from only public VRF output:

``` text
shuffle_seed = HKDF(vrf_output, game_id, ...)
```

If the VRF output is public on-chain, anyone who knows the shuffle
algorithm can reconstruct the deck before the game ends. PER permissions
cannot hide a deck that is already derivable from public data.

### 5.2 Recommended protocol: public VRF + secret precommitted nonce

**Step 1 --- Lock roster** - Finalize game ID, player order, roster, and
rules version. - Compute canonical `roster_hash`. - Lock the roster
before requesting randomness.

**Step 2 --- Generate secret nonce inside PER** - Generate a fresh
32-byte `dealer_nonce` using a cryptographically secure RNG inside the
trusted environment. - Never expose it to clients, backend, logs, or
public account data. - Publish only this commitment:

``` text
nonce_commit =
  SHA256(
    "CF_NONCE_COMMIT_V1" ||
    game_id ||
    roster_hash ||
    dealer_nonce
  )
```

The commitment must be confirmed on the base layer before requesting
VRF.

**Step 3 --- Request MagicBlock VRF** - Request randomness only after
roster lock and nonce commitment. - Use the queue appropriate to the
execution environment. The official quickstart distinguishes base Solana
`DEFAULT_QUEUE` from delegated/ephemeral `DEFAULT_EPHEMERAL_QUEUE`. -
Use the protected VRF callback mechanism. - Store the verified VRF
output and request metadata.

**Step 4 --- Derive seed inside PER**

``` text
shuffle_seed =
  HKDF_SHA256(
    ikm  = vrf_output || dealer_nonce,
    salt = game_context_hash,
    info = "CARD_FLEX_SHUFFLE_V2"
  )
```

Specify exact byte encoding, endianness, HKDF parameters, hash function,
and domain separators in a versioned protocol document.

**Step 5 --- Shuffle and deal** - Use deterministic Fisher--Yates with a
specified cryptographic RNG. - Store deck and hands only in restricted
PER accounts. - Build a deck commitment, such as a Merkle root. - Bind
it to game ID, roster hash, rules version, and protocol version.

**Step 6 --- Reveal after completion** Reveal the nonce, full deck,
salts, dealing map, signatures, and event-chain reference. An
independent verifier must be able to recompute the commitment, seed,
deck, deal, hand rankings, and settlement inputs.

### 5.3 Abort and reroll protection

-   Reject a second shuffle request for the same locked game ID.
-   Record every cancellation and reason.
-   Define deterministic refunds for dealer or PER failure.
-   Do not let an operator silently replace a game after seeing an
    unfavourable result.
-   Monitor repeated dealer failures/cancellations.

This reduces manipulation but does not eliminate selective-abort risk.
Product rules and operational controls must address it.

### 5.4 Merkle proof limitations

A Merkle proof proves membership of a card and salt at a committed
position. It does not alone prove fair shuffling, correct dealing,
correct game rules, correct winner, or correct payout. Those require
deterministic protocol rules, complete reveal, independent verification,
and appropriate enforcement.

## 6. Account design

### 6.1 Solana base-layer accounts

  -----------------------------------------------------------------------
  Account                 Purpose                 Example fields
  ----------------------- ----------------------- -----------------------
  `GlobalConfig`          Platform configuration  authority, fee bps,
                                                  version, pause state

  `PlayerVault`           Player funds            owner, available,
                                                  locked, nonce

  `GameRegistry`          Durable game identity   game ID, roster hash,
                                                  rules version, status

  `RandomnessRecord`      VRF metadata            request ID, queue,
                                                  output, callback status

  `FairnessCommitment`    Fairness commitments    nonce commitment, deck
                                                  root, protocol version

  `ResultAccount`         Final result            winner, pot, fee,
                                                  payout map, settlement
                                                  status
  -----------------------------------------------------------------------

Use lamports for SOL accounting. Do not introduce a new SPL token
without a clear product or tokenomics requirement.

### 6.2 PER runtime accounts

  -----------------------------------------------------------------------
  Account                 Visibility              Purpose
  ----------------------- ----------------------- -----------------------
  `GameRuntime`           Table-visible           Turn, pot, seats,
                                                  public status, action
                                                  sequence

  `DealerState`           Dealer program only     Deck, nonce, shuffle
                                                  cursor

  `SeatHand_0`            Player 0 only           Player 0's cards and
                                                  proofs

  `SeatHand_1`            Player 1 only           Player 1's cards and
                                                  proofs

  `SeatHand_2`            Player 2 only           Player 2's cards and
                                                  proofs

  `SeatHand_3`            Player 3 only           Player 3's cards and
                                                  proofs

  `SeatHand_4`            Player 4 only           Player 4's cards and
                                                  proofs

  `SeatHand_5`            Player 5 only           Player 5's cards and
                                                  proofs
  -----------------------------------------------------------------------

Players must not write dealer or hand state. Backend must not have broad
plaintext access to the deck. Do not expose card values through logs,
errors, analytics, transaction events, or table-wide WebSocket channels.

For every account, record whether it is a base-layer account, delegated
account, or ephemeral-only account. Validate confidentiality across
commits, snapshots, backups, debugging, and recovery.

## 7. Teen Patti game engine

Implement deterministic Rust rules shared by the Anchor program and
independent verifier.

### Hand ranking

1.  Trail / Trio
2.  Pure Sequence
3.  Sequence
4.  Color / Flush
5.  Pair
6.  High Card

Specify tie-breakers and sequence edge cases. Decide explicitly how
`A-2-3` and `A-K-Q` rank. Version the rules.

### State machine

``` text
WAITING_FOR_PLAYERS
  -> READY
  -> INITIALIZATION
  -> DEALING
  -> BETTING_ROUND <-> SIDE_SHOW
  -> SHOWDOWN
  -> SETTLEMENT
  -> COMPLETED
```

Add a separate cancellation/refund terminal path.

### Actions

Join, leave-before-lock, blind, see, chaal, pack, side show, show,
timeout, reconnect, and optional auto-play.

Each action should bind: - Game ID and player identity. - Action type
and amount. - Monotonic sequence or expected state version. - Unique
action ID/idempotency key. - Authorization and current turn.

Reject duplicate, stale, out-of-turn, malformed, or unauthorized
actions.

### Determinism and replay

-   Canonical event format.
-   Monotonic action sequence.
-   Deterministic state transitions.
-   Idempotent instructions or explicit duplicate rejection.
-   Reconnect snapshots from authoritative state.
-   Never redeal because a client disconnected.

### Settlement

Base-layer settlement should verify terminal state, accepted result and
required fairness evidence; calculate fees/payouts using integer
arithmetic; settle exactly once; and support explicit
cancellation/refund. For Mainnet, do not rely only on a backend
assertion that the PER result is correct.

## 8. Session authorization and UX

1.  Player connects wallet.
2.  Player signs initial authorization or deposit/entry transaction.
3.  Client creates an ephemeral session key.
4.  Scoped session token is created or validated.
5.  Session key submits permitted game actions.
6.  Session expires or is revoked after game.
7.  Withdrawals and privileged actions require main-wallet
    authorization.

Bind sessions to player and game. Use short expiry and revocation. Do
not log session secrets.

## 9. Backend API and WebSocket boundaries

Possible REST endpoints:

``` text
POST /v1/games
POST /v1/games/:gameId/join
POST /v1/games/:gameId/lock-roster
POST /v1/games/:gameId/request-randomness
GET  /v1/games/:gameId/status
GET  /v1/games/:gameId/public-state
GET  /v1/games/:gameId/my-hand
POST /v1/games/:gameId/session
POST /v1/games/:gameId/actions
POST /v1/games/:gameId/commit
POST /v1/games/:gameId/settle
POST /v1/games/:gameId/cancel
```

`my-hand` must authenticate the wallet/session and enforce PER
permissions. A player ID supplied in a request is not proof of identity.

Possible WebSocket events:

``` text
game:state
game:player_joined
game:turn_changed
game:action_accepted
game:action_rejected
game:pot_updated
game:showdown
game:completed
game:cancelled
player:private_hand
player:reconnected
```

Never broadcast `player:private_hand` to a table-wide channel.

## 10. Local development

Start the local MagicBlock stack:

``` bash
npx --package @magicblock-labs/ephemeral-validator mb-stack
```

Documented local endpoints:

  Service           Endpoint
  ----------------- -------------------------
  Solana base RPC   `http://127.0.0.1:8899`
  ER RPC            `http://127.0.0.1:7799`
  QFS               `http://127.0.0.1:6699`
  WebSocket         `ws://127.0.0.1:6700`

Use QFS for permission-filtered privacy tests rather than assuming raw
ER RPC applies the same filtering.

**QFS is a development/testing service, not hardware TEE attestation.**
A local privacy test does not prove the actual Devnet PER deployment has
identical security properties.

Recommended example order: 1. Private Counter --- permissions. 2. Rock
Paper Scissors --- hidden moves and reveal. 3. Roll Dice --- VRF. 4.
Session Keys --- scoped repeated actions. 5. Sealed Auction --- private
data plus escrow.

Official repositories: - Private Counter:
https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/private-counter -
Rock Paper Scissors:
https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/rock-paper-scissor/anchor -
Roll Dice:
https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/roll-dice -
Session Keys:
https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/session-keys/anchor -
Sealed Auction:
https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/sealed-auction -
Ephemeral Rollups SDK:
https://github.com/magicblock-labs/ephemeral-rollups-sdk - Solana VRF:
https://github.com/magicblock-labs/solana-vrf - Private Payments Demo:
https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo

Use the current official quickstart for SDK versions, Anchor
compatibility, features, and queue configuration. Do not mix old
examples with the latest SDK without checking compatibility.

## 11. Suggested Rust workspace

``` text
card-flex/
├── programs/
│   └── card-flex-anchor/
├── crates/
│   ├── card-types/
│   ├── teen-patti-rules/
│   ├── shuffle-engine/
│   ├── fairness-core/
│   ├── fairness-verifier/
│   ├── dealer-runtime/
│   └── magicblock-adapter/
├── apps/
│   ├── web/
│   └── api/
├── packages/
│   ├── client-sdk/
│   └── protocol-types/
└── tests/
    ├── fairness/
    ├── privacy/
    ├── recovery/
    └── settlement/
```

Keep the fairness core provider-neutral where practical. The verifier
should have independent test vectors and should not merely call the same
high-level dealer function.

## 12. Merkle commitment design

For each deck position, define a domain-separated leaf bound to game ID,
roster hash, protocol version, position, card ID, and salt:

``` text
leaf_i = SHA256(
  "CF_CARD_LEAF_V1" ||
  game_id ||
  roster_hash ||
  protocol_version ||
  position_i ||
  card_id_i ||
  salt_i
)
```

Specify canonical binary encoding, tree shape, odd-node handling, and
proof serialization. If padding 52 leaves to 64, define the exact
empty-leaf construction.

Example six-player round-robin deal:

``` text
P0: deck[0], deck[6],  deck[12]
P1: deck[1], deck[7],  deck[13]
P2: deck[2], deck[8],  deck[14]
P3: deck[3], deck[9],  deck[15]
P4: deck[4], deck[10], deck[16]
P5: deck[5], deck[11], deck[17]
```

Define a separate canonical mapping for fewer than six players.

## 13. Security and privacy threat model

  -----------------------------------------------------------------------
  Threat                              Mitigation / required test
  ----------------------------------- -----------------------------------
  Player reads another hand           PER ACL; test RPC, subscriptions,
                                      middleware, backend

  Backend reads full deck             Minimize permissions; dealer-only
                                      state

  Public VRF reveals deck             Mix VRF output with precommitted
                                      secret nonce

  Dealer chooses favourable shuffle   Commit nonce before VRF;
                                      deterministic shuffle and reveal

  Selective abort                     No silent reroll;
                                      cancellation/refund audit

  Fake VRF callback                   Protected callback; reject spoofed
                                      invocation

  Duplicate action                    Action ID and sequence checks

  Old-game replay                     Bind action to game, player, nonce,
                                      expiry

  Session compromise                  Narrow scope, short expiry, no
                                      withdrawal rights

  PER restart                         Same-state recovery or explicit
                                      refund

  Secret leakage                      No card values or nonce in
                                      logs/errors/analytics

  Settlement replay                   One-time base-layer settlement
                                      state

  Upgrade abuse                       Controlled upgrade authority and
                                      release process

  RPC/API bypass                      Test every endpoint and
                                      subscription path
  -----------------------------------------------------------------------

Document TEE assumptions: hardware, attestation, approved program
measurement, secret generation, recovery, provider access to
logs/snapshots, and upgrade policy. Do not call the system "trustless"
solely because it uses a TEE or VRF.

## 14. Recovery policy

For each game, retain enough durable non-secret state to know whether
roster lock, nonce commitment, VRF request, deal commitment, game start,
latest action sequence, completion, cancellation, and settlement
occurred.

For secret state, define how the same deck and hands can be restored
without exposing them. If safe recovery is unavailable:

1.  Pause the game.
2.  Attempt documented same-state recovery.
3.  If recovery cannot be proven safe, cancel explicitly.
4.  Refund under published rules.
5.  Preserve an audit record.
6.  Never silently generate a replacement deck for the same game.

## 15. Implementation roadmap

### Phase 0 --- Environment validation

-   Pin Rust, Solana/Agave, Anchor, Node, and MagicBlock SDK versions.
-   Run local stack.
-   Deploy minimal Anchor program.
-   Exercise base RPC, ER RPC, QFS, and WebSocket.
-   Document account delegation and commit flow.

**Exit:** clean-checkout reproducibility and documented endpoints.

### Phase 1 --- Six-wallet private-card POC

-   Create six wallets.
-   Create public `GameRuntime`, restricted `DealerState`, and six
    `SeatHand` accounts.
-   Configure permissions.
-   Test owner reads and non-owner denials through RPC, WebSocket, QFS,
    API, and session reuse.
-   Test unauthorized writes and inspect logs.

**Exit:** each wallet reads exactly its own three cards; other hands are
denied; players cannot write card state; backend cannot retrieve full
plaintext deck; no card leaks in logs/events.

### Phase 2 --- VRF and nonce protocol

-   Lock roster and compute hash.
-   Generate secret nonce in PER.
-   Publish commitment.
-   Request VRF and protect callback.
-   Derive seed, shuffle, build Merkle root.
-   Reveal test fairness record and independently verify.
-   Test duplicate requests, invalid callbacks, cancellation, and
    restart.

**Exit:** commitment precedes VRF; callback spoofing fails; verifier
reproduces deck; no second shuffle; no silent reroll.

### Phase 3 --- Teen Patti engine

-   Implement rules, tie-breakers, state machine, actions, action IDs,
    replay protection, showdown, reconnect, and tests.

**Exit:** deterministic valid transitions; invalid actions rejected;
reconnect preserves deal; verifier agrees.

### Phase 4 --- Session keys and frontend

-   Implement initial wallet authorization, scoped session,
    expiry/revocation, Next.js table UI, private hand retrieval, and
    WebSocket updates.

**Exit:** gameplay avoids repeated main-wallet prompts; withdrawals
still require main wallet; expired sessions fail; no cross-player
access.

### Phase 5 --- SOL escrow and settlement

-   Implement lamport accounting, stake locking, result verification,
    integer fee/payout math, one-time settlement, and refunds.

**Exit:** exact reconciliation; no duplicate settlement; cancellation
refunds; backend cannot redirect funds.

### Phase 6 --- Devnet release candidate

-   Test concurrent games, disconnects, PER outage/restart, VRF
    failures, malicious actions, privacy bypasses, latency, cost, and
    recovery.
-   Complete independent security review before real-value deployment.

**Exit:** privacy/fairness tests pass, recovery is auditable, accounting
reconciles, monitoring and incident response are ready.

## 16. Acceptance checklist

### Privacy

-   [ ] Six independent wallets tested.
-   [ ] Each wallet reads only its own three cards.
-   [ ] Other five hands denied through all read paths.
-   [ ] Players cannot write dealer/card state.
-   [ ] Backend cannot read full plaintext deck.
-   [ ] No card values in logs, errors, events, or analytics.

### Fairness

-   [ ] Roster locked before VRF request.
-   [ ] Nonce generated in PER using CSPRNG.
-   [ ] Nonce commitment published before VRF.
-   [ ] VRF callback protected.
-   [ ] Seed uses VRF output plus secret nonce.
-   [ ] Shuffle and encoding versioned.
-   [ ] Deck has 52 unique cards.
-   [ ] Merkle proofs verify.
-   [ ] Independent reveal verifier passes.
-   [ ] Duplicate shuffle requests rejected.
-   [ ] No silent reroll.

### Gameplay and settlement

-   [ ] Actions validate membership, turn, state, amount, and
    authorization.
-   [ ] Duplicate/stale actions rejected.
-   [ ] Rules and tie-breakers have fixed test vectors.
-   [ ] Reconnect preserves same deal.
-   [ ] PER outage restores same state or explicitly cancels.
-   [ ] Restart cannot cause second deal.
-   [ ] Settlement occurs only once.
-   [ ] Balances reconcile exactly.
-   [ ] Refund path is deterministic and auditable.

### Operations

-   [ ] Measure action and turn latency.
-   [ ] Measure VRF fulfilment time.
-   [ ] Measure commit frequency and cost.
-   [ ] Measure recovery time and concurrent table capacity.
-   [ ] Alert on repeated dealer failures/cancellations.
-   [ ] Document incident response and upgrade authority.

## 17. First engineering tickets

  Ticket           Deliverable                                    Priority
  ---------------- ---------------------------------------------- ----------
  CF-MB-001        Pin toolchain and start local stack            P0
  CF-MB-002        Deploy minimal Anchor program to base/ER       P0
  CF-MB-003        Implement public `GameRuntime`                 P0
  CF-MB-004        Implement six restricted `SeatHand` accounts   P0
  CF-MB-005        Configure and test PER/QFS permissions         P0
  CF-MB-006        Six-wallet privacy integration tests           P0
  CF-FR-001        Canonical game/roster encoding                 P0
  CF-FR-002        Dealer nonce commitment                        P0
  CF-FR-003        Protected MagicBlock VRF callback              P0
  CF-FR-004        Deterministic shuffle and test vectors         P0
  CF-FR-005        Merkle commitment and independent verifier     P0
  CF-REC-001       PER restart and refund specification           P0
  CF-GAME-001      Teen Patti rules crate                         P1
  CF-GAME-002      State machine and action IDs                   P1
  CF-SESSION-001   Scoped session authorization                   P1
  CF-SETTLE-001    Base-layer vault and one-time settlement       P1

Complete P0 privacy, fairness, and recovery tickets before building a
polished gameplay UI.

## 18. Architecture decisions to record

Create ADRs for:

1.  Which accounts are base-layer, delegated, or ephemeral-only?
2.  Which PER deployment and permission model will Devnet use?
3.  How are private reads authenticated?
4.  How are secrets recovered or safely discarded after restart?
5.  What exact VRF queue and callback account layout does the selected
    SDK require?
6.  What is the canonical encoding for game context and commitments?
7.  What are the Teen Patti tie-break and sequence rules?
8.  What is the cancellation/refund policy?
9.  What evidence must base-layer settlement verify?
10. What is the upgrade authority and emergency pause policy?

## 19. Official references

Use official documentation as the source of truth for current SDK
versions, account lifecycle, queue addresses, callback APIs, and
deployment details.

-   MagicBlock documentation: https://docs.magicblock.gg/
-   Ephemeral Rollups SDK:
    https://github.com/magicblock-labs/ephemeral-rollups-sdk
-   Validator/local stack:
    https://github.com/magicblock-labs/ephemeral-validator
-   Engine examples:
    https://github.com/magicblock-labs/magicblock-engine-examples
-   Solana VRF: https://github.com/magicblock-labs/solana-vrf
-   Private payments demo:
    https://github.com/magicblock-labs/starter-kits/tree/main/private-payments-demo
-   Session Keys example:
    https://github.com/magicblock-labs/magicblock-engine-examples/tree/main/session-keys/anchor
-   RFC 9381 --- Verifiable Random Functions:
    https://www.rfc-editor.org/rfc/rfc9381

SDKs, queue addresses, fees, endpoints, Anchor compatibility, and
provider features can change. Verify current official quickstarts and
actual Devnet configuration at implementation time. Do not copy old
version numbers or addresses without checking compatibility.

## 20. Final recommendation

Build the **six-wallet private-card proof of concept first**. It tests
the most important assumption: each player can securely receive their
own cards while the dealer and game program retain what is needed to run
the game.

Next, prove the nonce-plus-VRF fairness protocol and independent
verifier. Only then build the full Teen Patti engine, session-key UX,
and SOL settlement.

This order reduces the risk of building a polished game on top of a
privacy or fairness model that does not actually work.
