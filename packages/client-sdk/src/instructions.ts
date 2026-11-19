// Instruction builders from the IDL: account order, signer/writable flags,
// fixed addresses and argument encoding all come from the program itself.
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { encode, type IdlType } from "./borsh.ts";
import { ACTION, MAGIC_PROGRAMS, PERMISSION_PROGRAM_ID, PROGRAM_ID, VRF_EPHEMERAL_QUEUE, VRF_PROGRAM_ID } from "./exports-constants.ts";
import { idl } from "./idl.ts";
import { permissionPda, tableAddresses, vrfIdentityPda } from "./pda.ts";

const IX = new Map(idl.instructions.map((i) => [i.name, i]));
export const instructionNames = () => [...IX.keys()];

export type Accounts = Record<string, PublicKey | null | undefined>;

/**
 * Builds any program instruction by name. Accounts are given by their IDL
 * (snake_case) names; accounts with a fixed address may be omitted; optional
 * accounts may be null (passed as the program id, Anchor's convention).
 */
export function buildIx(name: string, accounts: Accounts, args: Record<string, unknown> = {}, remaining: AccountMeta[] = []): TransactionInstruction {
  const def = IX.get(name);
  if (!def) throw new Error(`unknown instruction ${name}`);
  const keys: AccountMeta[] = def.accounts.map((a) => {
    let key = accounts[a.name];
    if (key === undefined && a.address) key = new PublicKey(a.address);
    if (key === undefined || key === null) {
      if (a.optional) return { pubkey: PROGRAM_ID, isSigner: false, isWritable: false };
      throw new Error(`${name}: missing account ${a.name}`);
    }
    return { pubkey: key, isSigner: !!a.signer, isWritable: !!a.writable };
  });
  const out: number[] = [...def.discriminator];
  for (const arg of def.args) {
    if (!(arg.name in args)) throw new Error(`${name}: missing argument ${arg.name}`);
    encode(arg.type as IdlType, args[arg.name], out);
  }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [...keys, ...remaining], data: Buffer.from(out) });
}

const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const rw = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });

// ---- player instructions ----

/** Base layer, wallet signs: lamports to the vault, a SeatLedger with the session key. */
export function buyIn(p: { wallet: PublicKey; config: PublicKey; seat: number; amount: bigint; sessionKey: PublicKey }) {
  const t = tableAddresses(p.config);
  return buildIx("buy_in", { wallet: p.wallet, config: p.config, vault: t.vault, ledger: t.ledger(p.seat), global: globalAddr() }, { seat: p.seat, amount: p.amount, session_key: p.sessionKey });
}

/** Seats a bought-in ledger. `live` = the table is in PER with permissions (then the reader lists are updated). */
export function joinSeat(p: { payer: PublicKey; config: PublicKey; seat: number; live: boolean }) {
  const t = tableAddresses(p.config);
  const per = p.live
    ? { hand: t.seatHand(p.seat), hand_permission: permissionPda(t.seatHand(p.seat)), runtime_permission: permissionPda(t.runtime), permission_program: PERMISSION_PROGRAM_ID, ephemeral_vault: MAGIC_PROGRAMS.ephemeralVault, magic_program: MAGIC_PROGRAMS.magicProgram }
    : { hand: null, hand_permission: null, runtime_permission: null, permission_program: null, ephemeral_vault: null, magic_program: null };
  return buildIx("join_seat", { payer: p.payer, runtime: t.runtime, ledger: t.ledger(p.seat), ...per }, { seat: p.seat });
}

/** PER, session key signs. `dealingOrder` = the dealt seats (runtime.game.order[..n]). */
export function act(p: { session: PublicKey; config: PublicKey; action: number; amount: bigint; expectedSeq: bigint; dealingOrder: number[] }) {
  const t = tableAddresses(p.config);
  return buildIx("act", { session: p.session, runtime: t.runtime, hand_log: t.handLog }, { action: p.action, amount: p.amount, expected_seq: p.expectedSeq }, p.dealingOrder.map((s) => ro(t.seatHand(s))));
}
export { ACTION };

/** PER: a dealt seat's session key submits its secret salt for this hand. */
export function submitSalt(p: { session: PublicKey; config: PublicKey; seat: number; salt: Uint8Array }) {
  const t = tableAddresses(p.config);
  return buildIx("submit_salt", { session: p.session, runtime: t.runtime, salt: t.salt(p.seat) }, { seat: p.seat, salt: Array.from(p.salt) });
}

/** PER: the seat's session key or wallet asks to leave (applied between hands). */
export function leaveSeat(p: { signer: PublicKey; config: PublicKey; seat: number }) {
  return buildIx("leave_seat", { signer: p.signer, runtime: tableAddresses(p.config).runtime }, { seat: p.seat });
}

/** Base: pays a left ledger to its recorded wallet (anyone may submit). */
export function cashOut(p: { payer: PublicKey; config: PublicKey; seat: number; wallet: PublicKey }) {
  const t = tableAddresses(p.config);
  return buildIx("cash_out", { payer: p.payer, config: p.config, vault: t.vault, ledger: t.ledger(p.seat), wallet: p.wallet }, { seat: p.seat });
}

