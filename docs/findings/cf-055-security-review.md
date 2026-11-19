# CF-055: P8 security review

**Date:** 2026-11-19 · **Scope:** the program (every instruction), keeper,
cf-admin, API, client SDK, repo secrets · **Basis:** code at commit
`5d4ef30` plus the fixes below.

Each feature also had its own review when it was built (CF-006/007/009/011/
013/022/031/032/050/053). This pass checks the whole system against the
invariants that protect money and privacy, and looks at what changed since.

## Invariants checked

| Invariant | Where it holds | Result |
| --- | --- | --- |
| Money is paid only from `synced_stack`, only to the wallet recorded at buy-in, at most once | `cash_out` (`has_one = wallet`, ledger closed), `claim_refund` (zeroes the ledger), `cancel_buy_in` (wallet signs, never-delegated tables only) | holds |
| Rake goes only to `GlobalConfig.treasury`, only from synced hands, each lamport once | `sweep_rake` (`has_one = treasury`, `rake_swept`) | holds |
| Vault ≥ rent + Σ synced stacks + unswept rake | `check_vault`; exact after every money step (CF-034), in every CF-054 run up to 50 tables | holds |
| Committed state is trusted only from MagicBlock's TEE validator | `delegate_table` pins it; `sync_hand` checks the delegation record (validator + owner) | holds |
| Stacks never copied mid-hand; stale commits refused | `sync_hand` (phase gate, `commit_seq` monotonic) | holds |
| Pause never blocks withdrawals | `cash_out`, `claim_refund`, `sweep_rake` don't check pause | holds |
| Hand readers: only the seat's session key, plus Side Show opponents recorded by the game | `set_hand_readers` (own key only), `side_show_view` (game-recorded pairs), `join_seat`/`rotate_session` (own key); `start_hand` refuses live grants | holds |
| No phase only a key holder can advance | `start_hand`, `cancel_salts`, `cancel_hand`, `timeout_turn`, `next_hand`, `abort_lost_hand`, `commit_hand`, `sync_hand`, `emergency_refund` are permissionless | holds |
| No hidden data in logs | one `msg!` (protocol version), enforced by `test_no_secret_logs.rs` | holds |
| No secrets in git | tracked files scanned (keypair arrays, `.env`); `.env.example` has placeholders only | holds |

## Findings

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| 1 | **Medium** | `GlobalConfig.authority` (treasury, max rake, pause) is set once by `init_global` and no instruction could ever change it, so the planned Squads multisig handover (CF-056) was impossible without a program upgrade. | **Fixed:** `sync_global_authority` sets it to the program's current upgrade authority, signed by that key (checked through the program data account, as `init_global` is). Handover = `solana program set-upgrade-authority` to the multisig, then the multisig sends this once. No layout change. `cf-admin global sync-authority`. Test: `settings_authority_follows_the_upgrade_authority`. |
| 2 | Low | `buy_in` was accepted before `configure_table`. `configure_table` refuses once anyone has bought in, so such a table could never get terms or start a hand. Money was recoverable (cancel before delegation, or leave + sync + cash-out, or refund), but players could buy into a table with no rules. | **Fixed:** `buy_in` requires a configured table (`NotConfigured`). Test: `buy_in_needs_a_configured_table`. All our tools already configure first. |
| 3 | Medium (accepted for Devnet) | The refund timer trusts that a commit means PER is alive (ADR 0004 trade-off). A PER that keeps committing but stops running a hand (and isn't "lost state", so CF-053 doesn't apply) keeps `emergency_refund` away indefinitely; a leave asked mid-hand waits for that hand. Only the TEE operator can cause this. | **Open, before Mainnet:** refresh `last_sync_time` mid-hand only when the committed hand made progress (hand number, phase or action count changed). Needs a `TableConfig` field (layout change → migration), so not done on Devnet. |
| 4 | Low | The keeper reads PER with the table authority's token (30 days). A token can't sign; a leaked one reads only what the authority reads: the runtime (public game state for members), never cards, salts or the seed (G1 suite). | **Accepted:** rotate the token on schedule (runbook, CF-056). A dedicated keeper reader needs a runtime permission change (later). |
| 5 | Low (P9) | The API is unauthenticated and has no rate limit (read-only, bounded page sizes, bad requests return 400 since CF-018). | **Open for P9:** put it behind a reverse proxy with rate limits (CF-060 monitoring covers health). |
| 6 | Info | The attestation quote isn't bound to the TLS connection (CF-003 gap 4); a proxy could pass `/quote` through to a real TEE. The other three SDK gaps are closed by our own check (`verifyTee`). | **Disclose** in the P9 security report. |
| 7 | Info | The table authority can close a seat's salt or hand between hands, so the next hand aborts (`abort_lost_hand`, no strikes, no money moved). That only stalls its own table, and is visible as `cancelled_hands`. | Accepted; covered by the cancel-rate alert (CF-060). |
| 8 | Info (ops) | The PER throttles new connections per IP (CF-054). A keeper that opens many connections could be cut off. | **Fixed in CF-061:** bounded keep-alive pool, HTTP-polling confirms. Ask MagicBlock for the limits when convenient. |

No high-severity findings are open. **The P8 exit criterion "no open
high-severity findings" is met.**

## Devnet

Fixes 1 and 2 deployed (devnet build, on-chain bytes match the local
build). Regression on that build: money drill 53/53, privacy suite 230/230.
