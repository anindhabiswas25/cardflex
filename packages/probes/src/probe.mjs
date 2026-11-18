#!/usr/bin/env node
// CF-003 probe: latency, access (geofencing) and TEE attestation for the
// MagicBlock and Solana devnet endpoints Card Flex depends on.
//
// Usage:
//   pnpm --filter @card-flex/probes probe -- --region <label> [--samples 30] [--out file]
//
// --region is a label you choose for where you are running from, e.g.
// "in-mumbai-home-fiber". The probe never looks up your IP or location.

import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import { getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getCollateral, verify, Quote } from "@phala/dcap-qvl";

const PCCS_URL = "https://pccs.phala.network/tdx/certification/v4";

const ENDPOINTS = [
  { id: "tee", role: "MagicBlock PER (TEE)", http: "https://devnet-tee.magicblock.app", tee: true },
  { id: "er-as", role: "MagicBlock ER Asia", http: "https://devnet-as.magicblock.app" },
  { id: "er-eu", role: "MagicBlock ER Europe", http: "https://devnet-eu.magicblock.app" },
  { id: "er-us", role: "MagicBlock ER US", http: "https://devnet-us.magicblock.app" },
  // The router forwards by account and does not serve getHealth/getSlot or slotSubscribe.
  { id: "router", role: "MagicBlock router", http: "https://devnet-router.magicblock.app", methods: ["getLatestBlockhash"], ws: false },
  { id: "base-mb", role: "Solana devnet via MagicBlock", http: "https://rpc.magicblock.app/devnet" },
  // Public RPC rate-limits bursts (HTTP 429); results show what a client without a paid RPC would see.
  { id: "base-solana", role: "Solana devnet public RPC", http: "https://api.devnet.solana.com" },
];

// ---------- args ----------
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const region = arg("region");
if (!region) {
  console.error("Missing --region <label> (where you are running from).");
  process.exit(2);
}
const SAMPLES = Number(arg("samples", "30"));
const WS_WINDOW_MS = Number(arg("ws-window-ms", "8000"));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = resolve(arg("out", `${repoRoot}/docs/probes/${stamp}-${region}.json`));

// ---------- helpers ----------
const ms = (t0) => Math.round((performance.now() - t0) * 10) / 10;
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stats = (xs) =>
  xs.length
    ? { n: xs.length, min: Math.min(...xs), p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) }
    : { n: 0 };
const hex = (u8) => Buffer.from(u8).toString("hex");
const withToken = (url, token) => (token ? `${url}${url.includes("?") ? "&" : "?"}token=${token}` : url);
const toWs = (url) => url.replace(/^http/, "ws");

async function rpc(url, method, params = [], timeoutMs = 10000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const elapsed = ms(t0);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: res.ok && body && !body.error, status: res.status, ms: elapsed, body, text: body ? undefined : text.slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, ms: ms(t0), error: String(e.cause?.code ?? e.name ?? e) };
  }
}

async function latency(url, method) {
  const cold = await rpc(url, method);
  const warm = [];
  const failures = [];
  for (let i = 0; i < SAMPLES; i++) {
    const r = await rpc(url, method);
    if (r.ok) warm.push(r.ms);
    else failures.push({ status: r.status, error: r.error ?? r.body?.error?.message ?? r.text });
  }
  return { method, cold_ms: cold.ok ? cold.ms : null, cold_status: cold.status, warm_ms: stats(warm), failures: failures.slice(0, 3), failure_count: failures.length };
}

