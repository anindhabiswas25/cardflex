// Live Devnet check of the SDK (not part of the unit tests): attestation,
// PER login with a session key, and decoding real accounts.
// Usage: pnpm --filter @card-flex/client-sdk live
import { ENDPOINTS, baseConnection, decodeGlobal, globalPda, newSessionKey, perConnection, perLogin, verifyTee } from "../src/index.ts";

const att = await verifyTee(ENDPOINTS.devnet.per);
console.log("attestation:", att.ok ? "OK" : "FAILED", att.tcbStatus ?? "", att.reasons.join("; "));
const session = newSessionKey();
const { token, expiresAt } = await perLogin(session);
console.log("PER login OK; token valid for", Math.round((expiresAt - Date.now()) / 864e5), "days");
const slot = await perConnection(token).getSlot();
console.log("PER slot with token:", slot);
const g = await baseConnection().getAccountInfo(globalPda());
if (!g) throw new Error("GlobalConfig missing on devnet");
const global = decodeGlobal(g.data);
console.log("GlobalConfig:", { authority: global.authority.toBase58(), treasury: global.treasury.toBase58(), max_rake_bps: global.max_rake_bps, paused: global.paused });
process.exit(att.ok ? 0 : 1);
