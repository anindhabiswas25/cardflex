# Card Flex — agent guide

Read this first. It tells any coding agent (Claude, Codex, Cursor, etc.)
what this project is, where the sources of truth are, how to work here and
what to do next.

## What this is

Provably fair Teen Patti on Solana. The game runs as an Anchor program inside
MagicBlock's Private Ephemeral Rollup (PER, Intel TDX). Money stays on the
Solana base layer. Players buy in to a table, play hands with session keys
(no wallet pop-ups), see only their own cards, and can verify every hand.

## Sources of truth (read in this order)

1. `docs/STATUS.md` — what is done, in progress and next. Update it when you
   finish or start a ticket.
2. `Card_Flex_Devnet_PRD_MagicBlock_v1.2.md` — the engineering spec. §0
   lists decisions D1–D10. v1.1 is history only; don't build from it.
3. `Card_Flex_Delivery_Plan.md` — phases P0–P9, gates G1–G3, ticket backlog
   (CF-xxx), risks, open questions for MagicBlock.
4. `docs/adr/` — architecture decisions. ADR 0001 = pinned toolchain,
   ADR 0002 = account lifecycle, ADR 0003 = fairness encoding (both amend the PRD).
   `docs/spec/cf-fairness-v2.md` is the normative byte spec for fairness.
5. `docs/findings/` — measured facts from tickets (e.g. CF-003 latency and
   attestation).
6. `Card_Flex_MagicBlock_Implementation_Research_v1.2.md` — background
   research; where it conflicts with PRD v1.2, the PRD wins.

## Ground rules

- **No fixed release date.** Work is gate-driven; launch within one week of
  P9 passing. Never add calendar deadlines to plans.
- **The Indian market is not a target.** Don't raise Indian gaming law.
- **Pinned versions only.** `toolchain.env` is the source of truth;
  `pnpm check:toolchain` must pass. Change a pin only with an ADR.
- **Never commit secrets:** keypairs, `.env`, tokens. `.gitignore` blocks
  them. The program deploy keypair (`target/deploy/card_flex-keypair.json`)
  is not in git.
- **Never log card values, salts or seeds.** Never put hidden data in an
  account without an explicit permission list. Full list: PRD §36.
- **Don't call anything "trustless".** The PER TEE and its operator are
  trusted; say so.
- **Gates G1–G3 decide go/no-go on MagicBlock.** If one fails, stop and
  report; never fall back to a non-confidential dealer.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm check:toolchain     # versions match toolchain.env
anchor build             # program -> target/deploy/card_flex.so
pnpm lint:rust           # fmt + clippy (-D warnings)
cargo test --workspace   # needs anchor build first (LiteSVM loads the .so)
pnpm verify              # all of the above, same order as CI
pnpm mb-stack            # local MagicBlock stack: 8899 base, 7799 ER, 6699 QFS
pnpm probe -- --region <label>   # CF-003 latency/attestation probe
pnpm tablepoc -- --region <label>   # CF-006 six-player privacy matrix on devnet
pnpm privacy-suite -- --region <label>   # G1 suite incl. salts, 231 checks (needs devnet-poc build deployed)
pnpm handflow -- --region <label>   # P2: salts -> VRF -> deal -> reveal -> cf-verify (48 checks)
cargo run -p fairness-verifier --bin cf-verify -- <record.json>   # verify one hand offline
pnpm check:g2            # 10,000-hand verifier gate (release mode)
pnpm recovery -- --region <label>   # CF-013 outage drill: buy-ins, silent PER, refund + claims (~3 min)
bash scripts/restart-drill.sh   # local validator restart mid-hand (stop mb-stack first)
```

Note: `pnpm ci` is a built-in pnpm 11 command; use `pnpm verify`.

## Repo map

```text
programs/card-flex/    Anchor program: table.rs = accounts/layouts; lib.rs = instructions
                       (table, permissions, salts, VRF, deal); poc_deal = test deck (feature)
