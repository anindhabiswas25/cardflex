// CF-057: paying for commits.
//
// MagicBlock lets an account be committed only 10 times by a payer that isn't
// delegated; from the 11th commit on, commit_hand failed on Devnet with custom
// error 0xA0000000, so a table stopped saving to Solana after ~10 hands.
// Funding and delegating an escrow ("ephemeral balance") for the keeper did
// NOT help (the escrow was never charged). What works: pass the validator's
// fee vault; the program then makes the table's own delegated runtime PDA the
// payer (signed with its seeds). Devnet: 13 of 13 commits landed and the
// runtime's balance did not change (no fee charged on Devnet today).
import { PublicKey } from "@solana/web3.js";
import { DELEGATION_PROGRAM_ID, TEE_VALIDATOR } from "./constants.ts";

/** MagicBlock's fee vault for a validator (default: the TEE validator). Pass it to commit_hand / undelegate_table. */
export const magicFeeVault = (validator: PublicKey = TEE_VALIDATOR) =>
  PublicKey.findProgramAddressSync([Buffer.from("magic-fee-vault"), validator.toBuffer()], DELEGATION_PROGRAM_ID)[0];
