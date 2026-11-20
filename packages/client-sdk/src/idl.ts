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

/** The program error code for `name` (from the IDL). */
export function errorCode(name: string): number {
  const e = idl.errors.find((x) => x.name === name);
  if (!e) throw new Error(`no program error named ${name}`);
  return e.code;
}

/** True if a transaction error (object or message text) is the program error `name`. */
export function isProgramError(err: unknown, name: string): boolean {
  const code = errorCode(name);
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : JSON.stringify(err);
  return text.includes(`"Custom":${code}`) || text.includes(name) || text.includes(`0x${code.toString(16)}`);
}
