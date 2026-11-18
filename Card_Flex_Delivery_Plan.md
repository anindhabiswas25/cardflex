# Card Flex Delivery Plan

**As of:** 2026-11-18

Card Flex ships a production-grade, provably fair Teen Patti on Solana Devnet, with the game running on-chain inside MagicBlock's Private Ephemeral Rollup (PER). There is no fixed release date: progress is driven by gates, and once P9's exit criteria pass we launch within one week. The first phases prove privacy, fairness and recovery on the real Devnet TEE before any polished UI is built; if those gates fail we stop and switch provider.

---

## 1. Decisions locked

These ten decisions replace the conflicting parts of PRD v1.1 and are written into `Card_Flex_Devnet_PRD_MagicBlock_v1.2.md`.

| # | Decision | Replaces | Why |
| --- | --- | --- | --- |
| D1 | Game engine runs as an Anchor program inside MagicBlock PER; it is authoritative for cards, turns, pots and winners | PRD §20 backend orchestrator as authority | Backend can't alter cards or money; maximum use of MagicBlock |
| D2 | NestJS backend is non-authoritative: lobby, matchmaking, profiles, history indexer, admin, alerts | PRD §17 game routes | Keeps backend out of the latency path and the trust boundary |
| D3 | Shuffle seed = HKDF(VRF output + every seated player's secret salt) | PRD §13.7 VRF-only seed; v1.2 "dealer CSPRNG nonce" | VRF-only deck is public; on-chain programs can't make secret randomness |
| D4 | Table-session money model: buy-in to a base-layer TableVault, chip stacks in PER, cash-out from last committed state | Per-game base-layer settlement | No Solana transaction between hands |
| D5 | TableVault is never delegated; `emergency_refund` works with PER down | — | Funds stay recoverable if the provider fails |
| D6 | Hidden cards protected by PER read permissions + client TDX attestation check + per-card Merkle proof; no custom X25519 packet layer in V1 | PRD §13.7 steps 11–12 | A program cannot hold a dealer private key |
| D7 | Full reveal of seed inputs after every hand, so anyone can verify | — | One seed decides the whole deck; partial verification is impossible |
| D8 | Players sign gameplay with GPL session keys and read via PER auth token; main wallet only for buy-in and cash-out | — | Zero wallet pop-ups during play |
| D9 | Turn timeouts run on MagicBlock cranks (`ScheduleTask`), with a permissionless keeper as backup | Backend timers | No backend in the hot path |
| D10 | No public local-dealer fallback; `DEALER_MODE` has no default | PRD §28.3 `DEALER_MODE=local` | Fail closed |

---

## 2. Architecture at a glance

**Gameplay runs inside PER; money never leaves Solana.**

```text
┌──────────────────────────────────────┐   lobby, history   ┌──────────────────────────────────────┐
│ Player client (Next.js)              │ <────────────────> │ Backend (NestJS)                     │
│  Wallet signs buy-in and cash-out    │                    │  Not authoritative for cards/money   │
│  Session key signs every game action │                    │  Lobby, matchmaking, history, admin  │
│  Checks TDX attestation, verifies    │                    │  Indexes committed hand records      │
└──────────────────┬───────────────────┘                    └──────────────────▲───────────────────┘
                   │ actions + live updates (WS)                               │ indexes
                   ▼                                                           │
┌─────────────────────────────────────────────────────────┐                    │
│ MagicBlock PER (devnet-tee, Intel TDX)                  │   ┌──────────────┐ │
│  ┌────────────────────────┐ ┌────────────────────────┐  │ < │MagicBlock VRF│ │
│  │ TableRuntime           │ │ SeatHand x 6           │  │   │Proof-checked │ │
│  │ Seats, turn, pot,      │ │ 3 cards + Merkle proof │  │   │callback into │ │
│  │ chip stacks            │ │ Readable by owner only │  │   │PER           │ │
│  │ Readable by seated     │ └────────────────────────┘  │   └──────────────┘ │
│  │ players                │ ┌────────────────────────┐  │                    │
│  └────────────────────────┘ │ Game program + crank   │  │                    │
│  ┌────────────────────────┐ │ Rules, Side Show,      │  │                    │
│  │ DealerState + salts    │ │ timeouts               │  │                    │
│  │ Deck and seed inputs   │ │ Only writer of state   │  │                    │
│  │ No readers until reveal│ └────────────────────────┘  │                    │
│  └────────────────────────┘                             │                    │
└──────────────────┬──────────────────────────────────────┘                    │
                   │ commit after each hand                                    │
                   ▼                                                           │
┌──────────────────────────────────────────────────────────────────────────────┴───┐
│ Solana base layer                                                                │
│  ┌───────────────────────┐ ┌───────────────────────────┐ ┌─────────────────────┐ │
│  │ TableVault            │ │ Ledger + hand records     │ │ Config + refunds    │ │
│  │ Buy-ins in escrow     │ │ Committed stacks, roots   │ │ Rake, pause,        │ │
│  │ Never delegated       │ │ Seed reveal per hand      │ │ multisig upgrades   │ │
│  │                       │ │                           │ │ Refund if PER down  │ │
│  └───────────────────────┘ └───────────────────────────┘ └─────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Players act directly on PER with a session key; the backend only reads committed state, and the vault on Solana is the single place money lives.

---

## 3. Workstreams and ownership

Six workstreams, sized for a core team of 6–7 (assumed; adjust the timeline if smaller). Owners to be named at kickoff.

| Workstream | Owns | People |
| --- | --- | --- |
| PROG — On-chain program | Anchor program (base + PER), delegation lifecycle, permissions, cranks, VRF callback, vault and cash-out | 2 Rust/Anchor |
| FAIR — Fairness and rules | `teen-patti-core` (no_std), shuffle, Merkle, fairness spec, test vectors, independent verifier (CLI + WASM) | 1 Rust/crypto |
| CLIENT — Web app | Next.js table UI, wallet connect, session keys, PER auth and attestation check, WS subscriptions, verify page | 1–2 TS/React |
| BACK — Backend and infra | NestJS lobby/matchmaking, indexer, history, admin, Postgres/Redis, monitoring, CI/CD | 1 TS/infra |
| QA — Security and test | Privacy probes, recovery drills, six-wallet E2E, load tests, audit prep | 1 (shared at first) |
| PM | Plan, ADRs, MagicBlock relationship, gate reviews, rules sign-off | 1 |

---

## 4. Roadmap

**Gate-driven, no fixed dates: each phase starts when its dependencies pass, and launch follows within one week of P9 passing.**

Week counts below are effort estimates for a team of 6–7, used for sizing and spotting slippage, not deadlines.

| Phase | Starts when | Est. effort | Gate at end |
| --- | --- | --- | --- |
| P0 Tooling and probes | Kickoff | ~2 wks | — |
| P1 Privacy POC | P0 done | ~3 wks | **G1 privacy** |
| P2 Fairness v2 | P1 accounts exist (overlaps P1) | ~4 wks | **G2 fairness** |
| P3 Recovery | P2 deal works | ~3 wks | **G3 go/no-go on MagicBlock** |
| P4 Rules engine (parallel) | P0 done | ~8 wks | Rules vectors frozen |
| P5 Game program | G3 passed | ~5 wks | — |
| P6 Money | P5 hand commit works (overlaps P5) | ~4 wks | — |
| P7 Product (parallel) | G1 passed | ~11 wks | — |
| P8 Hardening | P5, P6, P7 feature-complete | ~4 wks | — |
| P9 Devnet release | P8 exit criteria pass | ~2–3 wks | **Launch within 1 week of passing** |

```text
Kickoff ─> P0 ─> P1 ──G1──> P2 ──G2──> P3 ──G3 go/no-go──> P5 ─┬─> P8 ─> P9 ─> Launch (≤ 1 week)
            │          └──────────> P7 Product ────────────────────┤
            └─> P4 Rules engine ──────────────────────────────────>│
                                              P5 ─> P6 Money ─────┘
```

G3 is the go/no-go on MagicBlock: rules (P4) and product (P7) run in parallel so a provider switch costs only the program work. The critical path is P0 → P1 → P2 → P3 → P5 → P8 → P9; speed up those phases to launch sooner.

---

## 5. Phase details

Each phase ends at a gate the PM signs off against its exit criteria; a failed gate G1–G3 triggers the provider fallback (see Risks).

| Phase | Est. weeks from kickoff | Deliverables | Exit criteria |
| --- | --- | --- | --- |
| P0 Tooling and probes | 1–2 | Pinned toolchain (Rust 1.89.0, Solana 3.1.10, Anchor 1.1.2, Node 24.21.0, ER SDK 0.17.3 — see docs/adr/0001-toolchain-pins.md); `mb-stack` local; minimal program delegated to devnet-tee; latency + geofence probe from each target region | Clean-checkout build in CI; measured p50/p95 action latency per region; target countries can reach devnet-tee |
| P1 Privacy POC | 3–5 | TableRuntime, DealerState, 6 SeatHand + 6 SaltAccount with EphemeralPermission; privacy probe suite | **G1:** each of 6 wallets reads only its own 3 cards via RPC, WS, getTransaction and logs; salt tx messages hidden; empty-member-list behaviour documented; players can't write card state |
| P2 Fairness v2 | 5–8 | Salt round, VRF request/callback (ephemeral queue if it works in PER, else base), HKDF + shuffle + Merkle in-program, reveal, verifier v1 | **G2:** verifier rebuilds 10,000 test hands; spoofed callback rejected; second shuffle impossible; CU cost per deal measured |
| P3 Recovery | 8–10 | PER kill-mid-hand drills, pause state, `emergency_refund` on base, undelegate recovery | **G3:** after PER outage the same state resumes or every stake is refunded exactly; no second deal. **Go/no-go on MagicBlock** |
| P4 Rules engine | 3–10 (parallel) | `teen-patti-core`: ranking, betting, Show, Side Show, timeouts, pot/rake; property tests; test vectors | 100% rule table covered; program and verifier share one crate; vectors frozen |
| P5 Game program | 10–14 | Full state machine in PER, session-key auth, crank timeouts, Side Show permission swap, hand commit | Two- and six-player hands complete on Devnet with no backend in the action path |
| P6 Money | 12–15 | TableVault, SeatLedger, buy-in, cash-out, rake treasury, reconciliation job | Vault = sum of committed stacks + rake, to the lamport; no double cash-out |
| P7 Product | 8–18 (parallel) | Lobby, table UI, wallet flow, verify page, history, admin dashboard, indexer | Full journey without dev tools on desktop and mobile |
| P8 Hardening | 18–21 | Load test (concurrent tables), commit-fee model, security review, Squads multisig upgrade authority, runbooks | 50 concurrent tables stable; no open high-severity findings |
| P9 Devnet release | 22–24 | Public Devnet, monitoring, test guide, fairness and security report | Six-player E2E passes on public Devnet; funds reconcile; every hand verifiable |

Mainnet is a separate decision after P9: it needs external audits, pinned TEE measurements, and an incident drill.

---

## 6. Backlog up to G3

All P0 tickets must close before G3; no polished UI work starts before G1 passes.

| Ticket | Deliverable | Stream | Est. weeks | Priority | Status |
| --- | --- | --- | --- | --- | --- |
| CF-001 | Pin toolchain, monorepo, CI with clean-checkout build | PROG | 1 | P0 | Done (2026-11-18) |
| CF-002 | Rewrite PRD to v1.2 with decisions D1–D10 | PM | 1–2 | P0 | Done (2026-11-18) |
| CF-003 | Latency and geofence probe from each target region to devnet-tee | QA | 1–2 | P0 | In progress: probe built, dev-machine-1 measured; other regions pending (docs/findings/cf-003-devnet-access.md) |
| CF-004 | Minimal program delegated to devnet-tee, commit + undelegate round-trip | PROG | 2 | P0 | Done (2026-11-18): docs/findings/cf-004-devnet-roundtrip.md |
| CF-005 | ADR: every account marked base / delegated / ephemeral-only | PROG | 2 | P0 | Done (2026-11-18): docs/adr/0002-account-lifecycle.md |
| CF-006 | TableRuntime + 6 SeatHand + DealerState with EphemeralPermission | PROG | 3–4 | P0 | Not started |
| CF-007 | Privacy probe suite: RPC, WS, getTransaction, logs, session reuse | QA | 3–5 | P0 | Not started |
| CF-008 | Canonical encoding spec (CF-Fairness v2) + test vectors | FAIR | 3–5 | P0 | Not started |
| CF-009 | Salt round: private salt tx into SaltAccount, public commitment | PROG | 4–5 | P0 | Not started |
| CF-010 | VRF request/callback; test ephemeral queue inside PER vs base queue | PROG | 5–6 | P0 | Not started |
| CF-011 | In-program HKDF, shuffle, Merkle; compute-unit benchmark (ChaCha20 vs SHA-256 DRBG) | FAIR | 6–7 | P0 | Not started |
| CF-012 | Independent verifier v1 (CLI) | FAIR | 7–8 | P0 | Not started |
| CF-013 | Recovery: PER kill drills, pause state, `emergency_refund` on base | PROG | 8–10 | P0 | Not started |
| CF-014 | Teen Patti rules v1 sign-off (section 8) | PM | 3 | P1 | Not started |
| CF-015 | `teen-patti-core` crate with property tests | FAIR | 3–10 | P1 | Not started |
| CF-016 | Client: session keys + PER auth token + TDX attestation check | CLIENT | 6–9 | P1 | Not started |
| CF-017 | Table UI skeleton on WS account subscriptions | CLIENT | 8–10 | P1 | Not started |
| CF-018 | Lobby, matchmaking and history indexer | BACK | 8–10 | P2 | Not started |

---

## 7. Fairness protocol v2

No single party can predict or bias the deck: the VRF oracle doesn't know the salts, and salts are fixed before the VRF output exists. One honest player is enough.

1. **Lock roster.** Program computes `hand_ctx = SHA256("CF_CTX_V2" || program_id || table || hand_no || roster_hash || rules_version)`.
2. **Salt round.** Each seated client generates 32 random bytes and sends them as a private transaction into its own SaltAccount (no readers). The program stores the public commitment `c_i = SHA256("CF_SALT_V2" || hand_ctx || seat || salt_i)`. A seat that misses the deadline sits out this hand; the round restarts without it (not a reroll: no VRF yet).
3. **Request VRF** once all salts are in, with `caller_seed = SHA256(hand_ctx || c_0 .. c_n)`. Callback guarded by `#[vrf_callback]`.
4. **Shuffle in the callback.** `seed = HKDF-SHA256(ikm = vrf || salt_0 .. salt_n, salt = hand_ctx, info = "CARD_FLEX_SHUFFLE_V2")`, then Fisher–Yates with rejection sampling. Deck goes to DealerState (no readers); cards to SeatHand_i (owner only), round-robin by seat.
5. **Commit.** Per-card salts derive from the seed; the Merkle root goes into public TableRuntime and is committed to Solana with the hand record. Each player can check their 3 cards against the root during play.
6. **Play.** Side Show adds the two players to each other's SeatHand read list, then removes them.
7. **Reveal.** At hand end the program writes VRF output and all salts to a public HandSecrets record; the verifier rebuilds deck, deal, ranking, pot and rake.

Rules that never bend: one shuffle per `hand_ctx`; no reroll after a VRF request; every cancellation is recorded with its reason; byte encodings and test vectors are frozen in CF-008 before P2 code merges.

---

## 8. Teen Patti rules v1

Proposed defaults for sign-off in CF-014; every rule is versioned as `rules_version = 1` and no client or backend may interpret them differently.

| Rule | v1 decision |
| --- | --- |
| Deck and seats | 52 cards, no jokers; 2–6 players; 3 cards each, round-robin from the seat left of the dealer |
| Hand ranking | Trail > Pure Sequence > Sequence > Color > Pair > High Card |
| Sequences | A-K-Q highest, A-2-3 second, then K-Q-J down to 4-3-2 (confirm A-2-3 at sign-off) |
| Ties | No suit ranking; compare highest card down; exact tie splits the pot, odd lamport to first tied seat clockwise from dealer |
| Boot | Fixed per table, collected from every seat at deal |
| Blind bet | 1× or 2× current stake; maximum 4 blind turns, then must See |
| Seen bet | 2× or 4× current stake |
| Limits | Chaal limit 128× boot; pot limit 1,024× boot triggers forced Show |
| Show | Only with 2 players left; costs the player's normal bet; a blind player can't force Show on a seen player |
| Side Show | Seen player asks the previous seen player; costs normal seen bet; recipient accepts or rejects; lower hand packs, tie → requester packs |
| Timeout | 25 s per turn; auto-pack by crank; disconnect is treated as timeout |
| Last player | Wins the pot without showing cards (cards still revealed in HandSecrets) |
| Buy-in | Minimum 40× boot, maximum 200× boot; no top-up during a hand |
| Rake | Basis points of the won pot only, capped per hand; config on base layer |
| Table close | Idle 10 min or all seats empty → commit, undelegate, stacks cashable |

---

## 9. Latency budget

Actions confirm in under 200 ms p95 because the hot path is client → devnet-tee → WS push, with no backend, wallet pop-up or Solana base transaction in it. Targets are unmeasured until CF-003.

| Step | Target p95 | How |
| --- | --- | --- |
| Action confirmed in PER | < 200 ms | Session-key signing in the client, cached ER blockhash, skipPreflight, warm connection |
| Turn update to all seats | < 250 ms | WS account subscription on TableRuntime; UI shows pending until confirmed |
| Own cards visible after deal | < 500 ms | Subscribe to own SeatHand before the VRF callback lands |
| Next hand dealt | < 1 s (ephemeral VRF) / 1–5 s (base VRF) | Request next hand's VRF during the showdown animation |
| Reconnect to same hand | < 3 s | Re-auth token, re-subscribe, read TableRuntime snapshot |
| Buy-in / cash-out | Solana confirmation, 1–2 s | Only wallet-signed moments in a session |

Only one TEE endpoint (devnet-tee) is documented, so players far from it will see higher latency; CF-003 measures this per region before we commit to markets.

---

## 10. Risks and fallbacks

The top risk is trusting the TEE operator; every fallback keeps the provider-neutral `PrivateExecutionProvider` interface so we can switch.

| Risk | Impact | Mitigation / fallback |
| --- | --- | --- |
| PER privacy gate G1 fails | Cards leak; can't launch | Stop; evaluate Arcium (MPC) as provider — slower but no hardware trust |
| TEE operator or enclave compromised | Cards visible, state forged | Client-side TDX attestation, pin approved measurements in CI, stake and pot caps, honest disclosure in UI |
| PER outage mid-hand | Game stuck | Pause state; `emergency_refund` from base vault using last committed stacks after N minutes |
| Selective abort by operator | Unfavourable hands voided | Every cancel logged with reason; alert on abnormal cancel rate; refund policy published |
| Ephemeral VRF queue unusable in PER | Deal takes 1–5 s | Use base queue; prefetch VRF during showdown |
| Commit fees and limits (10 commits without fee payer) | Stalled commits, cost | Commit once per hand; fund a fee payer; model cost in P8 |
| Permission docs contradict (empty member list) | Wrong visibility | Test both cases in CF-007; always set an explicit member list |
| Geofencing at PER ingress blocks target users | Market loss | Probe in CF-003 before choosing markets |
| Write latency p95 over target (measured 436–518 ms on Devnet in CF-004; p50 is 86–92 ms) | Actions feel slow for 15–25% of moves | Measure from every target region; ask MagicBlock about Devnet ingress queueing and Mainnet PER latency; warm-up write after sit-down; pending-state UI; retest in P8 |
| Single hot upgrade key | Program hijack | Squads multisig + timelock before public Devnet |
| Copying SolPoker code | Licence breach (PolyForm Noncommercial) | Design reference only |

---

## 11. Open questions for MagicBlock

The docs don't answer these; PM raises them on MagicBlock Discord at kickoff and QA turns each into a P1 test.

- [ ] Does `DEFAULT_EPHEMERAL_QUEUE` VRF work inside the TEE rollup (PER)?
- [ ] Are transaction messages (`TX_MESSAGE`) hidden from non-members, so salt transactions stay private?
- [ ] What does an empty member list mean: public or fully private?
- [x] PER auth token lifetime, refresh method and challenge format? Answered in CF-003: JWT valid 30 days, no refresh endpoint, timestamped challenge (docs/findings/cf-003-devnet-access.md).
- [ ] Can delegated accounts be force-undelegated if the TEE validator is down?
- [ ] Limits on cranks: tasks per account, minimum interval, iterations?
- [ ] Is a regional TEE endpoint (Asia, EU, US) planned?
- [ ] Which TDX measurements can we pin, and are they published per release?
- [ ] Can an EphemeralPermission protect an ephemeral-only account (ADR 0002, assumption A1)?
- [ ] Do ephemeral-only accounts survive a PER restart?
- [ ] What is the fee-payer setup so per-hand commits never stop (10-commit limit)?

---

## 12. Sources

- Card Flex PRD v1.1 and MagicBlock Implementation Research v1.2 (project docs)
- [MagicBlock PER quickstart](https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart)
- [MagicBlock PER access control](https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/access-control)
- [MagicBlock PER authorization](https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/introduction/authorization)
- [MagicBlock VRF quickstart](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart.md)
- [MagicBlock VRF security](https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/introduction/security.md)
- [MagicBlock crank implementation](https://docs.magicblock.gg/jp/pages/tools/crank/implementation.md)
- [MagicBlock session keys](https://docs.magicblock.gg/pages/tools/session-keys/how-do-session-keys-work)
- [SolPoker (MagicBlock PER poker, reference only)](https://github.com/SANTOSRAYYYY/solpoker)
- [HiddenHand (Arcium MPC poker)](https://github.com/HiddenHandPoker/HiddenHand)
