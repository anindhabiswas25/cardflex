# Status

Current phase: **P1 — Privacy POC** (P0 done except CF-003 runs from other regions). Update this file whenever a ticket
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
| CF-007 | Privacy probe suite to close G1 (getProgramAccounts, signatures, token reuse after removal, Side Show permission swap, unauthorized writes, logs, other regions) | Next | extend `tablepoc.mjs` |

## Blockers and asks for the team

- Run `pnpm probe -- --region <label>` from every target region and commit the
  JSON (CF-003).
- Move the devnet keys from `~/.config/cardflex/` (dev machine only) into the
  team secret store: `card_flex-program-keypair.json` (program address) and
  `devnet-deployer.json` (fee payer + current upgrade authority).
- Ask MagicBlock about the write-latency tail on Devnet (CF-004) and missed
  `accountSubscribe` updates for ephemeral accounts (CF-006).
- Sign off rules v1 (PRD §11.3; CF-014).
- Ask MagicBlock: open questions in delivery plan §11 (4 is answered).

## Log

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
