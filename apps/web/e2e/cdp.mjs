// Minimal Chrome DevTools Protocol driver (no dependencies): launches headless
// Chrome, gives each "player" an isolated browser context (own localStorage),
// and exposes eval / click / wait / screenshot helpers.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function launch(port = 9333) {
  const dir = mkdtempSync(join(tmpdir(), "cf-e2e-chrome-"));
  const proc = spawn(process.env.CHROME ?? "google-chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--window-size=1440,1000", "about:blank"], { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await new Promise((r) => setTimeout(r, 200)); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const handlers = new Set();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else handlers.forEach((h) => h(m));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return {
    async page(name, initScript, mobile = process.env.MOBILE === "1") {
      const { browserContextId } = await send("Target.createBrowserContext");
      const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m, p) => send(m, p, sessionId);
      await s("Page.enable"); await s("Runtime.enable");
      await s("Emulation.setDeviceMetricsOverride", mobile ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
      if (initScript) await s("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
      const logs = [];
      handlers.add((m) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) logs.push(`[${m.params.type}] ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
        if (m.method === "Runtime.exceptionThrown") logs.push(`[exception] ${m.params.exceptionDetails.exception?.description?.slice(0, 300) ?? m.params.exceptionDetails.text}`);
      });
      const p = {
        name, logs,
        async goto(url) { await s("Page.navigate", { url }); await new Promise((r) => setTimeout(r, 1500)); },
        async eval(expr) {
          const r = await s("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(`${name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
          return r.result.value;
        },
        async text(sel) { return p.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`); },
        async click(sel) { return p.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || e.disabled) return false; e.click(); return true; })()`); },
        async clickText(tag, text) { return p.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(tag)})].find((x) => x.innerText.trim().toLowerCase().startsWith(${JSON.stringify(text.toLowerCase())})); if (!e || e.disabled) return false; e.click(); return true; })()`); },
        async waitFor(expr, ms = 60_000, every = 500) {
          const t0 = Date.now();
          for (;;) { const v = await p.eval(expr).catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`${name}: timed out waiting for ${expr}`); await new Promise((r) => setTimeout(r, every)); }
        },
        async shot(file) { const { data } = await s("Page.captureScreenshot", { format: "png" }); writeFileSync(file, Buffer.from(data, "base64")); },
      };
      return p;
    },
    close() { try { ws.close(); } catch {} proc.kill("SIGKILL"); },
  };
}
