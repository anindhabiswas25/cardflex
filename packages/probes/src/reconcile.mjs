#!/usr/bin/env node
// CF-034: reconcile one table's vault on the base layer (ADR 0005 decision 8):
//   vault = rent-exempt minimum + Σ SeatLedger.synced_stack + (synced_rake − rake_swept)
// Reads public base-layer accounts only, prints every term, shows the
// committed runtime for context (money in play since the last sync), and
// asks the program itself (check_vault, simulated) for its verdict.
//
// Usage: pnpm reconcile -- --table <TableConfig address> [--strict]
// Exit 0 = reconciles (exactly, with --strict), 1 = it doesn't.

import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { PROGRAM_ID, BASE_RPC, loadDiscriminators, loadPayer, makeIx, r, RT, TC, SL, ledgerPda } from "./common.mjs";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const tableArg = arg("table");
if (!tableArg) { console.error("Missing --table <TableConfig address>"); process.exit(2); }
const strict = args.includes("--strict");
const config = new PublicKey(tableArg);
const base = new Connection(BASE_RPC, "confirmed");
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const vault = pda(Buffer.from("table-vault"), config.toBuffer());
const runtime = pda(Buffer.from("table-runtime"), config.toBuffer());

const cfg = (await base.getAccountInfo(config))?.data;
if (!cfg) { console.error(`no TableConfig at ${config.toBase58()}`); process.exit(2); }
const vaultAcc = await base.getAccountInfo(vault);
const rent = BigInt(await base.getMinimumBalanceForRentExemption(vaultAcc.data.length));
const seated = cfg[TC.seated];
const syncedRake = cfg.readBigUInt64LE(TC.synced_rake), swept = cfg.readBigUInt64LE(TC.rake_swept);

const rows = [];
let owed = 0n;
const ledgers = [];
for (let s = 0; s < 6; s++) {
  if (!((seated >> s) & 1)) continue;
  const l = ledgerPda(config, s);
  ledgers.push(l);
  const d = (await base.getAccountInfo(l))?.data;
  const stack = d ? d.readBigUInt64LE(SL.synced_stack) : 0n;
  owed += stack;
  rows.push({ seat: s, synced_stack: stack.toString(), epoch: d ? d.readUInt32LE(90) : null, left: d ? d[126] === 1 : null });
}
const expected = rent + owed + (syncedRake - swept);
const have = BigInt(vaultAcc.lamports);

console.log(`table   ${config.toBase58()}`);
console.log(`vault   ${vault.toBase58()}  ${have} lamports`);
console.table(rows);
console.log(`rent-exempt minimum   ${rent}`);
console.log(`Σ synced stacks       ${owed}`);
console.log(`unswept rake          ${syncedRake - swept}  (synced ${syncedRake}, swept ${swept})`);
console.log(`expected              ${expected}`);
console.log(`difference            ${have - expected}${have === expected ? "  (exact)" : have > expected ? "  (surplus)" : "  (SHORT)"}`);

// Committed runtime, for context: what is in play since the last sync.
const rt = (await base.getAccountInfo(runtime))?.data;
if (rt) {
  const occ = rt[RT.occupied] | rt[RT.departed];
  let inPlay = 0n;
  for (let s = 0; s < 6; s++) if ((occ >> s) & 1) inPlay += rt.readBigUInt64LE(RT.stacks + 8 * s);
  console.log(`committed runtime: seq ${rt.readBigUInt64LE(RT.commit_seq)} (synced ${cfg.readBigUInt64LE(TC.last_synced_seq)}), phase ${rt[RT.phase]}, stacks ${inPlay}, rake_owed ${rt.readBigUInt64LE(RT.rake_owed)}`);
}

// The program's own verdict (simulated; changes nothing).
const payer = loadPayer();
const ix = makeIx(loadDiscriminators());
const tx = new Transaction().add(ix("check_vault", [r(config), r(vault), ...ledgers.map((l) => r(l))], Buffer.from([strict ? 1 : 0])));
tx.feePayer = payer.publicKey;
tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
const sim = await base.simulateTransaction(tx);
const ok = !sim.value.err;
console.log(`check_vault(strict=${strict}): ${ok ? "OK" : `FAILED ${JSON.stringify(sim.value.err)}`}`);
const reconciles = strict ? have === expected : have >= expected;
process.exit(ok && reconciles ? 0 : 1);
