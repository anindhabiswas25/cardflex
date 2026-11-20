// A player whose table stalled (no sync for its refund timeout) gets their
// money back from the dashboard: "Start refund & claim" sends
// emergency_refund + claim_refund in one wallet transaction.
// Needs a player (E2E_KEYS/player-a.json by default, or PLAYER=player-x.json)
// that holds a seat on a stalled table.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { launch } from "./cdp.mjs";

const KEYS = process.env.E2E_KEYS ?? ".";
const URL0 = process.env.APP_URL ?? "http://localhost:3000";
const secret = JSON.parse(readFileSync(join(KEYS, process.env.PLAYER ?? "player-a.json"), "utf8"));
const init = `localStorage.setItem("cf:test-wallet", ${JSON.stringify(JSON.stringify(secret))}); localStorage.setItem("cf:last-wallet", "Devnet test wallet");`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, note = "") => { checks.push([name, ok]); log(`${ok ? "✓" : "✗"} ${name} ${note}`); };
const b = await launch(9338);
try {
  const p = await b.page("R", init);
  await p.goto(`${URL0}/dashboard`);
  const before = await p.waitFor(`(() => { const t = document.querySelector('[data-testid=wallet-pill]')?.innerText; return t && /\\d/.test(t) ? t : null })()`, 30000);
  await p.waitFor(`!!document.querySelector('[data-testid=start-refund]')`, 60000);
  const label = await p.text("[data-testid=start-refund]");
  check("dashboard offers a refund for the stalled table", true, label);
  await p.click("[data-testid=start-refund]");
  const msg = await p.waitFor(`/sent to your wallet/.test(document.body.innerText) ? document.body.innerText.match(/◎[\\d.]+ sent to your wallet/)?.[0] : null`, 120000);
  check("refund claimed and paid to the wallet", !!msg, msg ?? "");
  await new Promise((r) => setTimeout(r, 16000)); // balance refresh
  const after = await p.text("[data-testid=wallet-pill]");
  log("wallet before:", before.replace(/\n/g, " "), "after:", after.replace(/\n/g, " "));
  await p.shot(join(process.env.E2E_OUT ?? KEYS, "refund.png"));
} catch (e) {
  log("ERROR", e.message);
  checks.push(["no error", false]);
} finally {
  const failed = checks.filter((c) => !c[1]).length;
  log(`Refund E2E — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed}/${checks.length})`);
  b.close();
}
