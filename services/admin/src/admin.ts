// Admin operations (CF-041) as pure instruction builders, so they can be
// tested offline and reviewed (or proposed to a multisig) before signing.
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationMetadataPdaFromDelegatedAccount, delegationRecordPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { MAX_SEATS, PROGRAM_ID, TEE_VALIDATOR, buildIx, commitHand, globalPda, permissionPda, programDataPda, tableAddresses, tablePda, vaultPda } from "@card-flex/client-sdk";

export function updateGlobal(authority: PublicKey, p: { treasury: PublicKey; maxRakeBps: number; paused: boolean }) {
  return buildIx("update_global", { authority, global: globalPda() }, { treasury: p.treasury, max_rake_bps: p.maxRakeBps, paused: p.paused });
}

/**
 * CF-055: makes the program's current upgrade authority the settings
 * authority. Signed by that key (e.g. proposed to the Squads multisig after
 * `solana program set-upgrade-authority`, CF-056).
 */
export function syncGlobalAuthority(upgradeAuthority: PublicKey) {
  return buildIx("sync_global_authority", { authority: upgradeAuthority, global: globalPda(), program: PROGRAM_ID, program_data: programDataPda() });
}

/** create_table + configure_table (base). Buy-in becomes 40–200 boots (rules v1 §6). */
export function createTable(authority: PublicKey, p: { tableId: bigint; seats: number; boot: bigint; rakeBps: number; rakeCap: bigint; refundTimeoutSecs: number }) {
  const config = tablePda(authority, p.tableId);
  const t = tableAddresses(config);
  const ixs = [
    buildIx("create_table", { config, runtime: t.runtime, hand_log: t.handLog, vault: t.vault, authority, global: globalPda() }, { table_id: p.tableId, max_seats: p.seats }),
    buildIx("configure_table", { authority, config, runtime: t.runtime, global: globalPda() }, { boot: p.boot, rake_bps: p.rakeBps, rake_cap: p.rakeCap, refund_timeout_secs: p.refundTimeoutSecs }),
  ];
  return { config, ixs };
}

/** Base: hands the runtime and hand log to MagicBlock's TEE validator. */
export function delegateTable(authority: PublicKey, config: PublicKey): TransactionInstruction {
  const t = tableAddresses(config);
  return buildIx("delegate_table", {
    authority, config,
    buffer_runtime: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(t.runtime, PROGRAM_ID),
    delegation_record_runtime: delegationRecordPdaFromDelegatedAccount(t.runtime),
    delegation_metadata_runtime: delegationMetadataPdaFromDelegatedAccount(t.runtime),
    runtime: t.runtime,
    buffer_hand_log: delegateBufferPdaFromDelegatedAccountAndOwnerProgram(t.handLog, PROGRAM_ID),
    delegation_record_hand_log: delegationRecordPdaFromDelegatedAccount(t.handLog),
    delegation_metadata_hand_log: delegationMetadataPdaFromDelegatedAccount(t.handLog),
    hand_log: t.handLog, validator: TEE_VALIDATOR, system_program: SystemProgram.programId,
  });
}

const per = (name: string, authority: PublicKey, runtime: PublicKey, target: PublicKey, args: Record<string, unknown> = {}) =>
  buildIx(name, { authority, runtime, target, permission: permissionPda(target) }, args);

/** PER: permissions, dealer, and a seat hand + salt for EVERY seat (empty seats too, ADR 0005). */
export function openTablePer(authority: PublicKey, config: PublicKey, maxSeats: number = MAX_SEATS): TransactionInstruction[] {
  const t = tableAddresses(config);
  const ixs = [
    per("open_runtime_permission", authority, t.runtime, t.runtime),
    per("open_hand_log_permission", authority, t.runtime, t.handLog),
    per("open_dealer", authority, t.runtime, t.dealer),
  ];
  for (let s = 0; s < maxSeats; s++) {
    ixs.push(per("open_seat_hand", authority, t.runtime, t.seatHand(s), { seat: s }));
    ixs.push(per("open_salt", authority, t.runtime, t.salt(s), { seat: s }));
  }
  return ixs;
}

/**
 * PER: closes every ephemeral account, commits, then gives the table back to
 * the base layer. The commit matters: undelegate_table doesn't bump
 * commit_seq, so without it sync_hand would refuse the final state and a
 * player who just left couldn't cash out (only refund) — found live, CF-041.
 */
export function closeTablePer(authority: PublicKey, config: PublicKey, maxSeats: number = MAX_SEATS, feeVault?: PublicKey): TransactionInstruction[] {
  const t = tableAddresses(config);
  const ixs: TransactionInstruction[] = [];
  for (let s = 0; s < maxSeats; s++) {
    ixs.push(per("close_ephemeral", authority, t.runtime, t.seatHand(s), { seat: s }));
    ixs.push(per("close_salt", authority, t.runtime, t.salt(s), { seat: s }));
  }
  ixs.push(per("close_ephemeral", authority, t.runtime, t.dealer, { seat: null }));
  // CF-057: pass magicFeeVault() so the runtime pays; without it a table that
  // already had 10 commits can't be committed or closed.
  ixs.push(commitHand({ payer: authority, config, feeVault }));
  ixs.push(buildIx("undelegate_table", { authority, runtime: t.runtime, hand_log: t.handLog, magic_fee_vault: feeVault ?? null }));
  return ixs;
}

export function sweepRake(payer: PublicKey, config: PublicKey, treasury: PublicKey) {
  return buildIx("sweep_rake", { payer, config, vault: vaultPda(config), global: globalPda(), treasury });
}

/** Read-only reconciliation (simulate it): ledgers of every seated seat, in seat order. */
export function checkVault(config: PublicKey, seated: number, strict: boolean) {
  const t = tableAddresses(config);
  const ledgers = [0, 1, 2, 3, 4, 5].filter((s) => (seated >> s) & 1).map((s) => ({ pubkey: t.ledger(s), isSigner: false, isWritable: false }));
  return buildIx("check_vault", { config, vault: t.vault }, { strict }, ledgers);
}
