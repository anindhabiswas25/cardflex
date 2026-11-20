"use client";
// Our own TEE attestation check (findings CF-003): fresh challenge, Intel TCB
// UpToDate, measurements pinned to what we observed. Run once per visit;
// buy-ins wait for it. The MagicBlock SDK's check alone is not enough.
import { verifyTee, type AttestationResult } from "@card-flex/client-sdk";
import { useEffect, useState } from "react";
import { PER_RPC } from "./env";

let pending: Promise<AttestationResult> | null = null;
const run = () => (pending ??= verifyTee(PER_RPC).catch((e) => ({ ok: false, reasons: [String((e as Error)?.message ?? e)] })));

export function useTee() {
  const [r, setR] = useState<AttestationResult | null>(null);
  useEffect(() => {
    let off = false;
    run().then((x) => !off && setR(x));
    return () => { off = true; };
  }, []);
  return {
    result: r,
    retry: () => { pending = null; setR(null); run().then(setR); },
  };
}
