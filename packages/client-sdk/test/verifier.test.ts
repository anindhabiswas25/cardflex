import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadVerifier, verifierWasmUrl } from "../src/verifier.ts";

const root = new URL("../../../", import.meta.url);
const probes = new URL("docs/probes/", root);
const records = readdirSync(probes).filter((f) => /-game-hand\d+\.json$/.test(f)).slice(0, 6);

function native(path: string): { valid: boolean; lines: string[] } {
  try {
    const out = execFileSync(new URL("target/release/cf-verify", root).pathname, [path], { encoding: "utf8" });
    return { valid: true, lines: out.trim().split("\n") };
  } catch (e: any) {
    return { valid: false, lines: String(e.stdout ?? "").trim().split("\n") };
  }
}

test("WASM verifier agrees with the native cf-verify on real Devnet hands", async () => {
  execFileSync("cargo", ["build", "-q", "--release", "-p", "fairness-verifier", "--bin", "cf-verify"], { cwd: root.pathname });
  const v = await loadVerifier(readFileSync(verifierWasmUrl));
  assert.ok(records.length >= 3, "needs Devnet hand records in docs/probes");
  for (const f of records) {
    const path = new URL(f, probes).pathname;
    const json = readFileSync(path, "utf8");
    const report = v.verify(json);
    const n = native(path);
    assert.equal(report.overall, "VALID", `${f}: ${JSON.stringify(report.checks.filter((c) => c.status === "INVALID"))}`);
    assert.equal(n.valid, true, f);
    // Same checks, same order, same verdicts as the CLI's lines.
    report.checks.forEach((c, i) => assert.ok(n.lines[i].startsWith(`${c.name}:`) && n.lines[i].includes(c.status), `${f}: ${n.lines[i]}`));
    assert.equal(report.deck?.length, 52);
    // Tamper with the result and with a salt: both caught.
    const rec = JSON.parse(json);
    rec.game.rake = String(BigInt(rec.game.rake) + 1n);
    assert.equal(v.verify(rec).overall, "INVALID");
    const rec2 = JSON.parse(json);
    rec2.salts[0] = rec2.salts[0].replace(/^./, (c: string) => (c === "0" ? "1" : "0"));
    const r2 = v.verify(rec2);
    assert.equal(r2.overall, "INVALID");
    assert.ok(r2.checks.some((c) => c.name === "Salt commitments" && c.status === "INVALID"));
  }
  assert.match(v.verify("not json").error ?? "", /not a valid/);
});
