# Card Flex

Provably fair Teen Patti on Solana, with gameplay running inside MagicBlock's
Private Ephemeral Rollup (PER). The engineering spec is
`Card_Flex_Devnet_PRD_MagicBlock_v1.2.md`; see `Card_Flex_Delivery_Plan.md`
for the plan and `docs/adr/` for decisions.

## Prerequisites (exact versions, see `toolchain.env`)

| Tool | Version | Install |
| --- | --- | --- |
| Rust | 1.89.0 | `rustup` — picked up automatically from `rust-toolchain.toml` |
| Solana / Agave CLI | 3.1.10 | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"` |
| Anchor | 1.1.2 | `cargo install --git https://github.com/solana-foundation/anchor avm --tag v1.1.2 --locked && avm install 1.1.2 && avm use 1.1.2` |
| Node | 24.21.0 | `nvm install` (reads `.nvmrc`) |
| pnpm | 11.17.0 | `corepack enable` (reads `packageManager`) |

Check your machine:

```bash
pnpm check:toolchain
```

## Build and test

```bash
pnpm install --frozen-lockfile
anchor build              # builds programs/card-flex to target/deploy/card_flex.so
pnpm lint:rust            # fmt + clippy, warnings are errors
cargo test --workspace    # unit tests + LiteSVM program tests (needs anchor build first)
```

`pnpm verify` runs all of the above in the same order as CI.

## Local MagicBlock stack

```bash
pnpm mb-stack
```

| Service | Endpoint |
| --- | --- |
| Solana base layer | http://127.0.0.1:8899 (ws :8900) |
| Ephemeral rollup (ER) | http://127.0.0.1:7799 (ws :7800) |
| Query filtering service (privacy tests) | http://127.0.0.1:6699 (ws :6700) |

The query filtering service emulates PER permission filtering. It is **not** a
TEE and proves nothing about the real Devnet PER.

## Layout

```text
programs/card-flex/   Anchor program (base layer + PER)
crates/card-types/    Canonical card encoding (no_std, shared with verifier and client)
apps/ packages/ services/   JS workspace (empty until P7)
docs/adr/             Architecture decision records
scripts/              Tooling checks
toolchain.env         Pinned versions, single source of truth
```

## Secrets

Never commit keypairs or `.env` files; `.gitignore` blocks them. The program
deploy keypair lives in the team secret store, not in the repo.
