# CF-006 spike — ADR 0002 assumption A1 on Devnet PER

- **Date:** 2026-11-18
- **Status:** A1 holds in 4 of 4 Devnet runs from `dev-machine-1`. This is a
  spike: the full G1 probe suite (CF-007) with six wallets is still required.
- **Code:** `probe_secret_create`, `probe_secret_write` and `probe_secret_close`
  in `programs/card-flex`. The A1 section is in
  `packages/probes/src/roundtrip.mjs` (runs automatically with
  `--target tee`).
- **Raw data:** `docs/probes/*cf004-tee*.json`, runs from 11:41 UTC onwards.

## Question

Can an ephemeral-only account inside PER (never written to Solana) carry an
ephemeral permission that hides it from non-members? ADR 0002 puts
`DealerState`, `SaltAccount` and `SeatHand` in such accounts.

## What the spike does

1. The delegated probe account sponsors an ephemeral PDA
   `["secret", probe]` (40 bytes: tag + 32-byte secret), created with
   `EphemeralAccount::create`.
2. The program writes the secret, then creates an `EphemeralPermission`
   for it: `is_private = true`, one member = the authority with
   `TX_LOGS | TX_MESSAGE | TX_BALANCES`.
3. The secret is overwritten once (`probe_secret_write`).
4. The secret is read from three identities: the owner's token, a fresh
   stranger's token, and no token.
5. The permission and the ephemeral account are closed, then the probe is
   committed and undelegated.

## Results (all four runs identical except one WebSocket detail)

| Check | Result |
| --- | --- |
| Owner `getAccountInfo` | reads the current secret |
| Stranger token `getAccountInfo` / `getMultipleAccounts` | null |
| No token `getAccountInfo` / `getMultipleAccounts` | null |
| Stranger WebSocket `accountSubscribe` during a write | 0 notifications |
| Owner WebSocket `accountSubscribe` during a write | 1 notification in 3 runs, **0 in 1 run** |
| Secret account on Solana base layer (before and after undelegate) | absent |
| After close | gone inside PER too |
| Owner `getTransaction` of the secret-carrying tx | full transaction including the secret bytes |
| Stranger / no-token `getTransaction` | **redacted**: signature and success status only; no account keys, instructions, logs or balances |

## Conclusions

1. **A1 holds:** ephemeral-only accounts can be private. ADR 0002 stands
   and its fallback isn't needed so far.
2. **Transactions are redacted for non-members** (open question 2). A
   salt or card inside an instruction is not exposed to other players.
   What still leaks to anyone holding the signature is that the transaction
   exists, its success status and its timing. Treat that as public. A
   player's salt submission time is visible, but the salt itself isn't.
3. **Owner subscriptions to ephemeral accounts may miss updates:** one run
   in four delivered nothing to the owner. Clients must not rely only on
   WebSocket for their own hand: re-read with `getAccountInfo` after every
   deal, and on reconnect. CF-006 must reproduce and measure this with six
   wallets, and report it to MagicBlock if it persists.
4. A stranger's read returns null, the same as for an account that doesn't
   exist. That is fine for privacy, but the client and tests can't tell
   "denied" from "missing". Tests must always pair a stranger read with an
   owner read of the same account at the same moment.

## Not yet covered (CF-007)

Six simultaneous wallets; `getProgramAccounts`; `getSignaturesForAddress`;
a session token reused after a member is removed; permission updates
mid-hand (Side Show); unauthorized writes to an ephemeral account; logs and
errors containing secrets; behaviour after a PER restart.
