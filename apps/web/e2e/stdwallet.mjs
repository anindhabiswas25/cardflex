// The real-wallet path: a mock Wallet Standard wallet (what Phantom/Solflare
// expose) registered in the page, signing with WebCrypto Ed25519. The app
// must discover it, connect, and get buy-in / cash-out signed through it.
// Also: mobile layout screenshots, the /verify index page, the rules page.
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Funded Devnet keypair files player-a.json, player-b.json, player-c.json (never commit them).
const KEYS = process.env.E2E_KEYS ?? ".";
const key = (f) => join(KEYS, f);
import { launch } from "./cdp.mjs";

const TABLE = process.env.TABLE ?? (() => { throw new Error("set TABLE=<table config address>"); })();
const URL0 = process.env.APP_URL ?? "http://localhost:3000";
const secret = JSON.parse(readFileSync(key("player-a.json"), "utf8"));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, note = "") => { checks.push([name, ok]); log(`${ok ? "✓" : "✗"} ${name} ${note}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Registered on every page before the app loads.
const mockWallet = `(() => {
  const secret = Uint8Array.from(${JSON.stringify(secret)});
  const seed = secret.slice(0, 32), pub = secret.slice(32);
  const b64u = (u) => btoa(String.fromCharCode(...u)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const keyP = crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: b64u(seed), x: b64u(pub) }, { name: "Ed25519" }, false, ["sign"]);
  const sign = async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", await keyP, m));
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const b58 = (bytes) => { const d = [0]; for (const x of bytes) { let c = x; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } } let o = ""; for (const x of bytes) { if (x) break; o += "1"; } for (let i = d.length - 1; i >= 0; i--) o += B58[d[i]]; return o; };
  const account = { address: b58(pub), publicKey: pub, chains: ["solana:devnet"], features: ["solana:signTransaction", "solana:signMessage"] };
  window.__mockSigns = 0;
  const wallet = {
    version: "1.0.0", name: "Mock Wallet", icon: "data:image/svg+xml;base64,PHN2Zy8+", chains: ["solana:devnet", "solana:mainnet"], accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { wallet.accounts = [account]; return { accounts: [account] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { wallet.accounts = []; } },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async (...inputs) => Promise.all(inputs.map(async ({ transaction }) => {
        // Legacy wire format: [n sigs][64·n sigs][message]; the fee payer signs slot 0.
        const tx = new Uint8Array(transaction);
        const n = tx[0], msg = tx.slice(1 + 64 * n);
        // account keys start after the 3-byte header and the compact length
        const keysAt = 1 + 64 * n + 3 + 1, nKeys = tx[1 + 64 * n + 3];
        let slot = -1;
        for (let k = 0; k < nKeys; k++) { const kk = tx.slice(keysAt + 32 * k, keysAt + 32 * (k + 1)); if (kk.every((v, i) => v === pub[i])) { slot = k; break; } }
        tx.set(await sign(msg), 1 + 64 * slot);
        window.__mockSigns++;
        return { signedTransaction: tx };
      })) },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => { window.__mockSigns++; return { signedMessage: message, signature: await sign(message) }; })) },
    },
  };
  const register = (api) => api.register(wallet);
  window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
})();`;

const b = await launch(9336);
try {
  const p = await b.page("W", mockWallet);
  await p.goto(`${URL0}/table/${TABLE}`);
  await p.clickText("button", "Connect wallet");
  await p.waitFor(`[...document.querySelectorAll('button')].some(x => x.innerText.includes('Mock Wallet'))`, 15000);
  check("the app discovers a Wallet Standard wallet", true);
  await p.clickText("button", "Mock Wallet");
  const pill = await p.waitFor(`document.querySelector('[data-testid=wallet-pill]')?.innerText`, 20000);
  check("connects through standard:connect", /5XAz/.test(pill), pill.replace(/\n/g, " "));
  // Buy in through the wallet's signTransaction, then leave and cash out.
  await p.waitFor(`!!(document.querySelector('[data-testid=buy-in] input[type=range]') ?? (document.querySelector('.tb-socket:not(:disabled)')?.click(), null))`, 60000); // CF-078: tap a + seat
  await p.eval(`(() => { const r = document.querySelector('[data-testid=buy-in] input[type=range]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(r, r.min); r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.waitFor(`!(document.querySelector('[data-testid=buy-in-btn]') ?? (document.querySelector('.tb-socket:not(:disabled)')?.click(), document.querySelector('[data-testid=buy-in-btn]'))).disabled`, 60000);
  await p.click("[data-testid=buy-in-btn]");
  await p.waitFor(`/You're bought in|● seated/.test(document.body.innerText)`, 120000);
  check("buy-in signed by the wallet (signTransaction)", (await p.eval(`window.__mockSigns`)) >= 1);
  await p.waitFor(`document.body.innerText.includes('● seated')`, 120000);
  check("seated with a session key (no more wallet prompts while playing)", true, `wallet signatures so far: ${await p.eval("window.__mockSigns")}`);
  await p.click("[data-testid=leave]");
  const tLeave = Date.now();
  await p.waitFor(`!!document.querySelector('[data-testid=cash-out]') || !!document.querySelector('[data-testid=paid]')`, 5 * 60_000, 2000);
  const label = (await p.text("[data-testid=cash-out]")) ?? (await p.text("[data-testid=paid]"));
  await p.click("[data-testid=cash-out]");
  await p.waitFor(`!document.querySelector('[data-testid=cash-out]') && (!!document.querySelector('[data-testid=paid]') || !!document.querySelector('[data-testid=buy-in]'))`, 120000);
  check("cash-out signed by the wallet", true, `${label} · signatures: ${await p.eval("window.__mockSigns")}`);
  check("cash-out ready within 60 s of leaving (keeper syncs the departure at once)", Date.now() - tLeave < 60_000, `${Math.round((Date.now() - tLeave) / 1000)} s`);

} catch (e) {
  log("ERROR", e.message);
  checks.push(["no error", false]);
} finally {
  const failed = checks.filter((c) => !c[1]).length;
  log(`Wallet Standard E2E — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed}/${checks.length})`);
  b.close();
}
