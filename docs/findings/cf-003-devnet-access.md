# CF-003 findings — Devnet access, latency and TEE attestation

- **Date:** 2026-11-18
- **Status:** One location measured (`dev-machine-1`). Every target region still
  has to run the probe (see "How to add a region").
- **Raw data:** `docs/probes/*.json`
- **Probe:** `packages/probes/src/probe.mjs`

## Summary

From the first location, MagicBlock's Devnet PER answers reads in 77 ms at
p50 (84 ms p95). It produces a slot about every 10 ms, its Intel TDX
attestation verifies with TCB status `UpToDate`, and the PER login works.
Nothing was blocked. Three security gaps in MagicBlock's client tooling
change how we build the client (see "Decisions this forces").

## Results — `dev-machine-1` (2026-11-18, 30 samples per method)

| Endpoint | Reachable | getSlot p50 / p95 ms | getLatestBlockhash p50 / p95 ms | WS first slot msg ms | Slot interval p50 ms |
| --- | --- | --- | --- | --- | --- |
| PER `devnet-tee.magicblock.app` | yes (with and without token) | 76.8 / 83.6 | 77.5 / 85.0 | 151 | 10.1 |
| ER Asia `devnet-as` | yes | 76.6 / 84.3 | 76.3 / 86.6 | 157 | 9.9 |
| ER Europe `devnet-eu` | yes | 187.8 / 207.4 | 185.8 / 226.9 | 354 | 9.9 |
| ER US `devnet-us` | yes | 260.1 / 269.4 | 260.6 / 268.8 | 521 | 9.2 |
| Router `devnet-router` | yes | n/a (not served) | 91.3 / 341.0 | n/a | — |
| Solana devnet via `rpc.magicblock.app/devnet` | yes | 118.7 / 443.9 | 102.2 / 131.3 | 461 | 200.5 |
| Solana devnet public RPC | yes, rate-limited (HTTP 429) | 84.0 / 122.9 | 236.1 / 658.3 | 400 | 200.3 |

`dev-machine-1` is the developer machine CF-001 ran on; its physical location
isn't recorded. The PER's latency matches the Asia ER almost exactly, so it
is likely hosted near it. That is an inference, not something MagicBlock
has stated.

These are **read** latencies. The time to confirm a game action (a write)
needs a delegated account and is measured in CF-004.

## Versions seen

- PER (`devnet-tee`) runs `magicblock-core 1.1.1`, which is the same
  version as our pinned local validator (ADR 0001).
- `devnet-as` and `devnet-eu` also run 1.1.1. `devnet-us` already runs
  `core 2.0.0`, so MagicBlock is rolling out 2.0 region by region. Track this
  before we move our pins.

## TEE attestation

| Check | Result |
| --- | --- |
| SDK `verifyTeeRpcIntegrity` | passed (1.1–1.9 s) |
| Our own check (CSPRNG challenge, collateral from Phala PCCS) | passed |
| TCB status | `UpToDate`, no advisories |
| `reportData` equals our challenge | yes |
| MRTD (same in both runs) | `c1ee9c16e3afc506cfe042c5b846a368528f3b37618eafb27469bc114cf914e9222c91618470e7f2b28ac360968270a5` |
| RTMR0 | `c1f1f2bff33b16d1469134987fcdf0ea3bd9707350cc70e73f086c635a5fc4e96e0d214a7f775608e64d251382f20564` |
| RTMR1 | `5a5e062f119b848c291cb75630504c185d8646799be42ad5941566efde1643d0e1029c34b7011d865e389980e9ef6a00` |
| RTMR2 | `b90b887df3fa1fe071052ddd250f4d5175066b3182394942162ec92e62e1649fbdc20b3bc65fe2f4b473a48602ef3073` |
| RTMR3 | all zeros |

### Gaps in the SDK's attestation check (`@magicblock-labs/ephemeral-rollups-sdk` 0.17.3, `lib/access-control/verify.js`)

1. **No measurement pinning.** It accepts any genuine TDX machine. A TDX VM
   running different software would also pass.
2. **TCB status is ignored.** It doesn't reject `OutOfDate` or `Revoked`
   platforms.
3. **The challenge uses `Math.random()`,** not a cryptographic random
   generator.
4. **The quote isn't bound to the connection.** A proxy could pass `/quote`
   through to a real TEE and serve everything else itself. The SDK doesn't
   tie the attested key to TLS or to responses.

## PER login (auth token)

| Item | Observed |
| --- | --- |
| Challenge | `GET /auth/challenge?pubkey=<pk>` returns `"Login to Query Filtering Service\nTimestamp: <unix>\nUser: <pk>"`. The Devnet PER uses the same query filtering service as the local stack |
| Login | `POST /auth/login {pubkey, challenge, signature(base58)}` returns `{token}` only, with no `expiresAt` |
| Token | HS256 JWT with claims `pubkey, iat, exp`. **Lifetime 720 hours (30 days)** |
| Replay | The same signed challenge can be posted again and returns a new token. A challenge timestamped 2 hours earlier was rejected (`Challenge expired`) |
| Without token | Public RPC methods (`getVersion`, `getSlot`) work without a token. Whether account reads need one is a G1 test |

This answers open question 4 in the delivery plan (token lifetime and
challenge format). There is no refresh endpoint; get a new token instead.

## Decisions this forces

1. **The client runs its own attestation check** (ticket CF-016), not only
   the SDK's:
   - use a CSPRNG challenge;
   - require TCB `UpToDate`;
   - compare MRTD and RTMR0–2 with an allow-list in config.

   Ask MagicBlock whether these values are published per release (open
   question 8). Until they answer, record the values we observe and alert
   when they change.
2. **The session key, not the wallet, is the `SeatHand` reader.** Because a
   token lasts 30 days and a signed login can be reused for a while, the
   identity that can read a hand must be the per-sit-down session key.
   Removing it from the permission list on stand-up makes any leaked token
   useless. This refines PRD §8.4.
3. **Keepers and the indexer need a paid Solana RPC.** The public devnet RPC
   returned HTTP 429 after a few requests.
4. **Clients send game actions straight to `devnet-tee`.** The router doesn't
   serve general RPC methods, so it isn't the client's game endpoint.

## How to add a region

```bash
pnpm install --frozen-lockfile
pnpm probe -- --region <country-city-network> --samples 30
```

This writes `docs/probes/<timestamp>-<region>.json`. Commit the file and add a
row to the table above. A region passes when it gets PER `getSlot` p95 under
150 ms and no endpoint is blocked. The PRD's 200 ms action target leaves the
rest of the budget for execution and the push to other players.