function wsProbe(url) {
  return new Promise((resolveP) => {
    const result = { url: url.replace(/token=[^&]+/, "token=<redacted>"), connect_ms: null, first_notification_ms: null, slot_interval_ms: null, notifications: 0, error: null };
    const t0 = performance.now();
    let ws;
    const slots = [];
    const done = () => {
      try { ws?.close(); } catch {}
      const gaps = [];
      for (let i = 1; i < slots.length; i++) {
        const ds = slots[i].slot - slots[i - 1].slot;
        if (ds > 0) gaps.push((slots[i].t - slots[i - 1].t) / ds);
      }
      result.slot_interval_ms = stats(gaps.map((g) => Math.round(g * 10) / 10));
      resolveP(result);
    };
    const timer = setTimeout(done, WS_WINDOW_MS);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      result.error = String(e);
      clearTimeout(timer);
      return resolveP(result);
    }
    ws.onopen = () => {
      result.connect_ms = ms(t0);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "slotSubscribe" }));
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === "slotNotification") {
        result.notifications++;
        if (result.first_notification_ms === null) result.first_notification_ms = ms(t0);
        slots.push({ slot: m.params.result.slot, t: performance.now() });
      } else if (m.error) {
        result.error = m.error.message ?? JSON.stringify(m.error);
      }
    };
    ws.onerror = (e) => { result.error = result.error ?? String(e.message ?? "websocket error"); };
    ws.onclose = (e) => {
      if (result.notifications === 0 && !result.error) result.error = `closed ${e.code} ${e.reason ?? ""}`.trim();
      clearTimeout(timer);
      done();
    };
  });
}

// Our own attestation check: CSPRNG challenge, TCB status and measurements
// recorded. The SDK's verifyTeeRpcIntegrity is also run for comparison.
async function attest(url) {
  const out = { sdk_verify: null, own: null };
  let t0 = performance.now();
  try {
    await verifyTeeRpcIntegrity(url);
    out.sdk_verify = { ok: true, ms: ms(t0) };
  } catch (e) {
    out.sdk_verify = { ok: false, ms: ms(t0), error: String(e.message ?? e) };
  }
  t0 = performance.now();
  try {
    const challenge = randomBytes(64);
    const res = await fetch(`${url}/quote?challenge=${encodeURIComponent(challenge.toString("base64"))}`, { signal: AbortSignal.timeout(15000) });
    const quoteMs = ms(t0);
    const body = await res.json();
    if (res.status !== 200 || !body.quote) throw new Error(body.error ?? `HTTP ${res.status}`);
    const raw = Uint8Array.from(Buffer.from(body.quote, "base64"));
    const collateral = await getCollateral(PCCS_URL, raw);
    const verified = verify(raw, collateral, Math.floor(Date.now() / 1000));
    const td = Quote.parse(raw).report.asTd10();
    if (!td) throw new Error("not a TD10 quote");
    out.own = {
      ok: Buffer.from(td.reportData).equals(challenge),
      quote_fetch_ms: quoteMs,
      total_ms: ms(t0),
      tcb_status: verified.status,
      advisory_ids: verified.advisory_ids,
      report_data_matches_challenge: Buffer.from(td.reportData).equals(challenge),
      measurements: { mr_td: hex(td.mrTd), rt_mr0: hex(td.rtMr0), rt_mr1: hex(td.rtMr1), rt_mr2: hex(td.rtMr2), rt_mr3: hex(td.rtMr3) },
    };
  } catch (e) {
    out.own = { ok: false, total_ms: ms(t0), error: String(e.message ?? e) };
  }
  return out;
}

