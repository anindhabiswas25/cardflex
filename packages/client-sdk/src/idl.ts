// The program's Anchor IDL (copied from target/idl by `pnpm sync-idl`; a test
// checks the copy matches the build).
import raw from "./card_flex.json" with { type: "json" };

export type IdlAccountItem = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string };
export type IdlInstruction = { name: string; discriminator: number[]; accounts: IdlAccountItem[]; args: { name: string; type: unknown }[] };
export type IdlTypeDef = { name: string; type: { kind: string; fields?: unknown[] } };
export type Idl = {
  address: string;
  instructions: IdlInstruction[];
  accounts: { name: string; discriminator: number[] }[];
  errors: { code: number; name: string; msg?: string }[];
  types: IdlTypeDef[];
};

export const idl = raw as unknown as Idl;
