// Program-derived addresses (seeds from programs/card-flex/src/table.rs).
import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID, PROGRAM_ID, SEEDS, UPGRADEABLE_LOADER } from "./constants.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const find = (seeds: Uint8Array[], program = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
const u64le = (v: bigint | number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};

export const globalPda = () => find([enc(SEEDS.global)]);
export const tablePda = (authority: PublicKey, tableId: bigint | number) => find([enc(SEEDS.table), authority.toBytes(), u64le(tableId)]);
export const runtimePda = (config: PublicKey) => find([enc(SEEDS.runtime), config.toBytes()]);
export const vaultPda = (config: PublicKey) => find([enc(SEEDS.vault), config.toBytes()]);
export const ledgerPda = (config: PublicKey, seat: number) => find([enc(SEEDS.ledger), config.toBytes(), Uint8Array.of(seat)]);
export const handLogPda = (runtime: PublicKey) => find([enc(SEEDS.handLog), runtime.toBytes()]);
export const dealerPda = (runtime: PublicKey) => find([enc(SEEDS.dealer), runtime.toBytes()]);
export const seatHandPda = (runtime: PublicKey, seat: number) => find([enc(SEEDS.seatHand), runtime.toBytes(), Uint8Array.of(seat)]);
export const saltPda = (runtime: PublicKey, seat: number) => find([enc(SEEDS.salt), runtime.toBytes(), Uint8Array.of(seat)]);
export const vrfIdentityPda = () => find([enc(SEEDS.identity)]);
export const permissionPda = (account: PublicKey) => find([enc(SEEDS.permission), account.toBytes()], PERMISSION_PROGRAM_ID);
export const delegationRecordPda = (account: PublicKey) => find([enc("delegation"), account.toBytes()], DELEGATION_PROGRAM_ID);
export const programDataPda = () => find([PROGRAM_ID.toBytes()], UPGRADEABLE_LOADER);

/** Every address of one table, derived from its config address. */
export function tableAddresses(config: PublicKey) {
  const runtime = runtimePda(config);
  return {
    config,
    runtime,
    vault: vaultPda(config),
    handLog: handLogPda(runtime),
    dealer: dealerPda(runtime),
    ledger: (seat: number) => ledgerPda(config, seat),
    seatHand: (seat: number) => seatHandPda(runtime, seat),
    salt: (seat: number) => saltPda(runtime, seat),
  };
}