crates/card-types/     frozen canonical card encoding (no_std)
crates/fairness-core/  CF-Fairness v2 (no_std, SHA-256 injected); spec in docs/spec/
crates/fairness-verifier/  offline verifier lib + `cf-verify <record.json>` CLI
packages/probes/       common.mjs helpers, table.mjs setup; probe.mjs (CF-003), tablepoc.mjs
                       (CF-006), privacy-suite.mjs (CF-007/009), handflow.mjs (CF-010/011);
                       archive/roundtrip.mjs needs the pre-slim build (commit e017823)
docs/adr/              decisions     docs/findings/  measured results
docs/probes/           raw probe JSON per region
scripts/               check-toolchain.sh
toolchain.env          version pins
```

Planned crates and apps are listed in PRD §7.

## Git conventions

- Commit author for this repo: `anindhabiswas25 <anindhabiswas25@users.noreply.github.com>`
  (set in repo-local git config).
- One commit per ticket, message starts with the ticket id:
  `CF-00X: <summary>`, then a bullet list of what changed.
- Commit only when the user asks.

## Key facts already established

- Devnet PER: `https://devnet-tee.magicblock.app`, `magicblock-core 1.1.1`,
  about 77 ms read p50 from `dev-machine-1`, slot about 10 ms.
- PER login token: JWT valid for 30 days, no refresh endpoint. Use the
  per-seat session key as the reader of `SeatHand` (findings CF-003).
- The SDK's attestation check doesn't pin measurements or check TCB status;
  the client must do its own check (findings CF-003).
- Program is deployed on devnet at `4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL`.
  The upgrade authority is the devnet deployer `Cf3ux3ZqSfYutZyxLeEWLeNkpUkPBMneyU3VUwEUww8x`.
  Keys live outside the repo in `~/.config/cardflex/` on the dev machine:
  `devnet-deployer.json`, `card_flex-program-keypair.json`.
  Redeploy with `pnpm deploy:devnet` (builds the devnet test-deck variant,
  extends space, resumable buffer upload, byte check). Never use a bare
  `solana program deploy`: it can't resume on a flaky network.
- Devnet SOL: `solana airdrop 1 <pk> --url https://rpc.magicblock.app/devnet`
  (the public faucet is often rate-limited).
- PER round trip works (CF-004): write seen by others in about 90 ms p50
  and about 0.5 s p95 on Devnet (script archived: packages/probes/src/archive/).
- Permission flag bits: AUTHORITY 1, TX_LOGS 2, TX_BALANCES 4, TX_MESSAGE 8,
  ACCOUNT_SIGNATURES 16.
- Account placement (ADR 0002): base = GlobalConfig, TableConfig, TableVault,
  SeatLedger; delegated = TableRuntime, HandLog (committed per hand, never
  hold secrets); ephemeral-only = DealerState, SaltAccount, SeatHand (never
  committed). A commit publishes account data in plaintext; always
  delegate with `commit_frequency_ms = u32::MAX`.
- Ephemeral-only accounts with a private permission are hidden from
  strangers (reads null, no WS updates); non-members see a private
  transaction as signature + status only (CF-006 spike). Owner WS updates on
  an ephemeral account were missed once in 4 runs, so re-read, don't trust
  the socket alone.
- Six-player privacy matrix passes on Devnet (CF-006): session key reads only
  its own SeatHand, wallets read nothing, DealerState unreadable. Clients must
  POLL their own SeatHand after a deal; WebSocket delivered 0/6 in one run.
- `poc_deal` (predictable P1 test deck) only works in builds with the
  `poc-test-deck` cargo feature; never deploy that build anywhere shared or
  real-value. `anchor build` (default, CI) has it off.
- In PER an account WITHOUT a permission is readable by anyone. Create and
  permission secret accounts in the same instruction; never write table data
  before its permission exists.
- Growing a permission (more readers) costs ephemeral rent; budget
  permissions at their max size (`MAX_HAND_READERS`).
