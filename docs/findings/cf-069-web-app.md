# CF-069: the player web app, wired end to end

**Date:** 2026-11-20 · **From:** `dev-machine-1` · **App:** `apps/web`
(README there) · **Network:** Solana devnet + MagicBlock devnet PER

The P7 UI previews (mock lobby, local game engine, fake wallet, preview
verify page, static dashboard) are replaced by the real thing: every page
reads Solana and the PER, and every action is a real transaction. See
`apps/web/README.md` for what each page reads and sends.

## End-to-end tests (headless Chrome, real UI, real Devnet)

Driven over the Chrome DevTools Protocol from Node (no test dependencies),
each player in its own browser context with its own wallet:

| Run | Result |
| --- | --- |
| Two players: TEE check, buy-in, seated, salts, deal, own cards, See, chaal, Show, result verified in the browser, revealed cards for both, verify page VALID (indexer), leave, cash-out, dashboard history | 13/13 |
| Two players arriving with seats whose session keys were lost (new browser): "Resume my seat" (`rotate_session` signed by the wallet in PER) | pass |
| Three players: Side Show asked and accepted, both players privately see each other's cards, Show, result cards stay up until the next deal, three cash-outs | 7/7 |
| A Wallet Standard wallet (mock, Ed25519 via WebCrypto, same interface as Phantom): discovered, connected, buy-in and cash-out signed by it, no wallet prompts while seated, leave → cash-out in 11 s | 6/6 |
| Phone width (390 px): lobby, table, dashboard, verify | no horizontal overflow, no console errors |

No console errors or exceptions in any run.

## Bugs the UI tests found (all fixed)

1. **Keeper: a returning player's departure waited for the heartbeat.**
   `departedSynced` remembered seats it had synced as departed and never
   forgot them, so when a new player later left the same seat the keeper
   thought it was already synced: cash-out waited ~4 minutes (until the
   300 s heartbeat). Now the keeper forgets bits that are no longer
   departed. Leave → cash-out: 4 min → 11 s.
2. **API indexer failed every pass on Devnet.** It read all ~300 runtimes
   with one `getMultipleAccountsInfo` (limit 100). Now batched; tables of
   older layouts are counted (`oldLayout`), not logged as errors.
3. **A busy table stopped committing: runtime headroom.** A table's runtime
   pays for its PER accounts and is the commit payer (fee vault, CF-057).
   Opening a table left only ~15,000 lamports above rent; a table with
   player churn (reader lists grow) fell to 13,856 and every `commit_hand`
   then failed with `InsufficientFundsForRent` on the runtime, while tables
   at 14,912 still committed. Commits themselves didn't change the balance
   (no fee charged); MagicBlock appears to require a margin above rent of
   the payer. A base-layer transfer to a delegated runtime does NOT reach
   the PER (base 9,186,816 vs PER 7,186,816 after a 0.002 SOL top-up), so a
   live table can't be refuelled. Fix: `cf-admin table open` now funds a
   runtime reserve before delegating (`--runtime-reserve`, default
   0.005 SOL → ~5,000,000 lamports of headroom in PER), and the keeper's
   `/health` reports a table whose headroom is below 100,000 lamports
   (`cf-admin watch --keeper-url` turns that into `KEEPER_UNHEALTHY`). The
   stuck test table's players are paid by the refund path. **Ask
   MagicBlock:** the exact margin, and how to top up a delegated account's
   balance in the ER (needed before Mainnet).
4. **UI:** settled pot showed 0, revealed cards vanished when the next hand
   started, a seat race (two players buying the same seat) left the buyer
   on a stale view, the default buy-in could exceed the wallet, bet amounts
   showed "–" when it wasn't your turn. All fixed.

Also: Next 16 generated an `AGENTS.md` in `apps/web` (disabled with
`agentRules: false`).

## SDK additions

`rotateSession` (instruction builder), `perLoginWithSigner` (PER login for
any signer, e.g. a browser wallet's `signMessage`), `MAGIC_PROGRAMS` export,
`TableRuntime` type includes the CF-064/065 fields.
