// CF-067: tables that were live in PER when the runtime layout changed can't
// be migrated (the runtime is delegated) and can't commit or sync under the
// new program. Their players' money must still come out: emergency_refund +
// claim_refund never read the runtime. This drill finds such a table (old
// layout, delegated, seated players, refund timeout passed), refunds it and
// checks every seat is paid exactly its synced stack.
// Usage: pnpm --filter @card-flex/keeper refund-old [TABLE=<config>]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, ENDPOINTS, PROGRAM_ID, TABLE_STATUS, buildIx, decodeLedger, decodeTableConfig, sendAndConfirm, sizeOf, tableAddresses,
} from "@card-flex/client-sdk";
import { checkVault } from "../../admin/src/admin.ts";

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/cardflex/devnet-deployer.json`, "utf8"))));
const base = new Connection(ENDPOINTS.devnet.base, "confirmed");
const WANT = 8 + sizeOf({ defined: { name: "TableRuntime" } });
const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, note?: string) => { checks.push([name, ok, note]); console.log(`${ok ? "✓" : "✗"} ${name}${note ? ` (${note})` : ""}`); };

async function pick(): Promise<PublicKey> {
  if (process.env.TABLE) return new PublicKey(process.env.TABLE);
  const cfgs = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }] });
  const now = BigInt(Math.floor(Date.now() / 1000));
  for (let i = 0; i < cfgs.length; i += 100) {
    const ch = cfgs.slice(i, i + 100);
    const rts = await base.getMultipleAccountsInfo(ch.map((c) => tableAddresses(c.pubkey).runtime));
    for (const [j, c] of ch.entries()) {
      const r = rts[j];
      const cfg = decodeTableConfig(c.account.data);
      if (r && r.data.length !== WANT && r.owner.equals(DELEGATION_PROGRAM_ID) && cfg.status === TABLE_STATUS.ACTIVE && cfg.seated
        && now >= BigInt(cfg.last_sync_time) + BigInt(cfg.refund_timeout_secs)) return c.pubkey;
    }
  }
  throw new Error("no old live table with players past its refund timeout");
}

const config = await pick();
const t = tableAddresses(config);
const cfg0 = decodeTableConfig((await base.getAccountInfo(config))!.data);
const rt = (await base.getAccountInfo(t.runtime))!;
console.log(`table ${config.toBase58()}: runtime ${rt.data.length} bytes (old), delegated: ${rt.owner.equals(DELEGATION_PROGRAM_ID)}, seated ${cfg0.seated.toString(2)}`);

await sendAndConfirm(base, [buildIx("emergency_refund", { payer: admin.publicKey, config })], [admin]);
const cfg1 = decodeTableConfig((await base.getAccountInfo(config))!.data);
check("emergency_refund works on an old-layout live table", cfg1.status === TABLE_STATUS.REFUNDED);

for (let s = 0; s < 6; s++) {
  if (!((cfg0.seated >> s) & 1)) continue;
  const la = await base.getAccountInfo(t.ledger(s));
  if (!la) continue;
  const led = decodeLedger(la.data);
  const before = BigInt(await base.getBalance(led.wallet));
  await sendAndConfirm(base, [buildIx("claim_refund", { payer: admin.publicKey, config, vault: t.vault, ledger: t.ledger(s), wallet: led.wallet })], [admin]);
  const paid = BigInt(await base.getBalance(led.wallet)) - before;
  check(`seat ${s}: wallet paid its synced stack`, paid >= BigInt(led.synced_stack) && led.synced_stack > 0n, `stack ${led.synced_stack}, wallet +${paid} (incl. any ledger rent)`);
}
const cfg2 = decodeTableConfig((await base.getAccountInfo(config))!.data);
const tx = new Transaction().add(checkVault(config, cfg2.seated, true));
tx.feePayer = admin.publicKey; tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
check("vault reconciles exactly after the claims", !sim.value.err, sim.value.err ? JSON.stringify(sim.value.err) : undefined);

const failed = checks.filter((c) => !c[1]).length;
console.log(`\nCF-067 old-table refund — ${failed ? "FAILED" : "PASSED"} (${checks.length - failed} passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