- Program logs are invisible to clients in PER; `tests/test_no_secret_logs.rs`
  allow-lists every `msg!`. Add new log lines to its list only if they carry
  no hand, salt or seed data.
- `pnpm verify` rebuilds `target/deploy/card_flex.so` WITHOUT the test-deck
  feature; rebuild with `pnpm build:program:devnet-poc` before deploying to
  devnet.
- Hand readers are ONLY the seat's session key (+ one seated opponent for
  Side Show, with the owner's session key co-signing). Session keys can
  never be the authority, a wallet, another session or a table address. Never add an instruction path that lets the authority, backend
  or a wallet become a reader; the privacy suite checks this.
- Fairness bytes are frozen: any change to `crates/fairness-core` output
  fails `cargo test` (vectors) and `pnpm check:fairness` (independent
  Python). Only change them with a protocol version bump + new ADR.
- Secrets in instruction data: the transaction must also write an account
  whose permission has NO human member (like SaltAccount); then it is
  redacted to everyone. Without that, members of other touched accounts may
  see the data (CF-009).
- `packages/probes/src/common.mjs` has a JS implementation of the
  CF-Fairness v2 hashes and the TableRuntime byte offsets (`RT`); keep the
  offsets in sync when TableRuntime changes.
- VRF inside PER: use the EPHEMERAL queue (`5hBR571…`); the base queue fails.
  Callbacks must use `#[vrf_callback]` (scoped identity PDA), not the
  deprecated global `VRF_PROGRAM_IDENTITY`. `#[vrf]`/`#[vrf_callback]`
  account structs must live in lib.rs (the generated `invoke_signed_vrf` is
  module-private). Request -> callback takes ~2 s on Devnet.
- Large accounts (TableRuntime, HandLog) must be `Box<Account<…>>` in any
  Accounts struct with more than one of them, or the 4 KB SBF stack overflows
  ("Access violation in stack frame").
- `HandLog` is PUBLIC by design (explicit `is_private = false` permission);
  `reveal_hand` makes the deck derivable, so it requires `HAND_COMPLETE`;
  today only the interim authority-only `end_hand` sets that, and P5 must
  replace it with showdown logic. Hand record format: `cf-hand-record/1` (crates/fairness-verifier).
- Money (ADR 0004): lamports only in TableVault (never delegated); only
  `SeatLedger.synced_stack` is ever paid; `sync_hand` trusts committed runtime
  state only after checking the delegation record (validator + owner) and
  copies stacks only between hands; `emergency_refund` is permissionless after
  `refund_timeout_secs` without a sync. `delegate_table` needs config writable.
- Only MagicBlock's TEE validator (`TEE_VALIDATOR`) may hold a table; the
  local validator only with feature `local-stack` (drills). Refunds are
  pull-based: `emergency_refund` then one `claim_refund` per seat.
- Local stack commits to the base layer FAIL: our Agave 3.1.10
  `solana-test-validator` can't parse MagicBlock validator 1.1.1 (solana
  4.0) transactions. Devnet commits work. Don't debug this again; it needs an
  Agave 4.x local validator (pending team approval).
- The 16 "Stack offset … exceeded" warnings from `anchor build` come from
  unused sha2 serialization code in dependencies; they predate P3 and are
  harmless.
- An Anchor program may have only ONE `#[error_code]` enum (IDL build fails
  otherwise); use `CardFlexError` in lib.rs.
- If `solana program deploy` fails mid-way, close the leftover buffer
  (`solana program show --buffers`, `solana program close <buffer>`) to get
  the SOL back, then redeploy.
- Program size matters for deploys (~1 KB per upload transaction): keep
  scaffolding out of the program; size-optimized profile is set (ADR 0001).
- Program upgrades need room: check `solana program show` Data Length vs the
  new `.so` size and run `solana program extend <id> <bytes>` first.
- MagicBlock IDs and endpoints: PRD §5.1.2 and ADR 0001.
