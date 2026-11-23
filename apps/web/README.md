# Card Flex web app (P7)

The player app: landing page, the three boards (Tables), live table, verify
page, dashboard, rules. Next.js 16,
everything read from and sent to Solana devnet and MagicBlock's PER. No mock
data anywhere.

## Run it locally (the full stack)

On the dev machine everything is configured in `~/.config/cardflex/devnet.env`:

```bash
pnpm stack                 # keeper + API + web on :3000; Ctrl-C stops all three
pnpm e2e 2p                # browser tests with the saved wallets (2p | 3p | wallet | refund)
```

By hand:

```bash
pnpm install --frozen-lockfile
# 1. the keeper drives the tables (named on each table with `cf-admin table keeper`)
CARDFLEX_KEEPER_KEY=~/.config/cardflex/keeper.json \
CARDFLEX_TABLES=<config>,<config>,… CARDFLEX_DB=./cardflex.db HEALTH_PORT=9464 pnpm keeper
# 2. the indexer API (hand history; optional, pages degrade without it)
CARDFLEX_DB=./cardflex.db pnpm api
# 3. the app
pnpm web            # http://localhost:3000
```

Env (all public endpoints, no secrets): `NEXT_PUBLIC_BASE_RPC`,
`NEXT_PUBLIC_PER_RPC` (default MagicBlock devnet), `NEXT_PUBLIC_API_URL`
(default `http://127.0.0.1:4000`).

## What each page does

| Page | Reads | Sends |
| --- | --- | --- |
| `/` | landing page (`components/CardFlexLanding.tsx`, art in `public/landing/`); wallet balance only once connected | — |
| `/tables` | `lobby.json` + every listed table's TableConfig and last committed runtime (base layer) | — |
| `/table/<config>` | base layer for everyone; seated players read the LIVE runtime and their own SeatHand in the PER with their session key | buy-in, cash-out, refund claim (wallet); salts, moves, leave (session key, no pop-ups); resume seat = `rotate_session` (wallet, in PER) |
| `/verify/<config>/<hand>` | hand record from the API, else the table's public hand log | — (runs `cf-verify` as WASM in the browser) |
| `/dashboard` | the wallet's seat ledgers on every table (base layer), history from the API | cash-out, refund claim |

- **Wallets:** any Wallet Standard wallet (Phantom, Solflare, Backpack, …,
  set to Devnet), discovered without extra packages (`lib/wallet.tsx`), and a
  "Devnet test wallet" whose key lives in this browser (Devnet only).
- **Session keys** live only in the tab's `sessionStorage` (findings CF-003).
  Another tab or device resumes the seat with "Resume my seat"
  (`rotate_session`, signed by the wallet; the old key stops working).
- **TEE check:** every visit runs our own attestation check (`verifyTee`:
  pinned measurements, TCB UpToDate). Buy-ins are blocked if it fails.
- **Fairness:** when a hand is revealed the table page rebuilds the deck
  with the WASM verifier, shows the showdown hands and a "verified in your
  browser" badge.

## Adding a table to the lobby

```bash
pnpm admin -- table create --boot 1000000 --rake-bps 250 --rake-cap 20000000
pnpm admin -- table keeper <config> <keeper pubkey>    # before opening
pnpm admin -- table open <config>                      # funds the runtime reserve, delegates, opens
```

Then add `{ "config", "name", "tier", "tone", "board" }` to `lobby.json`.
`board` picks the themed room: `amethyst` (entry), `emerald` (premium) or
`ruby` (high roller); its art is `public/boards/<board>-*.webp` and
`public/cards/back-<board>.webp`. The Tables page shows one table per board;
a table without a board is drawn as Amethyst. Names and colours are
display-only; boot, buy-in, seats and players are read on chain.

## Tested

Driven in headless Chrome against Devnet through the real UI (two players;
three players with a Side Show; a Wallet Standard wallet; phone width): buy-in,
seat, salts, deal, own cards, See, chaal, Side Show with private views, Show,
result verified in the browser, verify page VALID, leave, cash-out, resume a
seat in a new browser, dashboard history. `pnpm check:web` typechecks it
(part of `pnpm verify`).

The browser tests are in `e2e/` (Chrome DevTools Protocol, no test
dependencies). With the stack running and funded Devnet keypairs
`player-a.json`, `player-b.json`, `player-c.json` in a folder outside the repo:

```bash
E2E_KEYS=~/cf-e2e-keys TABLE=<config> pnpm --filter @card-flex/web e2e:2p   # or e2e:3p, e2e:wallet
```

Each run needs ~0.025 devnet SOL per player (buy-in at the minimum + seat
ledger rent) and cashes out at the end. Screenshots go to `E2E_OUT`
(default: the keys folder).