async function auth(url) {
  const kp = nacl.sign.keyPair();
  const t0 = performance.now();
  try {
    const { token, expiresAt } = await getAuthToken(url, new PublicKey(kp.publicKey), async (m) => nacl.sign.detached(m, kp.secretKey));
    // The server returns no expiresAt (the SDK then assumes 30 days), so read exp from the JWT.
    let exp = null;
    try { exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url")).exp ?? null; } catch {}
    const lifetimeMs = exp ? exp * 1000 - Date.now() : expiresAt - Date.now();
    return { ok: true, ms: ms(t0), token, lifetime_hours: Math.round((lifetimeMs / 3.6e6) * 10) / 10, lifetime_source: exp ? "jwt exp" : "sdk default" };
  } catch (e) {
    return { ok: false, ms: ms(t0), error: String(e.message ?? e) };
  }
}

// ---------- run ----------
const report = {
  probe: "CF-003",
  version: 1,
  region,
  started_at: new Date().toISOString(),
  samples_per_method: SAMPLES,
  node: process.version,
  endpoints: [],
};

for (const ep of ENDPOINTS) {
  console.error(`probing ${ep.id} (${ep.http}) ...`);
  const r = { id: ep.id, role: ep.role, url: ep.http };
  r.access = await rpc(ep.http, ep.methods ? ep.methods[0] : "getVersion");
  r.access = { reachable: r.access.ok, status: r.access.status, error: r.access.error ?? r.access.body?.error?.message ?? r.access.text ?? null, version: r.access.body?.result ?? null };
  let token = null;
  if (ep.tee) {
    r.attestation = await attest(ep.http);
    const a = await auth(ep.http);
    token = a.ok ? a.token : null;
    r.auth = { ok: a.ok, ms: a.ms, lifetime_hours: a.lifetime_hours ?? null, lifetime_source: a.lifetime_source ?? null, error: a.error ?? null };
    const authed = await rpc(withToken(ep.http, token), "getVersion");
    r.access_with_token = { reachable: authed.ok, status: authed.status, version: authed.body?.result ?? null };
  }
  const url = withToken(ep.http, token);
  r.latency = [];
  for (const method of ep.methods ?? ["getHealth", "getSlot", "getLatestBlockhash"]) r.latency.push(await latency(url, method));
  r.websocket = ep.ws === false ? { skipped: "not supported by this endpoint" } : await wsProbe(withToken(toWs(ep.http), token));
  report.endpoints.push(r);
}
report.finished_at = new Date().toISOString();

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");

// ---------- summary ----------
const line = (cells) => `| ${cells.join(" | ")} |`;
console.log(`\nCF-003 probe — region: ${region} — ${report.started_at}\n`);
console.log(line(["Endpoint", "Reachable", "getSlot p50/p95 ms", "Blockhash p50/p95 ms", "WS first msg ms", "Slot interval p50 ms"]));
console.log(line(["---", "---", "---", "---", "---", "---"]));
for (const r of report.endpoints) {
  const g = (m) => r.latency.find((x) => x.method === m)?.warm_ms;
  const f = (s) => (s === undefined ? "n/a" : s?.n ? `${s.p50} / ${s.p95}` : "fail");
  const reach = r.access_with_token ? `${r.access.reachable ? "yes" : `no (${r.access.status})`}; token: ${r.access_with_token.reachable ? "yes" : "no"}` : r.access.reachable ? "yes" : `no (${r.access.status || r.access.error})`;
  console.log(line([r.id, reach, f(g("getSlot")), f(g("getLatestBlockhash")), r.websocket.skipped ? "n/a" : r.websocket.first_notification_ms ?? (r.websocket.error || "none"), r.websocket.slot_interval_ms?.p50 ?? "-"]));
}
const tee = report.endpoints.find((r) => r.id === "tee");
if (tee?.attestation) {
  const o = tee.attestation.own;
  console.log(`\nTEE attestation: SDK check ${tee.attestation.sdk_verify.ok ? "passed" : "FAILED: " + tee.attestation.sdk_verify.error}; own check ${o.ok ? "passed" : "FAILED: " + o.error}${o.tcb_status ? `, TCB status ${o.tcb_status}` : ""}`);
  if (o.measurements) console.log(`MRTD ${o.measurements.mr_td}`);
  console.log(`PER auth token: ${tee.auth.ok ? `ok in ${tee.auth.ms} ms, lifetime ${tee.auth.lifetime_hours} h` : "FAILED: " + tee.auth.error}`);
}
console.log(`\nFull results: ${outFile}`);
