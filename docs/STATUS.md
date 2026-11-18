# Status

Current phase: **P1 → P2.** G1 provisionally passed from one location; P2 (fairness) can start while other regions run the probes. Update this file whenever a ticket
starts, finishes or gets blocked. Newest entries first in the log.

## Tickets

| Ticket | What | Status | Where |
| --- | --- | --- | --- |
| CF-001 | Pin toolchain, monorepo, CI | Done | commit `a5b17ab`, `docs/adr/0001-toolchain-pins.md` |
| CF-002 | PRD v1.2 with decisions D1–D10 | Done | commit `7038c6c`, `Card_Flex_Devnet_PRD_MagicBlock_v1.2.md` |
| CF-003 | Latency, access and attestation probe | In progress: probe built, `dev-machine-1` measured; other regions pending | `packages/probes/`, `docs/findings/cf-003-devnet-access.md` |
| CF-004 | Minimal program on devnet-tee: delegate, write, commit, undelegate; measure write latency | Done | `programs/card-flex` probe_* instructions, `packages/probes/src/roundtrip.mjs`, `docs/findings/cf-004-devnet-roundtrip.md` |
| CF-005 | ADR: every account marked base / delegated / ephemeral-only | Done | `docs/adr/0002-account-lifecycle.md`; PRD v1.2 amendment 1 |
| CF-006 | P1: TableRuntime + 6 SeatHand + DealerState with EphemeralPermission | Done: six-player privacy matrix passes 2/2 on Devnet; WS delivery unreliable | `programs/card-flex/src/table.rs`, `pnpm tablepoc`, `docs/findings/cf-006-six-player-table.md`, `docs/findings/cf-006-a1-ephemeral-privacy.md` |
| CF-007 | Privacy probe suite for G1 | Done from `dev-machine-1`: 134/134 checks, 2/2 runs. **G1 provisionally passed**; needs other regions + a second day | `pnpm privacy-suite`, `docs/findings/cf-007-privacy-suite-g1.md` |
| CF-008 | Canonical encoding spec (CF-Fairness v2) + test vectors | Done | `crates/fairness-core`, `docs/spec/cf-fairness-v2.md`, `docs/spec/vectors/`, `scripts/check_fairness_vectors.py`, ADR 0003 |
| CF-009 | Salt round: private `submit_salt` into SaltAccount, public commitment | Done: suite 231/231 (2/2 runs) incl. salts; salt tx redacted to everyone | `open_salt`/`start_hand`/`submit_salt`, `docs/findings/cf-009-salt-round.md` |
| CF-010 | VRF request with caller_seed when SALTS_DONE; protected callback derives the seed | Done: ephemeral queue works inside PER, callback ~2.0–2.1 s; 12/12 checks ×2 | `request_shuffle`/`vrf_deal`, `pnpm handflow`, `docs/findings/cf-010-vrf.md` |
| CF-011 | Shuffle, deal and Merkle root in-program from the seed; compute units; remove test deck from the real path | Next (P2) | spec §5–8 |

## Blockers and asks for the team

- From every target region run `pnpm probe`, `pnpm privacy-suite` (and
  optionally `pnpm roundtrip`) with `-- --region <label>` and commit the JSON
  (CF-003, G1 sign-off).
- Move the devnet keys from `~/.config/cardflex/` (dev machine only) into the
  team secret store: `card_flex-program-keypair.json` (program address) and
  `devnet-deployer.json` (fee payer + current upgrade authority).
- Ask MagicBlock about the write-latency tail on Devnet (CF-004) and missed
  `accountSubscribe` updates for ephemeral accounts (CF-006).
- Sign off rules v1 (PRD §11.3; CF-014).
- Ask MagicBlock: open questions in delivery plan §11 (4 is answered).

## Log

- 2026-11-18 — CF-010 done. MagicBlock VRF works inside Devnet PER via the
  ephemeral queue (base queue fails cleanly). Callback guarded by the scoped
  VRF identity; fake/duplicate/stale callbacks and second requests rejected;
  on-chain caller_seed matches the JS spec. Request→seed ~2.0–2.1 s.
