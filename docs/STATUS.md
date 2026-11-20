# Status

Current phase: **P8 (hardening), program and ops work complete.** CF-052–061 and CF-063–066 done; CF-056 done except the multisig handover (team decision). CF-062 (multi-machine load test) is replaced for now by CF-066, a one-machine multi-user test (no extra machines available, 2026-11-20 PM decision); re-run CF-062 when machines exist. P7 UI wired end to end (CF-069): every page on real Devnet data, tested in headless Chrome. Next: P9 prep (public Devnet hosting of web + keeper + API). P0–P6 done; P7 non-UI parts done and committed (CF-016/018/040/041), UI in progress (`apps/web`, not committed). Rules v1 signed off 2026-11-19. G1 and G2 passed from one location (other regions still to run the probes, CF-003); G3 signed off as GO (conditional) 2026-11-18. P8 does not wait on MagicBlock answers: open questions are sent, but every P8 ticket assumes the worst case and measures what it can itself (2026-11-19 PM decision). Update this file whenever a ticket
starts, finishes or gets blocked. Newest entries first in the log.
## Tickets

| Ticket | What | Status | Where |
| --- | --- | --- | --- |
| CF-001 | Pin toolchain, monorepo, CI | Done | commit `a5b17ab`, `docs/adr/0001-toolchain-pins.md` |
| CF-002 | PRD v1.2 with decisions D1–D10 | Done | commit `7038c6c`, `Card_Flex_Devnet_PRD_MagicBlock_v1.2.md` |
| CF-003 | Latency, access and attestation probe | In progress: probe built, `dev-machine-1` measured; other regions pending | `packages/probes/`, `docs/findings/cf-003-devnet-access.md` |
| CF-004 | Minimal program on devnet-tee: delegate, write, commit, undelegate; measure write latency | Done | `programs/card-flex` probe_* instructions, `packages/probes/src/roundtrip.mjs`, `docs/findings/cf-004-devnet-roundtrip.md` |
| CF-005 | ADR: every account marked base / delegated / ephemeral-only | Done | `docs/adr/0002-account-lifecycle.md`; PRD v1.2 amendment 1 |
| CF-006 | P1: TableRuntime + 6 SeatHand + DealerState with EphemeralPermission | Done: six-player privacy matrix passes 2/2 on Devnet; WS delivery unreliable | `programs/card-flex/src/table.rs`, `packages/probes/src/archive/tablepoc.mjs` (superseded by `pnpm privacy-suite`), `docs/findings/cf-006-six-player-table.md`, `docs/findings/cf-006-a1-ephemeral-privacy.md` |
| CF-007 | Privacy probe suite for G1 | Done from `dev-machine-1`: 134/134 checks, 2/2 runs. **G1 provisionally passed**; needs other regions + a second day | `pnpm privacy-suite`, `docs/findings/cf-007-privacy-suite-g1.md` |
| CF-008 | Canonical encoding spec (CF-Fairness v2) + test vectors | Done | `crates/fairness-core`, `docs/spec/cf-fairness-v2.md`, `docs/spec/vectors/`, `scripts/check_fairness_vectors.py`, ADR 0003 |
| CF-009 | Salt round: private `submit_salt` into SaltAccount, public commitment | Done: suite 231/231 (2/2 runs) incl. salts; salt tx redacted to everyone | `open_salt`/`start_hand`/`submit_salt`, `docs/findings/cf-009-salt-round.md` |
| CF-010 | VRF request with caller_seed when SALTS_DONE; protected callback derives the seed | Done: ephemeral queue works inside PER, callback ~2.0–2.1 s; 12/12 checks ×2 | `request_shuffle`/`vrf_deal`, `pnpm handflow`, `docs/findings/cf-010-vrf.md` |
| CF-011 | Shuffle, deal and Merkle root in-program from the seed; compute units; remove test deck from the real path | Done: Devnet 39/39 ×2, all cards verified vs public root; 56–86k CU; salt-substitution + stuck-VRF fixes | `deal_hand`/`cancel_hand`, `tests/test_deal.rs`, `docs/findings/cf-011-deal.md` |
| CF-012 | Independent verifier v1 (CLI): reveal + rebuild a hand from public data | Done: Devnet hand revealed, read with no token, `cf-verify` VALID (PER and base-layer copies); 10,000 random hands VALID + tampers caught. **G2 passed** (one location) | `crates/fairness-verifier`, `reveal_hand`, `docs/findings/cf-012-verifier-g2.md` |
| CF-013 | P3 recovery: PER outage drills, pause, `emergency_refund` on base | Done: Devnet outage drill 20/20 (pull-based refunds, validator pinned); local restart drill: state survives and hand continues; local commits blocked by an Agave 3.1 vs MagicBlock 4.0 tx-format mismatch. **G3 recommended GO (conditional), awaiting PM sign-off** | `docs/adr/0004-recovery-policy.md`, `docs/findings/cf-013-recovery.md`, `pnpm recovery`, `scripts/restart-drill.sh` |
| CF-014 | Teen Patti rules v1 sign-off (PRD §11.3) | Done: signed off by the PM 2026-11-19 (all ⚑ choices confirmed) | `docs/spec/teen-patti-rules-v1.md` |
| CF-015 | `teen-patti-core` crate (ranking, betting, Show/Side Show, settlement) | Done: 16 tests incl. all 22,100 hands and 20,000 random hands; rules vectors frozen (222 ranked hands, 128 games incl. every ending and all 13 error kinds) and checked by an independent Python implementation | `crates/teen-patti-core`, `docs/spec/teen-patti-rules-v1.md`, `docs/spec/vectors/teen-patti-rules-v1.json`, `pnpm check:rules` |
| CF-020 | P5: betting in the program (teen-patti-core on-chain, session-key actions, boot at deal) | Done (Devnet verified in CF-025): `act`; differential test vs host engine over random hands; ≤ 49k CU per action; `poc_join` removed (seats only via `buy_in`) | `programs/card-flex/tests/test_game.rs` |
| CF-021 | P5: showdown + settlement set HAND_COMPLETE; remove `end_hand`; reveal after showdown | Done (Devnet verified in CF-025): `end_hand` removed; public action log in `HandLog`; `cf-verify` replays the game (`cf-hand-record/2`) | `docs/spec/teen-patti-rules-v1.md` §7 |
| CF-022 | P5: Side Show driven by game state (mutual read grant on accept, auto-revoke) | Done (Devnet verified in CF-025): `side_show_view`; `set_hand_readers` revoke-only; fix: `start_hand` refuses a live grant | `programs/card-flex/tests/test_game.rs`, `pnpm handflow` |
| CF-023 | P5: turn deadlines, permissionless timeout, MagicBlock crank | Done (Devnet verified in CF-025): `turn_deadline`, `timeout_turn`. Crank: the pinned SDK has no crank feature (ADR 0001), so a keeper calls `timeout_turn`; scheduling it is P8 keeper work | `programs/card-flex/tests/test_game.rs` |
| CF-024 | P5: multi-hand loop (button moves, next hand, commit + sync per hand) | Done (Devnet verified in CF-025): `button`, `next_hand`; fix: only dealt seats may submit salts | `programs/card-flex/tests/test_table.rs` |
| CF-025 | P5: six-player full game on Devnet, verified end to end | Done: 3- and 5-hand games 39/39 and 66/66; handflow 67/67, privacy suite 230/230, recovery 20/20; fix: Side Show viewers cleared by `next_hand` | `pnpm game`, `docs/findings/cf-025-full-game.md` |
| CF-030 | P6: ADR 0005 (seat lifecycle + money) and `GlobalConfig` (treasury, max rake, pause) | Done (Devnet verified in CF-035) | `docs/adr/0005-seat-lifecycle-and-money.md`, `tests/test_global.rs` |
| CF-031 | P6: seat epochs; `buy_in` ledger-only + `join_seat` (base or PER) | Done (Devnet verified in CF-035): `cancel_buy_in` for unjoined seats while not delegated; seat hands and salts opened for empty seats | `tests/test_recovery.rs` |
| CF-032 | P6: `leave_seat` → sync marks left → `cash_out` (once, recorded wallet) | Done (Devnet verified in CF-035); also fixed two CF-031 review findings (seat bricking after cancel, stale-clone race) | `tests/test_recovery.rs`, ADR 0005 amendment |
| CF-033 | P6: rake synced from committed results; `sweep_rake` to the treasury | Done (Devnet verified in CF-035) | `tests/test_recovery.rs` |
| CF-034 | P6: reconciliation (`check_vault`, `pnpm reconcile`) | Done (Devnet verified in CF-035): exact after every money step in LiteSVM | `tests/test_recovery.rs`, `packages/probes/src/reconcile.mjs` |
| CF-035 | P6: Devnet money drill (join/leave mid-session, reconcile to the lamport, double cash-out refused) | Done: 53/53; vault exact after all 7 money steps; join in PER reads the base ledger first try (~1 s) | `pnpm money`, `docs/findings/cf-035-money-drill.md` |
| CF-016 | P7: client SDK (`packages/client-sdk`): PDAs, IDL-driven accounts + instructions, PER login, own TEE attestation, fairness, rules v1 in TS | Done: 10 offline tests (incl. all 128 rules vectors, fairness vectors, byte-level match with the probes); live Devnet check OK | `pnpm test:sdk`, `pnpm --filter @card-flex/client-sdk live` |
| CF-018 | P7: backend / indexer (lobby, hand history, player records) | Done: `services/api` (node:http + node:sqlite, ADR 0006); every hand verified with the WASM verifier and replayed for per-seat bets/nets; live on Devnet: 6 tables, 4 hands, all VALID | `pnpm api`, `pnpm test:api` |
| CF-040 | P7: `cf-verify` as WASM for the browser Verify page | Done: `crates/fairness-wasm` (277 KB, no imports) + `loadVerifier` in the SDK; same verdicts as the native CLI on 6 Devnet hands; tampering caught | `pnpm build:wasm`, `packages/client-sdk/test/verifier.test.ts` |
| CF-041 | P7: admin backend (create/configure tables, pause, sweep rake) | Done: `cf-admin` CLI signing locally (no key-holding server); live on Devnet: create → open (15 PER steps) → status → strict reconcile → sweep → close | `pnpm admin -- …`, `pnpm test:admin` |
| CF-050 | P8: program liveness: salt-round timeout (`cancel_salts`, absent players leave), permissionless `start_hand`, `undelegate_table` bumps `commit_seq` | Done locally (Devnet with CF-051) | `tests/test_table.rs` |
| CF-051 | P8: keeper service (drives every phase, commit + sync per hand + heartbeat, indexes each hand before next_hand) | Done: `services/keeper` (pure `decide` + executor, permissionless instructions only, PER read token); Devnet drill 7/7 | `pnpm keeper`, `pnpm keeper-drill`, `pnpm test:keeper` |
| CF-052 | P8: program slimming (drop test-only code from production builds, size) | Done: `bench_deal` removed, `poc_deal` compiled out of production builds, `opt-level = "z"` (864 → 802 KB; deal 106k CU, act ≤ 66k CU, ceilings in tests) | ADR 0001 amendment |
| CF-053 | P8: recovery abort path for a hand whose ephemeral state was lost (ADR 0004 #8) | Done: `abort_lost_hand` + keeper (`STUCK_SECS`); Devnet drill 11/11 ×2; privacy 230/230 (final build), handflow 67/67 and keeper drill 7/7 (first CF-053 build) | `pnpm lost-drill`, `docs/findings/cf-053-lost-state.md`, ADR 0004 amendment |
| CF-054 | P8: load test, 5 → 10 → 25 → 50 concurrent tables (latency, VRF time, errors, keeper lag, commit cost) | Done: 50 tables stable and exact (150/150 hands, 50/50 vaults) but too slow (salts → dealt 18 s p50 / 35 s p95); bottleneck is our keeper → CF-061 | `pnpm load-test`, `docs/findings/cf-054-load.md` |
| CF-055 | P8: security review pass (incl. a keeper key that is not authority-derived) | Done (Devnet: money drill 53/53, privacy 230/230): no high findings open; fixed `GlobalConfig` authority could never change (blocked the multisig) and buy-in before configure; 1 medium accepted for Devnet (refund timer vs a committing-but-stalled PER) | `docs/findings/cf-055-security-review.md` |
| CF-056 | P8: ops: Squads multisig, production refund timeout, reconcile alarms, runbooks | Done except the multisig handover itself (needs the team's members + threshold): refund timeout 1,800 s, keeper heartbeat 300 s in every phase (fixes mid-hand refund), `cf-admin watch` alarms, `cf-admin table repair`, `--dry-run --as` for Squads proposals, runbooks | `docs/runbooks/`, ADR 0004 amendment |
| CF-057 | P8: commit-fee model (cost per table-hour, keeper wallet budget, behaviour past 10 commits) | Done: **found tables stopped committing after 10 hands (launch blocker)**; fixed (runtime PDA pays commits via MagicBlock's fee vault; 13/13 commits on Devnet). Player pays 15,000 lamports per session, moves free; keeper 5,000 per hand | `docs/findings/cf-057-fees.md`, `pnpm --filter @card-flex/keeper fees` |
| CF-058 | P8: TEE measurement-change alert (we pin what we observe; alert when Devnet's changes) | Done: `cf-admin watch` runs our attestation check every 600 s (`TEE_MEASUREMENTS_CHANGED`, `TEE_TCB`, …); `cf-admin tee` prints live values; Devnet still matches the 2026-11-18 pins | `services/admin/src/watch.ts`, `docs/findings/cf-064-065-p8-closeout.md` |
| CF-059 | P8: empty permission member list (MagicBlock open question 3) | Done: answered by construction: no private permission can have an empty list (program guard + source-scan test); Devnet: empty seats' hands (reader = default key) unreadable to strangers and players | `tests/test_permission_members.rs`, keeper drill |
| CF-060 | P8: monitoring and alerts (keeper health, cancel rate, tables near refund, reconcile failures) | Done: keeper `GET /health` (`HEALTH_PORT`); `cf-admin watch --keeper-url/--keeper`: `KEEPER_DOWN`, `KEEPER_UNHEALTHY`, `KEEPER_LOW_FUNDS` (plus CF-056 vault/refund/claims/cancel alarms) | `services/keeper/src/health.ts`, `docs/runbooks/alarms.md` |
| CF-061 | P8: keeper scaling: one loop per table, batched reads; re-run the CF-054 staircase | Done: per-table loops, batched reads, HTTP-polling confirms (fixes an OOM), bounded keep-alive pools. 50-table capacity not measurable from one IP (PER per-IP limit); PM accepted for P8 (option 3), re-test in CF-062 | `services/keeper/src/run.ts`, `docs/findings/cf-054-load.md` |
| CF-063 | P8: keeper seats players who bought in mid-hand, before the next hand | Done: Devnet `pnpm --filter @card-flex/keeper join-drill` 3/3 (bought in during hand #0, dealt into hand #1) | `services/keeper/src/keeper.ts` |
| CF-064 | P8: table pays only for needed commits (spam-commit drain, CF-057 review) | Done: fee-vault commits need changed state between hands, 240 s since the last paid one, or the authority; else `CommitNotNeeded`. Keeper syncs instead. Devnet drill: stranger's spam commit refused | `programs/card-flex/src/lib.rs` `commit_hand`, `docs/findings/cf-064-065-p8-closeout.md` |
| CF-065 | P8: keeper's own read key (CF-055 open item) | Done: `set_keeper` / `cf-admin table keeper`; keeper logs in with its own key, reads the runtime only (Devnet: 0 of 13 secret accounts readable); restarts every 20 days for a fresh token | `TableRuntime.keeper`, `docs/runbooks/keeper.md` |
| CF-066 | P8: one-machine multi-user test (stands in for CF-062) | Done: see log 2026-11-20 | `pnpm multiuser`, `docs/probes/*-cf066-multiuser-*.json` |
| CF-067 | P8: old Devnet tables after the layout change; safe retries; CLI args | Done: `migrate_runtime` + `cf-admin table migrate` (Devnet: old table migrated and played, 12/12); old live tables refund exactly (Devnet 4/4); `sendAndConfirm` never applies a transaction twice; fixed migration budget, keeper permission budget, misleading `BadSeatHand` on locked tables | `docs/findings/cf-064-065-p8-closeout.md` |
| CF-069 | P7: web app wired to Devnet (lobby, table, verify, dashboard, wallets, sounds/settings) | Done: headless-Chrome E2E on Devnet 2p 13/13, 3p Side Show 7/7, Wallet Standard 6/6, phone width clean; fixed keeper departedSynced, API >100-account read, runtime headroom (`table open` reserve + keeper health) | `apps/web`, `docs/findings/cf-069-web-app.md` |
| CF-070 | Whole-codebase audit and optimisation | Done: `act` −38% CU (71,097 → 44,023), `deal_hand` −17%; fixed `cancel_hand` not applying leaves; keeper pays departed players (seats no longer blocked); refund flow for stalled tables in the app; runtime reserve 0.05 SOL + headroom alarm. Devnet: privacy 230/230, handflow 67/67, keeper drill 13/13, web 2p 13/13, 3p 9/9, wallet 6/6, refund 2/2 | `docs/findings/cf-070-audit.md` |
| CF-062 | P9 prerequisite: multi-machine load test (bots spread over several machines/IPs, one keeper), 50 tables, latency targets | Deferred: no extra machines now; CF-066 covers multi-user correctness from one IP. Run before public launch traffic when machines exist | `pnpm load-test` per machine |

## Open program items (P8)

- (fixed in CF-050) `undelegate_table` now bumps `commit_seq`.

- (fixed in CF-065) the keeper has its own read key; no authority token on
  the keeper machine.
- (fixed in CF-064) permissionless `commit_hand` can't drain a table's budget.

## Blockers and asks for the team

- From every target region run `pnpm probe`, `pnpm privacy-suite` (and
  optionally `pnpm roundtrip`) with `-- --region <label>` and commit the JSON
  (CF-003, G1 sign-off).
- Move the devnet keys from `~/.config/cardflex/` (dev machine only) into the
  team secret store: `card_flex-program-keypair.json` (program address) and
  `devnet-deployer.json` (fee payer + current upgrade authority).
- Ask MagicBlock about the write-latency tail on Devnet (CF-004) and missed
  `accountSubscribe` updates for ephemeral accounts (CF-006).
- Ask MagicBlock: the commit payer's required margin above rent, and how
  to top up a delegated account's balance inside the ER (CF-069; a live
  table's runtime can't be refuelled today).
- Ask MagicBlock which local base-layer (solana-test-validator) version their
  validator 1.1.1 expects for commits (local commits fail with 3.1.10 and 4.0.3).
- Ask MagicBlock: open questions in delivery plan §11 (4 is answered).
  Non-blocking: P8 proceeds on worst-case assumptions (TEE restart may lose
  ephemeral state → CF-053; measurements may change unannounced → CF-058
  alarm; commit fees measured in CF-057; empty member list made moot by
  CF-059).
  Answers still matter for Mainnet.

## Log

- 2026-11-21 — CF-070 audit. Program: stamp checks instead of PDA
  re-derivation in hot paths (`act` 71,097 → 44,023 CU, 6-seat deal
  106,590 → 88,436, size −13 KB); bug fixed: `cancel_hand` didn't apply
  pending leaves. Off-chain: the keeper pays departed players itself (a
  ledger nobody cashed out blocked its seat); the app recognises those
  payouts, offers "Start refund & claim" for stalled tables, tells busted
  players to leave, polls the lobby once. Found: one Devnet table lost ~4M
  lamports of runtime balance in an hour (cause unknown; normal play
  measured ~0) and then couldn't commit; safeguards: 0.05 SOL reserve at
  open, headroom logged per hand, alarm below 2M; question for MagicBlock.
  Deployed (bytes verified); full Devnet regression green.
- 2026-11-20 — CF-069: the web app is real. Lobby/table/verify/dashboard
  read Solana + PER; buy-in/cash-out/refund signed by the wallet (Wallet
  Standard or a Devnet test wallet), moves/salts/leave by a tab-only session
  key, resume via `rotate_session`; TEE attestation checked in the browser;
  revealed hands verified in the browser (WASM). Headless-Chrome E2E on
  Devnet: 2 players 13/13, 3 players with Side Show 7/7, Wallet Standard
  6/6. Found and fixed: keeper waited for the heartbeat before syncing a
  returning player's departure (4 min → 11 s); API indexer read >100
  accounts per call (failed every pass); a table opened with ~15,000
  lamports of runtime headroom stopped committing after churn
  (InsufficientFundsForRent; can't top up a live runtime) → `table open`
  funds a 0.005 SOL reserve, keeper health alarms below 100,000. Lobby
  tables: Violet Hall EfMDxq9…, Moon Court 72vx3CE…, Ember Room AciNdk4….
- 2026-11-20 — CF-067: follow-up on three issues from the P8 close-out.
  (1) Old tables (1,212-byte runtime, ~280 test tables on Devnet): money was
  never trapped (refund path doesn't read the runtime; proven live on an old
  table still in PER: both seats paid exactly). New permissionless
  `migrate_runtime` / `cf-admin table migrate` grows old runtimes; Devnet
  drill on an old, previously opened table 12/12 (2 hands VALID, vault
  exact). Found and fixed on the way: migration must restore the runtime's
  ephemeral budget (open failed with InsufficientFundsForRent), the runtime
  permission budget lacked room for the CF-065 keeper key, and locked
  tables gave a misleading `BadSeatHand` on base-layer joins (now
  `PerAccountsMissing`). (2) Retries resent transactions that had landed:
  root cause `confirmByPolling` threw on one failed poll; fixed there, plus
  SDK `sendAndConfirm` (checks earlier copies before any resend) used by all
  scripts and `cf-admin`. (3) `cf-admin` argument parsing extracted and
  tested.
- 2026-11-20 — P8 close-out (CF-064, CF-065, CF-059, CF-058, CF-060,
  CF-066), all on Devnet with the new program (byte-verified):
  CF-064: the table pays a commit only when its state changed between
  hands, 240 s passed, or the authority asks (`CommitNotNeeded` otherwise;
  the keeper then just syncs). CF-065: `set_keeper` gives the keeper its own
  read key (runtime only; Devnet: 0 of 13 secret accounts readable).
  CF-059: no private permission can have an empty member list (guard + test;
  the first guard broke the public HandLog permission on Devnet, fixed).
  CF-058: `cf-admin watch` alarms on TEE measurement/TCB changes;
  `cf-admin tee`. CF-060: keeper `/health` + `KEEPER_DOWN/UNHEALTHY/
  LOW_FUNDS` alarms (smoke-tested live). CF-066 (stands in for CF-062, no
  extra machines): `pnpm multiuser`, 4 full tables × 6 separate users
  (24 users, own wallets, session keys and PER logins), one keeper with its
  own key: 25/25 — 20 hands all VALID, mid-hand buyer seated and dealt the
  next hand, leaver cashed out exactly (925,000 lamports), 72/72 own-hand
  reads and 0/72 neighbour reads, vaults exact, spam commit refused; action
  confirm 269 ms p50 / 1.1 s p95, salts → dealt 3.2 / 5.2 s, own hand
  visible 90 / 427 ms. Regression: privacy suite 230/230, keeper drill
  13/13. Also fixed: probe scripts lacked CF-057's `magic_fee_vault` slot
  (cleanup failed with 3008); `pnpm admin -- <cmd>` skipped the command.
  Runtime grew to 1,284 bytes (new fields at the end): Devnet tables made
  before today can't be read by the new program; create new ones.
  Next: the UI (P7).
- 2026-11-19 — CF-063: a table plays with 2+ players; someone arriving
  mid-hand waits for the next hand. `join_seat` only works between hands,
  and nothing seated a waiting player unless their app hit the ~5 s gap.
  The keeper now reads TableConfig (cached 3 s) between hands and seats
  bought-in, unseated players before `start_hand` (a ledger that fails to
  join twice is skipped, so it can't block the table). Devnet join drill
  3/3. Open from the commit security review: with the fee vault the
  runtime pays for a permissionless `commit_hand`; free on Devnet, but on
  Mainnet anyone could drain the table's budget by spamming commits. Fix
  next: runtime pays only when the table changed since the last commit or
  a heartbeat interval passed.
- 2026-11-19 — CF-057: fee measurement through the whole player journey
  found a launch blocker: MagicBlock allows 10 commits per account by a
  payer that isn't delegated; from the 11th, `commit_hand` failed
  (`0xA0000000`), so syncs, cash-outs and even closing stopped: every table
  died after ~10 hands. A delegated keeper escrow didn't help (never
  charged). Fix: optional `magic_fee_vault` on `commit_hand` /
  `undelegate_table`; with it the table's delegated runtime PDA pays,
  program-signed. Devnet: 13/13 commits, full journey incl. cash-out and
  close; no commit fee charged on Devnet. Fees: player 15,000 lamports per
  session (rent returned, moves free); operator ≈ 0.031 SOL per table
  (rent); keeper 5,000 per hand.
- 2026-11-19 — CF-056: production refund timeout 1,800 s and keeper
  heartbeat 300 s in every phase. Found: the keeper heartbeated only between
  hands, so a hand longer than the refund timeout (possible: pot limit 1,024
  boots at 25 s per turn) made the table refundable mid-hand and anyone could
  void the hand. `cf-admin watch`: alarms for vault short/surplus, refund
  near/due (live tables only), claims pending, cancel rate, optional webhook,
  `--once` for cron; run on Devnet over all 262 deployer tables: no vault
  mismatch. `cf-admin table repair`: re-creates lost secret accounts after
  `abort_lost_hand` (Devnet: closed one salt, repair re-created exactly it).
  `--dry-run` prints full instructions and `--as <vault>` builds them for a
  Squads vault. Runbooks in `docs/runbooks/` (alarms, incidents, keeper,
  deploy, multisig). The multisig handover itself waits for the team to pick
  members and threshold.
- 2026-11-19 — CF-055: security review of every instruction against the
  money and privacy invariants, plus keeper, cf-admin, API, SDK and repo
  secrets. Fixed: `GlobalConfig.authority` could never change, so the
  Squads handover (CF-056) was impossible → `sync_global_authority` (settings
  follow the program's upgrade authority; `cf-admin global sync-authority`);
  `buy_in` before `configure_table` left a table that could never get terms
  → `NotConfigured`. Accepted for Devnet: the refund timer trusts any commit,
  so a PER that commits but stalls a hand keeps refunds away (fix needs a
  TableConfig field; before Mainnet). No high findings open. Deployed to
  Devnet; money drill 53/53 and privacy suite 230/230 on that build.
- 2026-11-19 — PM decision on the 50-table criterion (option 3): accepted
  for P8 on correctness (every vault exact in every run up to 50 tables,
  fast up to 25 tables); the capacity number is re-measured with bots on
  several machines before public Devnet (CF-062, P9 prerequisite). Next:
  CF-055 security review.
- 2026-11-19 — CF-061: keeper scheduler rewritten (`run.ts`): one batched
  reader (getMultipleAccountsInfo + one getSlot per round) and one worker
  per table, so a table in commit + sync no longer stalls the rest (50-table
  deal wait p50 18 → 10 s). Found and fixed a keeper crash: a PER WebSocket
  closing during `confirmTransaction` made web3.js spin on
  `signatureSubscribe` until out of memory; all sends now confirm by HTTP
  polling (`confirmByPolling`, 150 ms → 1 s backoff). Keeper uses a bounded
  keep-alive pool (`PER_SOCKETS`, 16). Load probes show the PER throttles
  per IP (new-connection bursts time out; sustained load from one machine
  got connections refused for minutes), so 50-table capacity can't be
  measured with 100 bots on one machine. Money stayed exact in every run.
- 2026-11-19 — CF-054: load staircase on Devnet with one keeper and 2 bots
  per table playing 8-action hands. 5/10/25/50 tables: every hand finished
  (150/150 at 50), every vault exact, only transient send failures. Action
  confirm p95 0.7/1.1/1.2/5.8 s; salts → cards dealt p50 3.9/6.1/13.1/18.1 s
  (p95 35 s at 50). The deal wait grows with table count because the keeper
  ticks all tables together and waits for the slowest (a table's
  commit + sync takes seconds), so the bottleneck is ours, not the PER's →
  CF-061. Base cost 5,000 lamports per hand. Harness hardened after a PER
  connect timeout crashed the first 10-table run (its 10 tables were closed).
- 2026-11-19 — CF-053: a hand whose secret state was lost froze money
  indefinitely (nothing could finish it, and heartbeat syncs kept the refund
  timer from ever firing). New permissionless `abort_lost_hand`: given the
  dealer, seat hands and salts of the dealt seats, it ends the hand only if
  one is missing or zeroed; before settlement nothing moved, a settled but
  unrevealable hand is voided (start stacks back, rake back). The keeper
  tries it after `STUCK_SECS` (120 s) without progress, since private
  accounts read as null to it either way. `open_seat_hand` clears the seat's
  grant bit. Devnet: PER accepts a transaction naming a missing ephemeral
  account; drill 11/11 twice (keeper aborted in 11–13 s, no strikes, then a
  full VALID hand, vault exact). Regression: privacy 230/230 on the final
  build; handflow 67/67 and keeper drill 7/7 on the first CF-053 build. Program 818,744 B (devnet build).
- 2026-11-19 — CF-052: production builds carry no test-only code:
  `bench_deal` removed (its CU check moved onto the real `deal_hand` test),
  `poc_deal` and the test deck compiled only with `poc-test-deck` (gone from
  the default IDL). Workspace crates now `opt-level = "z"`: 864,208 →
  801,632 B for +18% CU on a 6-seat deal (106k) and +25% per action (66k),
  both far under 200k; tests fail above 150k / 100k. Unused error variants
  kept so error codes don't shift. The probes derive a missing instruction
  discriminator from its name, so they work whichever build sits in
  `target/` (found when the privacy suite stopped at `poc_deal`).
- 2026-11-19 — P8 plan: PM decided not to wait on MagicBlock answers. New
  tickets CF-057…CF-061 turn the open questions into our own measurements
  and safeguards; CF-054 becomes a 5 → 50 table staircase. Status table
  corrected (P7 non-UI tickets are committed; G3 already signed off).
- 2026-11-19 — CF-051: keeper. `services/keeper`: a pure `decide(runtime)`
  picks the one permissionless step for each phase (start, cancel stalled
  salts, request VRF, cancel a missing callback, deal, grant Side Show views,
  time out a slow player, reveal; on REVEALED index the hand, revoke views,
  next_hand, then one commit + sync; heartbeat and departed-seat syncs when
  idle). It never takes a player's own step. Devnet drill (`pnpm
  keeper-drill`) 7/7 on the CF-050 build: an absent bot got 3 strikes in
  99 s and was made to leave; the keeper synced it and it cashed out its full
  buy-in; then 3 hands played to the end unattended, each indexed by the
  keeper before next_hand (closes the indexer gap) and VALID; vault exact.
- 2026-11-19 — CF-050 fix (security review): permissionless `start_hand`
  plus "miss one salt round and you're out" let anyone evict present but
  briefly slow players. Now a missed round only cancels the hand and counts
  a strike (`missed_salts`, reset by submitting or joining); a seat leaves
  after `MAX_MISSED_SALTS` = 3 in a row; `start_hand` needs `HAND_GAP_SECS`
  = 3 since the last hand ended or was cancelled (`last_hand_end`).
- 2026-11-19 — P8 started. CF-050 (local): a liveness audit for the keeper
  found that a salt round had no timeout: one absent player froze the table
  and, because heartbeats kept it "alive", the refund never triggered either,
  so every player's money was stuck. New `cancel_salts` (permissionless after
  `SALT_SECS` = 30): back to IDLE with a new hand number, non-submitters made
  to leave (cash-out after sync), nothing charged (boots are taken at the
  deal). `start_hand` is permissionless (a keeper holds no table key; an
  operator can't stall a table). `undelegate_table` bumps `commit_seq`.
  Also fixed (security review of CF-018): one malformed request could crash
  the API process; now 400/500 and it keeps serving.
- 2026-11-19 — CF-041 (not committed): `services/admin` → `cf-admin`, an
  operator CLI that signs locally (a server holding the admin key would be
  the most valuable target; the authority moves to a Squads multisig in P8).
  Commands: global show/set (pause), tables, table create/open/status/check/
  sweep/close, `--dry-run`. Live on Devnet: created a table, took it live,
  reconciled exactly, closed it. A live check of the SDK's player builders on
  that table also passed (buy-in on base, join inside PER, session-only hand
  access, session-signed leave, sync, cash-out). Found: undelegating without
  a fresh commit leaves the final state unsyncable (see open program items);
  close now commits first. The test player's 0.001 SOL was recovered through
  the normal path; the vault reconciled back to rent only.
- 2026-11-19 — CF-018 (not committed): `services/api` indexer + read-only
  API (ADR 0006: Node built-ins, no new dependencies; PostgreSQL later).
  Finds tables on the base layer, reads each public HandLog from PER,
  rebuilds `cf-hand-record/2`, verifies it with the WASM verifier, replays it
  with the TS rules for per-seat bets and nets (nets sum to minus the rake),
  stores invalid hands flagged rather than hidden. Routes: /health, /tables,
  /tables/:config, /tables/:config/hands, /hands/:config/:hand,
  /players/:wallet. Found and fixed an SDK bug on the way: short u8 arrays
  decoded as Uint8Array, so `.map` silently produced zeros (seat lists).
  Live on Devnet: 6 tables and 4 revealed hands indexed, all VALID. Gap
  (documented): only the latest hand per table is visible between polls.
- 2026-11-19 — CF-040 (not committed): the hand verifier runs in the
  browser and Node. `crates/fairness-wasm` wraps `fairness-verifier` behind a
  3-function C ABI (no wasm-bindgen, no new tool; only the wasm32 target was
  added to the pinned toolchain, ADR 0001 amendment). SDK `loadVerifier`;
  agrees with the native `cf-verify` check by check on 6 Devnet hands.
- 2026-11-19 — CF-016 (not committed): `packages/client-sdk`. Account
  decoders and instruction builders come from the program's IDL (a test
  fails if the copy drifts from `target/idl`); decoders cross-checked
  against the byte offsets the Rust tests pin; instruction bytes match the
  probes. Own TEE attestation closes 3 of the 4 SDK gaps from CF-003 (CSPRNG
  challenge, TCB must be UpToDate, MRTD/RTMR0-2 allow-list); gap 4 (quote
  not bound to TLS) remains and is documented. Rules v1 in TypeScript
  replays all 128 frozen games exactly; `legalActions` drives the buttons.
  Live on Devnet: attestation OK (measurements unchanged since CF-003), PER
  login with a session key, real GlobalConfig decoded.
- 2026-11-19 — CF-035: P6 exit met on Devnet. Money drill 53/53: a player
  bought in on base while the table was live and joined inside PER on the
  first try (~1 s, the open ADR 0005 assumption holds); a mid-hand leave,
  sync, one exact cash-out (second refused); a new player reused the seat
  and the old session lost access; rake swept to the treasury once; the
  vault matched rent + synced stacks + unswept rake exactly after all 7
  steps. handflow 67/67, privacy suite 230/230, recovery 20/20, game
  (3 hands) 39/39 on the same build. Found: delegation needs more rent now (probes fund 0.06 SOL per
  table); deploy needs a 4.35 SOL buffer for the 856 KB program, and the
  deploy script now prints the real error instead of retrying.
- 2026-11-19 — CF-034 (local): `check_vault(strict)` — read-only,
  permissionless; fails if the vault is short of rent + Σ synced stacks +
  unswept rake, and with `strict` on any surplus. A LiteSVM test runs it
  after every money step (buy-ins incl. unjoined, sync with rake, sweep,
  leave + cash-out, cancel, emergency refund + claim): exact each time.
  `pnpm reconcile -- --table <config> [--strict]` prints every term from
  devnet and asks the program (simulated).
- 2026-11-19 — CF-033 (local): `sync_hand` copies the committed
  `rake_owed` into `TableConfig.synced_rake` between hands (never lower);
  permissionless `sweep_rake` pays `synced_rake − rake_swept` to
  `GlobalConfig.treasury`, once. Test checks the ADR 0005 vault formula to
  the lamport after the sweep.
- 2026-11-19 — CF-032 (local): `leave_seat` (session key or wallet; at once
  between hands, otherwise at `next_hand`); `sync_hand` marks a departed
  matching-epoch ledger `left` with its final stack; `cash_out` pays it once
  to the recorded wallet and closes the ledger; the seat can then be bought
  and joined again with a new epoch. Security review of CF-031 found two
  real bugs, both fixed with regression tests: a cancelled buy-in bricked the
  seat (join required epoch + 1 exactly) and anyone could cancel; and a
  cancel after an undelegation could let a stale PER clone seat refunded
  money. Now: join accepts any newer, unsynced epoch; cancel is wallet-signed
  and only on never-delegated tables.
- 2026-11-19 — CF-031 (local): `buy_in` works on a live table (ledger with
  a new seat epoch, payout wallet, session key; pause-checked); permissionless
  `join_seat` seats exactly the next epoch between hands and, in PER, swaps
  the seat hand and runtime reader lists. `sync_hand` copies stacks only on
  matching epochs, so an unjoined ledger keeps its buy-in. `cancel_buy_in`
  refunds an unjoined ledger only while the runtime isn't delegated (no race
  with a PER join). Seat hands and salts are opened for empty seats too.
  Program now 811 KB (deploy script extends the slot).
- 2026-11-19 — P6 started. ADR 0005: seat epochs keep a seat's old and new
  occupant apart; buy-in = ledger on base + `join_seat`; leave at a hand
  boundary, cash-out once from synced state; rake swept only from synced
  results; vault invariant. CF-030: `GlobalConfig` (treasury, max rake,
  pause), created only by the program's upgrade authority; pause blocks new
  tables (and buy-ins, CF-031), never withdrawals.
- 2026-11-19 — P4 exit met: rules v1 vectors frozen
  (`docs/spec/vectors/teen-patti-rules-v1.json`, generated and pinned by
  `cargo test -p teen-patti-core --test vectors`). 222 ranked hands, the
  category counts, 128 game logs (all three endings, split pots incl. an odd
  lamport, 13 error kinds). `scripts/check_rules_vectors.py` re-implements
  the rules from spec §8 (new: comparison key, check order, error names)
  with the standard library only and matches all of them; tampering is
  caught. Added to `pnpm verify` as `pnpm check:rules`.
- 2026-11-19 — CF-025: P5 exit met. Program redeployed to Devnet; full
  six-player games (3 and 5 hands) pass end to end with every hand verified
  by `cf-verify` (deck + game result), conservation, commit + sync to the
  ledgers, and button rotation. handflow 67/67, privacy suite 230/230,
  recovery 20/20 on the same build. Fix: `next_hand` clears Side Show
  viewers. Findings: `docs/findings/cf-025-full-game.md`.
- 2026-11-19 — CF-024 (local): multi-hand loop. `TableRuntime.button`
  (starts on the last seat); dealing starts left of it; permissionless
  `next_hand` (after reveal) moves it to the first dealt seat, bumps
  `hand_no` and resets per-hand state. Fix: `submit_salt` accepted a salt
  from a seated but undealt seat, which would stall the hand forever; now
  only dealt seats may submit.
- 2026-11-19 — CF-023 (local): turn timer. `deal_hand` and every action
  except See set `turn_deadline = now + 25 s`; after it, permissionless
  `timeout_turn` applies Timeout (pack, or reject a pending Side Show)
  through the same engine and public log. No MagicBlock crank in the pinned
  SDK, so a keeper cranks it (P8). handflow waits out one real turn on
  Devnet to check the PER clock.
- 2026-11-19 — CF-022 (local): Side Show view is driven by the game only.
  An accepted Side Show records the pair; permissionless `side_show_view`
  grants the mutual view and revokes it after the hand. `set_hand_readers`
  is now revoke-only (no operator or consent-based grants). Security fix:
  `start_hand` used to ignore live grants, so a previous Side Show viewer
  could have read the seat's next hand; it now fails with `GrantActive`.
  Privacy suite G1-4 rewritten (grants outside the game rejected); the real
  Side Show runs in `pnpm handflow`.
- 2026-11-19 — CF-020/021 (local): the program plays hands with
  `teen-patti-core`. `act` (session key, sequence number) bets, packs, shows
  and side-shows; settlement writes stacks and rake and is the only way to
  reach `HAND_COMPLETE` (`end_hand` and `poc_join` removed). Every action is
  logged publicly in `HandLog`; `cf-verify` replays it on the rebuilt deck.
  Program 651 KB. Devnet probes migrated but not yet run (needs a deploy;
  done in CF-025).
- 2026-11-19 — PM signed off rules v1 (CF-014). P4 complete. P5 planned as
  CF-020…CF-025.
- 2026-11-18 — Agave 4.0.3 installed separately for the local stack (pins
  untouched). Local commits still fail with the same deserialize error, so
  the earlier "3.1 vs 4.0 mismatch" explanation was wrong; cause unknown.
  Docs corrected; question added for MagicBlock.
- 2026-11-18 — User signed off G3 as GO (conditional) and approved a separate
  Agave 4.x for the local stack only (no pin change). P4 started:
  `teen-patti-core` (no_std) with hand ranking (exact category counts over
  all 22,100 hands, A-2-3 second), blind/seen betting, See, Pack, Show, Side
  Show, timeouts, chaal and pot limits, rake and split pots; random-play
  conservation over 20,000 hands. Rules spec with a sign-off checklist.
- 2026-11-18 — CF-013 done. Security fixes: validator pinned to MagicBlock's
  TEE validator; refunds are pull-based per seat (claim_refund); min buy-in
  >= rent minimum. Devnet outage drill 20/20. Local restart drill: delegated
  + ephemeral state and permissions survive a validator restart and the hand
  continues without redeal; local commits fail because Agave 3.1.10 can't
  parse MagicBlock 1.1.1 (solana 4.0) transactions (control run too).
  G3: recommended GO (conditional) — PM to sign off.
- 2026-11-18 — CF-013 steps 1–3: ADR 0004 recovery policy; buy_in into a
  never-delegated TableVault with SeatLedgers; commit_hand / sync_hand
  (delegation-record checked, stacks only between hands); emergency_refund.
  Devnet drill 19/19: hand dealt, PER silent, bystander refunded every
  wallet exactly after 68.6 s; late commit couldn't move money; no redeal.
- 2026-11-18 — Security fix: ephemeral accounts stay frozen until the hand is
  revealed (HAND_COMPLETE added to in-progress), so a hand can't be made
  unverifiable by closing salts before the reveal. Test deck uses POC_DONE.
  Devnet: hand flow 52/52, privacy 231/231, six-player pass.
- 2026-11-18 — Security fix: reveal only after the hand is complete
  (`HAND_COMPLETE`, set by interim authority-only `end_hand`; P5 replaces it
  with showdown). Hands/salts/dealer can't be closed during play. Devnet:
  hand flow 51/51, privacy suite 231/231, six-player pass.
- 2026-11-18 — CF-012 done, **P2 complete, G2 passed** (one location).
  HandLog (public, delegated, committed) + reveal_hand; offline `cf-verify`
  CLI. Devnet: revealed hand verifies VALID from PER and from the Solana
  base-layer copy; tampered salt INVALID. 10,000 random hands VALID with
  every tamper caught (`pnpm check:g2`, in CI). Security fixes: VRF queue
  pinned to the ephemeral queue; large accounts boxed (stack limit).
- 2026-11-18 — CF-011 done. `deal_hand` shuffles, deals and commits on-chain
  from the private seed; each SeatHand carries its own Merkle proofs; Devnet
  39/39 in 2 runs (all 18 cards verified in JS against the public root).
  Security fixes: salts re-checked against commitments in the VRF callback,
  ephemeral accounts frozen mid-hand, `cancel_hand` after a VRF timeout with
  hand-number-bound callbacks. Program slimmed 664→470 KB (probe scaffolding
  removed, size-optimized build); resumable `pnpm deploy:devnet`.
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
