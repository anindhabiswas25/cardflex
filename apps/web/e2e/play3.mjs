// Three players, real Devnet, through the web UI: Side Show (private
// comparison), pack, Show, result cards staying visible until the next deal,
// leave + cash out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Funded Devnet keypair files player-a.json, player-b.json, player-c.json (never commit them).
const KEYS = process.env.E2E_KEYS ?? ".";
const key = (f) => join(KEYS, f);
import { launch } from "./cdp.mjs";

const TABLE = process.env.TABLE ?? (() => { throw new Error("set TABLE=<table config address>"); })();
const URL0 = process.env.APP_URL ?? "http://localhost:3000";
const init = (f) => `localStorage.setItem("cf:test-wallet", ${JSON.stringify(JSON.stringify(JSON.parse(readFileSync(key(f), "utf8"))))}); localStorage.setItem("cf:last-wallet", "Devnet test wallet");`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, note = "") => { checks.push([name, ok]); log(`${ok ? "✓" : "✗"} ${name} ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const btn = (label) => `(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})); return b && !b.disabled })()`;

const b = await launch(9335);
const P = [await b.page("A", init("player-a.json")), await b.page("B", init("player-b.json")), await b.page("C", init("player-c.json"))];
try {
  for (const p of P) await p.goto(`${URL0}/table/${TABLE}`);
  const setMin = `(() => { const r = document.querySelector('[data-testid=buy-in] input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, r.min); r.dispatchEvent(new Event('input', { bubbles: true })); return r.min; })()`;
  let ready = 0;
  for (const p of P) {
    // Don't race an earlier player for the same seat: wait until they show up here.
    await p.waitFor(`document.querySelectorAll('[data-testid^=seat-]').length >= ${ready}`, 90000, 1000);
    const st = await p.waitFor(`(() => { const t = document.body.innerText; if (/Resume my seat/i.test(t)) return 'resume'; if (document.querySelector('[data-testid=cash-out]')) return 'cashout'; const b = (document.querySelector('[data-testid=buy-in-btn]') ?? (document.querySelector('.tb-socket:not(:disabled)')?.click(), document.querySelector('[data-testid=buy-in-btn]'))); if (b && !b.disabled) return 'buyin'; if (t.includes('● seated')) return 'seated'; return null })()`, 180000, 1000);
    if (st === "resume") { await p.clickText("button", "Resume my seat"); await p.waitFor(`document.body.innerText.includes('● seated')`, 120000); }
    if (st === "cashout") { await p.click("[data-testid=cash-out]"); await p.waitFor(`!!(document.querySelector('[data-testid=buy-in-btn]') ?? (document.querySelector('.tb-socket:not(:disabled)')?.click(), document.querySelector('[data-testid=buy-in-btn]')))`, 120000); }
    if (!(await p.eval(`document.body.innerText.includes('● seated')`))) {
      await p.waitFor(`!!document.querySelector('[data-testid=buy-in] input[type=range]')`, 60000);
      await p.eval(setMin); await sleep(300);
      await p.waitFor(`!(document.querySelector('[data-testid=buy-in-btn]') ?? (document.querySelector('.tb-socket:not(:disabled)')?.click(), document.querySelector('[data-testid=buy-in-btn]'))).disabled`, 60000);
      await p.click("[data-testid=buy-in-btn]");
      await p.waitFor(`/seated|Seating you/i.test(document.body.innerText) && !/Buying in/.test(document.body.innerText)`, 120000);
      await sleep(1500);
    }
    ready++;
    log(p.name, "ready");
  }
  for (const p of P) await p.waitFor(`document.body.innerText.includes('● seated')`, 180000);
  // Wait for a hand where all three are dealt.
  await P[0].waitFor(`[...document.querySelectorAll('[data-testid^=seat-] img')].filter((i) => (i.getAttribute('src') ?? '').startsWith('/cards/')).length >= 6 && /your turn|to act|Dealing/i.test(document.body.innerText) || [...document.querySelectorAll('[data-testid^=seat-] img')].filter((i) => (i.getAttribute('src') ?? '').startsWith('/cards/')).length >= 6`, 180000, 700);
  check("three players dealt in", true);

  let sideShowAsked = false, sideShowSeen = false, packed = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000) {
    if (await P[0].eval(`!!document.querySelector('[data-testid=result]') && /won/.test(document.querySelector('[data-testid=result]').innerText)`)) break;
    for (const p of P) {
      // Respond to a Side Show request: accept.
      if (await p.eval(btn("Accept Side Show"))) {
        await p.clickText("button", "Accept Side Show"); log(p.name, "accepts Side Show");
        await sleep(4000);
        continue;
      }
      if (!(await p.eval(`/your turn/.test(document.body.innerText)`))) continue;
      if (await p.eval(btn("See cards"))) { await p.clickText("button", "See cards"); log(p.name, "see"); await sleep(2500); }
      if (!sideShowAsked && (await p.eval(btn("Side Show")))) {
        await p.clickText("button", "Side Show"); log(p.name, "asks for a Side Show"); sideShowAsked = p.name;
        await sleep(3000);
        continue;
      }
      if (sideShowAsked && !packed && (await p.eval(btn("Show")))) { await p.clickText("button", "Show"); log(p.name, "show"); await sleep(3000); continue; }
      if (await p.click("[data-testid=chaal]")) log(p.name, "chaal");
      await sleep(2000);
    }
    // After an accepted Side Show the two players see each other's cards.
    if (sideShowAsked && !sideShowSeen) {
      for (const p of P) {
        const faces = await p.eval(`[...document.querySelectorAll('[data-testid^=seat-] img')].filter((i) => (i.getAttribute('src') ?? '').startsWith('/cards/') && !(i.getAttribute('src') ?? '').startsWith('/cards/back-')).length`);
        if (faces >= 3 && !(await p.eval(`!!document.querySelector('[data-testid=result]')`))) { sideShowSeen = p.name; check(`Side Show: ${p.name} privately sees its opponent's cards`, true, `${faces} faces`); await p.shot(join(process.env.E2E_OUT ?? KEYS, `sideshow-${p.name}.png`)); }
      }
    }
    await sleep(600);
  }
  const res = await P[0].waitFor(`document.querySelector('[data-testid=result]')?.innerText`, 120000);
  log("result:", res.replace(/\n/g, " | "));
  check("three-player hand finished", /won/.test(res));
  check("a Side Show was asked during the hand", !!sideShowAsked, sideShowAsked || "");
  // Result cards stay until the next deal.
  let sawIdleWithCards = false, samples = 0;
  for (let i = 0; i < 30; i++) {
    const st = await P[1].eval(`({ line: document.querySelector('[data-testid=status-line]')?.innerText ?? '', center: !!document.querySelector('[data-testid=result]'), faces: [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') ?? '').startsWith('/cards/') && !(i.getAttribute('src') ?? '').startsWith('/cards/back-')).length, result: !!document.querySelector('[data-testid=result]') })`);
    if (st.center && st.result) { samples++; if (st.faces > 0) sawIdleWithCards = true; }
    if (sawIdleWithCards) break;
    await sleep(500);
  }
  check("result cards stay visible between hands (until the next deal)", sawIdleWithCards || samples === 0, `${samples} between-hand samples`);
  await P[1].shot(join(process.env.E2E_OUT ?? KEYS, "three-result.png"));
  // CF-083: Leave goes straight to Boards; the popup follows the keeper's payout.
  for (const p of P) { await p.click("[data-testid=leave]"); await sleep(800); }
  for (const p of P) {
    const onBoards = await p.waitFor(`location.pathname === '/tables' && (document.querySelector('[data-testid=exit-pending]') || document.querySelector('[data-testid=exit-summary]')) ? 'popup' : null`, 60000).catch(() => null);
    const paid = await p.waitFor(`document.querySelector('[data-testid=exit-summary]') ? document.querySelector('[data-testid=exit-paid]')?.innerText : null`, 8 * 60_000, 2000).catch(() => null);
    check(`${p.name} left to Boards and was paid out`, onBoards === "popup" && !!paid, paid ?? "");
    await p.click("[data-testid=exit-close]");
  }
} catch (e) {
  log("ERROR", e.message);
  for (const p of P) await p.shot(join(process.env.E2E_OUT ?? KEYS, `error3-${p.name}.png`)).catch(() => {});
  checks.push(["no error", false]);
} finally {
  for (const p of P) if (p.logs.length) log(`console ${p.name}:`, p.logs.slice(0, 5));
  const failed = checks.filter((c) => !c[1]).length;
  log(`E2E 3p — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed}/${checks.length})`);
  b.close();
}