- 2026-11-18 — CF-009 done. Salt round on Devnet: on-chain hand_ctx and
  commitments match an independent JS implementation; wrong signer, wrong
  account and double submit rejected; salts unreadable by everyone (even the
  submitter); salt transaction redacted to every identity. Privacy suite
  231/231 in 2 runs. Program slot extended to 646,224 bytes.
- 2026-11-18 — CF-008 done. `fairness-core` (no_std, SHA-256 injected)
  implements CF-Fairness v2; byte spec + 3 frozen vector cases; an
  independent Python implementation reproduces every value (in CI and
  `pnpm verify`). HMAC/HKDF match RFC vectors; shuffle uniformity
  chi-square passes. Stream = SHA-256 counter (ADR 0003).
- 2026-11-18 — Second security fix: session keys can't be the authority, a
  wallet, another session or a table address; Side Show grants need the hand
  owner's session signature; rotation blocked while a grant is active. Suite
  150/150 on Devnet; 20 local tests.
- 2026-11-18 — Security fix: `set_hand_readers` can no longer add the operator
  or any non-seat key; readers = own session key + at most one seated
  opponent. New `rotate_session` (seat wallet only). Suite 144/144 on Devnet.
  Open for P5: Side Show must be game-state driven, not authority-chosen.
- 2026-11-18 — CF-007 done from dev-machine-1: privacy suite 134/134 in 2/2
  runs (matrix, encodings, getProgramAccounts, signatures, subscriptions,
  Side Show grant/revoke, session rotation, unauthorized calls, base layer).
  Fixed Side Show rent bug (budget permissions at 3 readers). Logs invisible
  to clients, so a CI test allow-lists every `msg!`. G1 provisionally passed.
- 2026-11-18 — Security review fixes for CF-006: test deck gated behind the
  `poc-test-deck` feature (devnet build only), seating locked once permissions
  exist. Devnet rerun passed; WS delivered 2/6 hands.
- 2026-11-18 — CF-006 done. Six-player table on Devnet PER: each session key
  reads only its own hand, wallets read nothing, dealer state unreadable,
  nothing secret on Solana (2/2 runs). WS card delivery 6/6 then 0/6, so the
  client must poll its hand. Deal confirmation 2.4–4.4 s on Devnet (noisy).
  Program upgraded on devnet (515,152-byte slot).
- 2026-11-18 — CF-006 spike: ephemeral-only account with private permission
  works on Devnet PER (4/4 runs). Strangers get null reads, no WS updates,
  and redacted transactions (signature + status only). One owner WS update
  was missed in 1 of 4 runs: clients must re-read their hand. Program
  upgraded on devnet (384,080-byte slot, extended by 64 KiB).
- 2026-11-18 — CF-005 done (ADR 0002). Secret accounts are ephemeral-only and
  never committed; TableRuntime + HandLog delegated, committed per hand;
  money follows committed state via base `sync_hand`; refunded tables ignore
  late commits. PRD v1.2 amended. New open questions for MagicBlock.
- 2026-11-18 — CF-004 done. Program deployed to devnet; base -> PER -> base
  round trip passes. Others see a write in 86–92 ms p50 but 436–518 ms p95
  (target 250 ms); the public ER has the same p50 and a worse tail. Privacy
  smoke check passed. Devnet deployer wallet created.
- 2026-11-18 — CF-003 started. Probe measures read latency, WebSocket slot
  rate, TDX attestation and PER login for 7 endpoints. Findings: PER p50
  77 ms from `dev-machine-1`, attestation `UpToDate`, token lifetime 30
  days, SDK attestation gaps. Write latency moves to CF-004.
- 2026-11-18 — CF-002 done: PRD v1.2.
- 2026-11-18 — CF-001 done: toolchain pinned, CI, program skeleton, local
  stack verified.
