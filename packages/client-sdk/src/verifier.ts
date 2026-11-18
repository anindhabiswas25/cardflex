// cf-verify in the browser or Node (CF-040): the same Rust verifier as the
// CLI, compiled to WebAssembly (crates/fairness-wasm). It needs no imports.
//   const v = await loadVerifier(fetch("/cf_verify.wasm"));   // browser
//   const v = await loadVerifier(readFileSync(wasmPath));      // Node
//   const report = v.verify(handRecordJson);

export type VerifyCheck = { name: string; status: "VALID" | "INVALID" | "NOT PROVIDED"; detail: string };
export type VerifyReport = { overall: "VALID" | "INVALID"; checks: VerifyCheck[]; deck: number[] | null; error: string | null };

type Exports = {
  memory: WebAssembly.Memory;
  cf_alloc(len: number): number;
  cf_free(ptr: number, len: number): void;
  cf_verify(ptr: number, len: number): bigint;
};

export type Verifier = { verify(record: string | object): VerifyReport };

export async function loadVerifier(source: BufferSource | Response | Promise<Response>): Promise<Verifier> {
  const res = await source;
  const instance =
    res instanceof Response
      ? (await WebAssembly.instantiateStreaming(res, {})).instance
      : (await WebAssembly.instantiate(res as BufferSource, {})).instance;
  const x = instance.exports as unknown as Exports;
  return {
    verify(record) {
      const input = new TextEncoder().encode(typeof record === "string" ? record : JSON.stringify(record));
      const ptr = x.cf_alloc(input.length);
      new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
      const packed = x.cf_verify(ptr, input.length);
      x.cf_free(ptr, input.length);
      const outPtr = Number(packed >> 32n), outLen = Number(packed & 0xffffffffn);
      const out = new TextDecoder().decode(new Uint8Array(x.memory.buffer, outPtr, outLen));
      x.cf_free(outPtr, outLen);
      return JSON.parse(out) as VerifyReport;
    },
  };
}

/** Path of the bundled module, for Node (`readFileSync(verifierWasmUrl)`). */
export const verifierWasmUrl = new URL("../wasm/cf_verify.wasm", import.meta.url);
