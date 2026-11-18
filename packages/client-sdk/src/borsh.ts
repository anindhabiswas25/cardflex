// Minimal Borsh codec driven by the Anchor IDL (only the types the program uses).
import { PublicKey } from "@solana/web3.js";
import { idl } from "./idl.ts";

export type IdlType =
  | "bool" | "u8" | "u16" | "u32" | "u64" | "i64" | "pubkey"
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { option: IdlType }
  | { defined: { name: string } };

type Field = { name: string; type: IdlType };
const structs = new Map<string, Field[]>(
  idl.types.filter((t) => t.type.kind === "struct").map((t) => [t.name, (t.type as { fields?: Field[] }).fields ?? []]),
);

export function fieldsOf(name: string): Field[] {
  const f = structs.get(name);
  if (!f) throw new Error(`unknown IDL type ${name}`);
  return f;
}

/** Byte size of a fixed-size type (all program accounts are fixed size). */
export function sizeOf(t: IdlType): number {
  if (typeof t === "string") return { bool: 1, u8: 1, u16: 2, u32: 4, u64: 8, i64: 8, pubkey: 32 }[t];
  if ("array" in t) return sizeOf(t.array[0]) * t.array[1];
  if ("defined" in t) return fieldsOf(t.defined.name).reduce((n, f) => n + sizeOf(f.type), 0);
  throw new Error("variable-size type has no fixed size");
}

export function decode(t: IdlType, v: DataView, off: number): [unknown, number] {
  if (typeof t === "string") {
    switch (t) {
      case "bool": return [v.getUint8(off) !== 0, off + 1];
      case "u8": return [v.getUint8(off), off + 1];
      case "u16": return [v.getUint16(off, true), off + 2];
      case "u32": return [v.getUint32(off, true), off + 4];
      case "u64": return [v.getBigUint64(off, true), off + 8];
      case "i64": return [v.getBigInt64(off, true), off + 8];
      case "pubkey": return [new PublicKey(new Uint8Array(v.buffer, v.byteOffset + off, 32).slice()), off + 32];
    }
  }
  if ("array" in t) {
    const [inner, n] = t.array;
    // Byte blobs (hashes, salts: 32+ bytes) stay Uint8Array; short u8 lists
    // (seat indices, dealing order) are plain numbers, so .map works as expected.
    if (inner === "u8" && n >= 32) return [new Uint8Array(v.buffer, v.byteOffset + off, n).slice(), off + n];
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) { const [x, o] = decode(inner, v, off); out.push(x); off = o; }
    return [out, off];
  }
  if ("vec" in t) {
    const n = v.getUint32(off, true); off += 4;
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) { const [x, o] = decode(t.vec, v, off); out.push(x); off = o; }
    return [out, off];
  }
  if ("option" in t) {
    if (v.getUint8(off) === 0) return [null, off + 1];
    return decode(t.option, v, off + 1);
  }
  const obj: Record<string, unknown> = {};
  for (const f of fieldsOf(t.defined.name)) { const [x, o] = decode(f.type, v, off); obj[f.name] = x; off = o; }
  return [obj, off];
}

export function encode(t: IdlType, value: unknown, out: number[]): void {
  const push = (bytes: ArrayLike<number>) => { for (let i = 0; i < bytes.length; i++) out.push(bytes[i]); };
  if (typeof t === "string") {
    const b = new Uint8Array(8), dv = new DataView(b.buffer);
    switch (t) {
      case "bool": out.push(value ? 1 : 0); return;
      case "u8": out.push(Number(value) & 0xff); return;
      case "u16": dv.setUint16(0, Number(value), true); push(b.subarray(0, 2)); return;
      case "u32": dv.setUint32(0, Number(value), true); push(b.subarray(0, 4)); return;
      case "u64": dv.setBigUint64(0, BigInt(value as bigint), true); push(b); return;
      case "i64": dv.setBigInt64(0, BigInt(value as bigint), true); push(b); return;
      case "pubkey": push((value as PublicKey).toBytes()); return;
    }
  }
  if ("array" in t) {
    const arr = value as ArrayLike<unknown>;
    if (arr.length !== t.array[1]) throw new Error(`array length ${arr.length}, expected ${t.array[1]}`);
    for (let i = 0; i < arr.length; i++) encode(t.array[0], arr[i], out);
    return;
  }
  if ("vec" in t) {
    const arr = value as unknown[];
    encode("u32", arr.length, out);
    for (const x of arr) encode(t.vec, x, out);
    return;
  }
  if ("option" in t) {
    if (value === null || value === undefined) { out.push(0); return; }
    out.push(1); encode(t.option, value, out); return;
  }
  const obj = value as Record<string, unknown>;
  for (const f of fieldsOf(t.defined.name)) encode(f.type, obj[f.name], out);
}