/** Base, after an emergency refund: pays the seat's synced stack to its wallet. */
export function claimRefund(p: { payer: PublicKey; config: PublicKey; seat: number; wallet: PublicKey }) {
  const t = tableAddresses(p.config);
  return buildIx("claim_refund", { payer: p.payer, config: p.config, vault: t.vault, ledger: t.ledger(p.seat), wallet: p.wallet });
}

// ---- keeper instructions (permissionless) ----

/** Anyone (CF-050): starts the salt round for the next hand. */
export function startHand(p: { payer: PublicKey; config: PublicKey }) {
  return buildIx("start_hand", { payer: p.payer, config: p.config, runtime: tableAddresses(p.config).runtime });
}

/** Anyone, after runtime.salts_deadline: ends a stalled salt round; non-submitters leave. */
export const cancelSalts = (p: { payer: PublicKey; config: PublicKey }) => buildIx("cancel_salts", { payer: p.payer, runtime: tableAddresses(p.config).runtime });

/** Anyone, after VRF_TIMEOUT_SLOTS without a VRF callback. */
export const cancelHand = (p: { payer: PublicKey; config: PublicKey }) => buildIx("cancel_hand", { payer: p.payer, runtime: tableAddresses(p.config).runtime });

export function requestShuffle(p: { payer: PublicKey; config: PublicKey }) {
  const t = tableAddresses(p.config);
  return buildIx("request_shuffle", { payer: p.payer, runtime: t.runtime, dealer: t.dealer, oracle_queue: VRF_EPHEMERAL_QUEUE, program_identity: vrfIdentityPda(), vrf_program: VRF_PROGRAM_ID });
}

export function dealHand(p: { payer: PublicKey; config: PublicKey; dealingOrder: number[] }) {
  const t = tableAddresses(p.config);
  return buildIx("deal_hand", { payer: p.payer, runtime: t.runtime, dealer: t.dealer }, {}, p.dealingOrder.map((s) => rw(t.seatHand(s))));
}

export function timeoutTurn(p: { payer: PublicKey; config: PublicKey; expectedSeq: bigint; dealingOrder: number[] }) {
  const t = tableAddresses(p.config);
  return buildIx("timeout_turn", { payer: p.payer, runtime: t.runtime, hand_log: t.handLog }, { expected_seq: p.expectedSeq }, p.dealingOrder.map((s) => ro(t.seatHand(s))));
}

export function revealHand(p: { payer: PublicKey; config: PublicKey; dealingOrder: number[] }) {
  const t = tableAddresses(p.config);
  return buildIx("reveal_hand", { payer: p.payer, runtime: t.runtime, dealer: t.dealer, hand_log: t.handLog }, {}, p.dealingOrder.map((s) => ro(t.salt(s))));
}

export function sideShowView(p: { payer: PublicKey; config: PublicKey; seatA: number; seatB: number; grant: boolean }) {
  const t = tableAddresses(p.config);
  return buildIx("side_show_view", {
    payer: p.payer, runtime: t.runtime,
    hand_a: t.seatHand(p.seatA), permission_a: permissionPda(t.seatHand(p.seatA)),
    hand_b: t.seatHand(p.seatB), permission_b: permissionPda(t.seatHand(p.seatB)),
  }, { seat_a: p.seatA, seat_b: p.seatB, grant: p.grant });
}

/** CF-053: ends a hand whose ephemeral state was lost (permissionless; fails with NotLost otherwise). */
export function abortLostHand(p: { payer: PublicKey; config: PublicKey; dealingOrder: number[] }) {
  const t = tableAddresses(p.config);
  const rest = [ro(t.dealer), ...p.dealingOrder.map((s) => ro(t.seatHand(s))), ...p.dealingOrder.map((s) => ro(t.salt(s)))];
  return buildIx("abort_lost_hand", { payer: p.payer, runtime: t.runtime }, {}, rest);
}

export const nextHand = (p: { payer: PublicKey; config: PublicKey }) => buildIx("next_hand", { payer: p.payer, runtime: tableAddresses(p.config).runtime });

export function commitHand(p: { payer: PublicKey; config: PublicKey }) {
  const t = tableAddresses(p.config);
  return buildIx("commit_hand", { payer: p.payer, runtime: t.runtime, hand_log: t.handLog, magic_program: MAGIC_PROGRAMS.magicProgram, magic_context: MAGIC_PROGRAMS.magicContext });
}

/** Base: ledgers of every bought-in seat (TableConfig.seated), in seat order. */
export function syncHand(p: { config: PublicKey; delegationRecord: PublicKey; seated: number }) {
  const t = tableAddresses(p.config);
  const ledgers = [0, 1, 2, 3, 4, 5].filter((s) => (p.seated >> s) & 1).map((s) => rw(t.ledger(s)));
  return buildIx("sync_hand", { config: p.config, runtime: t.runtime, delegation_record: p.delegationRecord }, {}, ledgers);
}

function globalAddr() {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode("global")], PROGRAM_ID)[0];
}
