// Constants used by the instruction builders.
import { PublicKey } from "@solana/web3.js";
export { ACTION, PERMISSION_PROGRAM_ID, PROGRAM_ID, VRF_EPHEMERAL_QUEUE, VRF_PROGRAM_ID } from "./constants.ts";

export const MAGIC_PROGRAMS = {
  magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"),
  magicContext: new PublicKey("MagicContext1111111111111111111111111111111"),
  ephemeralVault: new PublicKey("MagicVau1t999999999999999999999999999999999"),
};
