# ADR 0001 — Toolchain pins

- **Status:** Accepted
- **Date:** 2026-11-18
- **Ticket:** CF-001

## Decision

All tool and library versions are pinned exactly. `toolchain.env` is the single
source of truth; `scripts/check-toolchain.sh` fails locally and in CI if any
installed tool or manifest pin disagrees with it.

| Tool | Pin | Notes |
| --- | --- | --- |
| Rust (host) | 1.89.0 | MagicBlock's documented version; Anchor 1.x MSRV is 1.89 |
| Solana / Agave CLI | 3.1.10 | Docs list 3.1.9; 3.1.10 is a patch release of the same line |
| Platform tools (SBF) | v1.52 | What `cargo-build-sbf` 3.1.10 uses (rustc 1.89 for SBF) |
| Anchor CLI + anchor-lang | 1.1.2 | Docs list 1.0.2; 1.1.2 is semver-compatible, and SDK 0.17.3 accepts anchor-lang ^1.0 |
| Node | 24.21.0 | |
| pnpm | 11.17.0 | |
| MagicBlock `ephemeral-rollups-sdk` (Rust) | 0.17.3 | Features: anchor, vrf, access-control, crank |
| MagicBlock `@magicblock-labs/ephemeral-rollups-sdk` (JS) | 0.17.3 | Added when the client is built |
| MagicBlock `@magicblock-labs/ephemeral-validator` (local stack) | 1.1.1 | Provides `mb-stack` |

## Why not the newest MagicBlock releases

`ephemeral-rollups-sdk` 0.20.0 and `ephemeral-validator` 2.0.0 were both
published on 2026-11-16, two days before this decision, after three alpha
releases the same day. We pin the last releases with weeks of use (0.17.3 from
2026-09-24, validator 1.1.1 from 2026-10-21). Revisit once 0.20.x has been out
for a few weeks and MagicBlock's devnet examples use it.

## Verified on 2026-11-18

- `anchor build` succeeds with the pinned set; program `.so` is 127,536 bytes.
- `cargo test --workspace` passes, including a LiteSVM test that loads the
  built program and checks `ping`.
- `cargo clippy -D warnings` and `cargo fmt --check` are clean.
- `pnpm mb-stack` starts the local MagicBlock stack:

  | Service | Endpoint | Reported version |
  | --- | --- | --- |
  | Base layer (mb-test-validator) | http://127.0.0.1:8899, ws :8900 | solana-core 3.1.10 |
  | Ephemeral validator (ER) | http://127.0.0.1:7799, ws :7800 | magicblock-core 1.1.1 |
  | Query filtering service (QFS) | http://127.0.0.1:6699, ws :6700 | health ok |

- The program deploys to the local base layer at
  `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL`.

Note: the research doc lists the local WebSocket as `ws://127.0.0.1:6700`. That
is the QFS socket; the ER's own socket is `:7800`.

## Program id and deploy key

`4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL` is the program id for localnet
and devnet. Its keypair is not committed. Before the first devnet deploy
(CF-004), move it into the team's secret store; losing it means the program
can't be deployed to that address again. The upgrade authority moves to a
Squads multisig before public Devnet (phase P8).

## Devnet endpoints (from MagicBlock docs, to re-check in CF-003/CF-004)

- TEE RPC: `https://devnet-tee.magicblock.app` (validator `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`)
- Router: `https://devnet-router.magicblock.app`
- Delegation program: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`
- Permission program: `ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1`
- VRF program: `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz`

## How to change a pin

1. Update `toolchain.env` and the matching manifest (`rust-toolchain.toml`,
   `Cargo.toml`, `Anchor.toml`, `package.json` or `.nvmrc`).
2. Run `pnpm verify` and the local stack.
3. Add a new ADR or amend this one with the reason and what was verified.
