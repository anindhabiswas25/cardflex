// Our own TEE attestation check (findings CF-003). The MagicBlock SDK's
// check accepts any genuine TDX machine; this one also:
//  1. uses a CSPRNG challenge (the SDK uses Math.random());
//  2. requires TCB status UpToDate (the SDK ignores it);
//  3. pins MRTD and RTMR0-2 to an allow-list (the SDK pins nothing).
// Known limit: the quote is not bound to the TLS connection (gap 4); a proxy
// could relay /quote to a real TEE. Treat this as one signal, not proof.
import { getCollateral, verify, Quote } from "@phala/dcap-qvl";

export const PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";

export type Measurements = { mrTd: string; rtMr0: string; rtMr1: string; rtMr2: string };

/** Values observed on devnet-tee on 2026-11-18 (CF-003). Ask MagicBlock for published values per release. */
export const DEVNET_TEE_MEASUREMENTS: Measurements[] = [
  {
    mrTd: "c1ee9c16e3afc506cfe042c5b846a368528f3b37618eafb27469bc114cf914e9222c91618470e7f2b28ac360968270a5",
    rtMr0: "c1f1f2bff33b16d1469134987fcdf0ea3bd9707350cc70e73f086c635a5fc4e96e0d214a7f775608e64d251382f20564",
    rtMr1: "5a5e062f119b848c291cb75630504c185d8646799be42ad5941566efde1643d0e1029c34b7011d865e389980e9ef6a00",
    rtMr2: "b90b887df3fa1fe071052ddd250f4d5175066b3182394942162ec92e62e1649fbdc20b3bc65fe2f4b473a48602ef3073",
  },
];

export type AttestationResult = {
  ok: boolean;
  reasons: string[]; // why it failed (empty when ok)
  tcbStatus?: string;
  advisoryIds?: string[];
  measurements?: Measurements;
};

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function verifyTee(perUrl: string, opts: { allow?: Measurements[]; pccsUrl?: string; now?: number } = {}): Promise<AttestationResult> {
  const allow = opts.allow ?? DEVNET_TEE_MEASUREMENTS;
  const challenge = new Uint8Array(64);
  crypto.getRandomValues(challenge);
  const reasons: string[] = [];
  const res = await fetch(`${perUrl}/quote?challenge=${encodeURIComponent(b64(challenge))}`, { signal: AbortSignal.timeout(15_000) });
  const body = (await res.json()) as { quote?: string; error?: string };
  if (res.status !== 200 || !body.quote) return { ok: false, reasons: [body.error ?? `HTTP ${res.status}`] };
  const raw = unb64(body.quote);
  let verified: { status: string; advisory_ids?: string[] };
  try {
    const collateral = await getCollateral(opts.pccsUrl ?? PCCS_URL, raw);
    verified = verify(raw, collateral, Math.floor((opts.now ?? Date.now()) / 1000)) as typeof verified;
  } catch (e) {
    return { ok: false, reasons: [`quote did not verify: ${String((e as Error).message ?? e)}`] };
  }
  const td = Quote.parse(raw).report.asTd10();
  if (!td) return { ok: false, reasons: ["not a TDX 1.0 quote"], tcbStatus: verified.status };
  const m: Measurements = { mrTd: hex(td.mrTd), rtMr0: hex(td.rtMr0), rtMr1: hex(td.rtMr1), rtMr2: hex(td.rtMr2) };
  if (hex(td.reportData) !== hex(challenge)) reasons.push("quote reportData does not match our challenge");
  if (verified.status !== "UpToDate") reasons.push(`TCB status ${verified.status}, required UpToDate`);
  const pinned = allow.some((a) => a.mrTd === m.mrTd && a.rtMr0 === m.rtMr0 && a.rtMr1 === m.rtMr1 && a.rtMr2 === m.rtMr2);
  if (!pinned) reasons.push("measurements are not on the allow-list (software changed or unknown machine)");
  return { ok: reasons.length === 0, reasons, tcbStatus: verified.status, advisoryIds: verified.advisory_ids, measurements: m };
}
