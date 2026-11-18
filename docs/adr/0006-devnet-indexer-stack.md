# ADR 0006 — Devnet indexer and API stack

- **Status:** Accepted (P7, CF-018)
- **Date:** 2026-11-19
- **Amends:** PRD v1.2 §6 (backend NestJS + PostgreSQL + Redis), for Devnet only

## Context

The lobby, hand history and player records need an indexer and an API. The
PRD names NestJS, PostgreSQL and Redis. For Devnet that is three new pinned
dependencies and two services to run, for a workload of a few tables.

## Decision

- `services/api` is one Node 24 process: an indexer loop and an HTTP API.
- Storage: Node's built-in `node:sqlite` (one file). HTTP: `node:http`.
  TypeScript runs with Node's built-in type stripping. **No new dependencies**:
  it uses `@card-flex/client-sdk` and `@solana/web3.js` (already pinned).
- The indexer trusts nothing it reads: every revealed hand is rebuilt as a
  `cf-hand-record/2` and checked with the same verifier as `cf-verify`
  (WASM, CF-040). Hands that fail are stored and flagged, never hidden.
- The API is read-only. It never holds keys and never sends transactions
  (keeper and admin actions are separate, CF-041 / P8).

## Consequences

- Moving to PostgreSQL (and NestJS if wanted) before mainnet is a storage
  swap: the schema is plain SQL and the indexer core takes a `Store`
  interface.
- The hand log holds only the latest hand per table; the indexer polls the
  public `HandLog` in PER every few seconds. If two hands finish between two
  polls, the first is missed. Acceptable on Devnet; the keeper (P8) will
  hand each record to the indexer directly.
- A paid RPC is needed beyond a handful of tables (public RPCs rate-limit,
  findings CF-003).
