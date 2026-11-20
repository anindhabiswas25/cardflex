// Two players play a real hand on Devnet through the web UI.
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

const b = await launch(9334);
const A = await b.page("A", init("player-a.json"));
const B = await b.page("B", init("player-b.json"));
try {
  for (const p of [A, B]) await p.goto(`${URL0}/table/${TABLE}`);
  // TEE check runs in the browser.
  const tee = await A.waitFor(`(() => { const t = document.querySelector('[data-testid=tee-badge]')?.innerText; return t && !t.includes('checking') ? t : null })()`, 60000);
  check("TEE attestation checked in the browser", tee.includes("verified") && !tee.includes("unverified"), tee);
  await A.shot(join(process.env.E2E_OUT ?? KEYS, "table-spectator.png"));

  // Each player: resume a seat left from an earlier run, cash out if the
  // table made them leave, or buy in at the minimum.
  const setMin = `(() => { const r = document.querySelector('[data-testid=buy-in] input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, r.min); r.dispatchEvent(new Event('input', { bubbles: true })); return r.min; })()`;
  for (const p of [A, B]) {
    const state = await p.waitFor(`(() => { const t = document.body.innerText; if (/Resume my seat/i.test(t)) return 'resume'; if (document.querySelector('[data-testid=cash-out]')) return 'cashout'; if (/Syncing your final stack/i.test(t)) return null; const b = document.querySelector('[data-testid=buy-in-btn]'); if (b && !b.disabled) return 'buyin'; if (t.includes('● seated')) return 'seated'; return null })()`, 180000, 1000);
    log(p.name, "arrives:", state);
    if (state === "resume") {
      await p.clickText("button", "Resume my seat");
      await p.waitFor(`document.body.innerText.includes('● seated') || !!document.querySelector('[data-testid=cash-out]')`, 120000);
      check(`${p.name} resumed its seat in a new browser (wallet rotated the session key)`, await p.eval(`document.body.innerText.includes('● seated')`));
    }
    if (state === "cashout" || await p.eval(`!!document.querySelector('[data-testid=cash-out]')`)) {
      const label = await p.text("[data-testid=cash-out]");
      await p.click("[data-testid=cash-out]");
      await p.waitFor(`!!document.querySelector('[data-testid=buy-in-btn]')`, 120000);
      check(`${p.name} cashed out the seat it was made to leave`, true, label);
    }
    if (!(await p.eval(`document.body.innerText.includes('● seated')`))) {
      await p.waitFor(`!!document.querySelector('[data-testid=buy-in-btn]') && !document.querySelector('[data-testid=buy-in-btn]').disabled`, 60000);
      await p.eval(setMin);
      await sleep(300);
      log(p.name, "buy-in:", await p.text("[data-testid=buy-in-btn]"));
      await p.click("[data-testid=buy-in-btn]");
      await p.waitFor(`/seated|bought in|Seating you/i.test(document.body.innerText) && !/Buying in/.test(document.body.innerText)`, 120000);
      await sleep(1500);
    }
  }
  for (const p of [A, B]) await p.waitFor(`document.body.innerText.includes('● seated')`, 120000);
  check("both players seated (session keys read the live table)", true);

  // Play until a result shows. Bet a couple of rounds, then Show.
  let acts = 0, sawMid = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 6 * 60_000) {
    const done = await A.eval(`!!document.querySelector('[data-testid=result]')`) && await B.eval(`!!document.querySelector('[data-testid=result]')`);
    if (done) break;
    for (const p of [A, B]) {
      const myTurn = await p.eval(`/your turn/.test(document.body.innerText)`);
      if (!myTurn) continue;
      if (!sawMid) { sawMid = true; await p.shot(join(process.env.E2E_OUT ?? KEYS, "table-midhand.png")); const cards = await p.eval(`document.querySelectorAll('[data-testid=my-cards] .card').length`); check("dealt player sees three cards of their own", cards === 3, `${cards}`); }
      // Look at the cards first (a blind player can't Show a seen one).
      if (await p.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^see cards$/i.test(x.innerText.trim())); return b && !b.disabled })()`)) {
        await p.clickText("button", "See cards"); log(p.name, "see"); await sleep(2500);
        const faces = await p.eval(`document.querySelectorAll('[data-testid=my-cards] .card-face').length`);
        check(`${p.name} sees its own card faces after See`, faces === 3, String(faces));
      }
      const showOk = await p.eval(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim().toLowerCase() === 'show'); return b && !b.disabled })()`);
      if (acts >= 4 && showOk) { const ok = await p.clickText("button", "Show"); log(p.name, "show", ok); }
      else if (await p.click("[data-testid=chaal]")) log(p.name, "chaal");
      acts++;
      await sleep(2500);
    }
    await sleep(700);
  }
  const ra = await A.waitFor(`document.querySelector('[data-testid=result]')?.innerText`, 120000);
  const rb = await B.waitFor(`document.querySelector('[data-testid=result]')?.innerText`, 30000);
  log("A result:", ra.replace(/\n/g, " | "));
  check("hand finished and both players see the result", !!ra && !!rb);
  check("the hand reached a Show (both hands revealed to both players)", /show/i.test(ra) && !/last player/i.test(ra), ra.split("\n")[0]);
  const shownB = await B.waitFor(`(() => { const n = document.querySelectorAll('[data-testid^=seat-] .card-face').length; return n >= 3 ? n : null })()`, 30000).catch(() => 0);
  await sleep(6000); // the keeper moves on to the next hand: the result and cards must stay
  const stillB = await B.eval(`document.querySelectorAll('[data-testid^=seat-] .card-face').length`);
  check("revealed cards stay visible with the result after the next hand begins", stillB === 3, String(stillB));
  check("B sees A's revealed cards after the Show", shownB === 3, String(shownB));
  const v = await A.waitFor(`/verified in your browser|verification FAILED/.exec(document.querySelector('[data-testid=result]')?.innerText ?? '')?.[0]`, 90000).catch(() => null);
  check("hand verified in the browser (WASM verifier on the revealed hand)", v === "verified in your browser", v ?? "no verdict");
  await A.shot(join(process.env.E2E_OUT ?? KEYS, "table-result.png"));
  await B.shot(join(process.env.E2E_OUT ?? KEYS, "table-result-b.png"));

  // The verify page for this hand.
  const href = await A.eval(`[...document.querySelectorAll('a')].find(a => /verify hand/i.test(a.innerText))?.getAttribute('href')`);
  const V = await b.page("V");
  await V.goto(`${URL0}${href}`);
  const overall = await V.waitFor(`document.querySelector('[data-testid=verify-overall]')?.innerText`, 60000).catch(() => null);
  check("verify page says VALID", !!overall && overall.includes("VALID") && !overall.includes("INVALID"), overall?.replace(/\n/g, " ") ?? "");
  await V.shot(join(process.env.E2E_OUT ?? KEYS, "verify.png"));

  // Both leave and cash out.
  for (const p of [A, B]) { await p.click("[data-testid=leave]"); log(p.name, "leave"); await sleep(1500); }
  for (const p of [A, B]) {
    await p.waitFor(`!!document.querySelector('[data-testid=cash-out]')`, 8 * 60_000, 2000);
    const label = await p.text("[data-testid=cash-out]");
    await p.click("[data-testid=cash-out]");
    await p.waitFor(`/Take a seat/.test(document.body.innerText) || !document.querySelector('[data-testid=cash-out]')`, 120000);
    check(`${p.name} cashed out`, true, label);
  }
  await A.shot(join(process.env.E2E_OUT ?? KEYS, "table-after.png"));
  // Dashboard renders for A.
  await A.goto(`${URL0}/dashboard`);
  await A.waitFor(`/My seats/.test(document.body.innerText) && !/Reading Solana/.test(document.body.innerText)`, 60000);
  await sleep(4000);
  await A.shot(join(process.env.E2E_OUT ?? KEYS, "dashboard.png"));
  log("dashboard:", (await A.eval(`document.querySelector('main').innerText`)).slice(0, 600).replace(/\n+/g, " | "));
} catch (e) {
  log("ERROR", e.message);
  await A.shot(join(process.env.E2E_OUT ?? KEYS, "error-a.png")).catch(() => {});
  await B.shot(join(process.env.E2E_OUT ?? KEYS, "error-b.png")).catch(() => {});
  checks.push(["no error", false]);
} finally {
  log("console A:", A.logs.slice(0, 6));
  log("console B:", B.logs.slice(0, 6));
  const failed = checks.filter((c) => !c[1]).length;
  log(`E2E — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed}/${checks.length})`);
  b.close();
}
