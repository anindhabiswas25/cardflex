// Program, MagicBlock and endpoint constants. MagicBlock IDs: PRD §5.1.2, ADR 0001.
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("4XUaBSuszDH8zUs3gMGgiBC7nckLnmhgubsXXvDL3vdL");
/** The only validator a table may be delegated to (MagicBlock's TEE). */
export const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
export const DELEGATION_PROGRAM_ID = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const PERMISSION_PROGRAM_ID = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
/** The VRF queue that works inside PER (the base queue does not). */
export const VRF_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const ENDPOINTS = {
  devnet: {
    base: "https://rpc.magicblock.app/devnet",
    per: "https://devnet-tee.magicblock.app",
  },
} as const;

export const SEEDS = {
  global: "global",
  table: "table",
  runtime: "table-runtime",
  vault: "table-vault",
  ledger: "seat-ledger",
  handLog: "hand-log",
  dealer: "dealer",
  seatHand: "seat-hand",
  salt: "salt",
  identity: "identity",
  permission: "permission:",
} as const;

export const MAX_SEATS = 6;
export const TURN_SECS = 25;
/** table.rs SALT_SECS: `start_hand` sets salts_deadline = start + SALT_SECS. */
export const SALT_SECS = 30;
/** CF-079 (table.rs LEAVE_WINDOW_SECS): no deal, so no boot, sooner than this after a hand starts. */
export const LEAVE_WINDOW_SECS = 5;
export const RULES_VERSION = 1;
/**
 * CF-084 (ADR 0007, table.rs): MagicBlock commits the first FREE_COMMITS of a
 * delegation for free. A session plays hands until SESSION_HAND_COMMITS are
 * used, then `end_session` seats everyone out (one commit) and the table is
 * closed (one commit) and reopened: a new session.
 */
export const FREE_COMMITS = 25;
export const SESSION_HAND_COMMITS = FREE_COMMITS - 2;
export const SESSION_COMMIT_LIMIT = FREE_COMMITS - 1;
/** Commits used in the runtime's current session (delegation). */
export const sessionCommits = (rt: { commit_seq: bigint; session_base_seq: bigint }) =>
  rt.commit_seq > rt.session_base_seq ? Number(rt.commit_seq - rt.session_base_seq) : 0;

/** TableRuntime.phase values (programs/card-flex/src/table.rs). */
export const PHASE = {
  IDLE: 0,
  SALTS_PENDING: 1,
  SALTS_DONE: 2,
  VRF_PENDING: 3,
  SEEDED: 4,
  DEALT: 5,
  HAND_COMPLETE: 6,
  REVEALED: 7,
  POC_DONE: 8,
} as const;

/** TableConfig.status values. */
export const TABLE_STATUS = { ACTIVE: 1, REFUNDED: 2 } as const;

/** `act` action codes. */
export const ACTION = { SEE: 0, CHAAL: 1, PACK: 2, SHOW: 3, SIDE_SHOW: 4, SIDE_SHOW_RESPOND: 5 } as const;
