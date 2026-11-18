#!/usr/bin/env node
// cf-admin: operator CLI for Card Flex (CF-041). Signs locally with your
// keypair; no server holds keys. Every money rule is enforced by the program:
// this tool can't move player funds (only rake, to the configured treasury).
//
//   cf-admin global show
//   cf-admin global set [--treasury <pk>] [--max-rake-bps N] [--pause | --unpause]
//   cf-admin tables
//   cf-admin table create --boot <lamports> [--rake-bps N] [--rake-cap <lamports>] [--seats 6] [--refund-timeout 3600] [--id N]
//   cf-admin table open <config>      delegate to the TEE + create permissions, dealer, seat hands, salts
//   cf-admin table status <config>
//   cf-admin table check <config> [--strict]   reconcile the vault (simulated check_vault + the terms)
//   cf-admin table sweep <config>     rake -> treasury
//   cf-admin table close <config>     close ephemeral accounts and undelegate
//
// Options: --keypair <path> (default ~/.config/cardflex/devnet-deployer.json),
//          --dry-run (print the instructions, send nothing).
// Env: CARDFLEX_BASE_RPC, CARDFLEX_PER_RPC.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, ENDPOINTS, PROGRAM_ID, TABLE_STATUS, decodeGlobal, decodeLedger, decodeRuntime, decodeTableConfig,
  globalPda, perConnection, perLogin, sizeOf, tableAddresses,
} from "@card-flex/client-sdk";
import { checkVault, closeTablePer, createTable, delegateTable, openTablePer, sweepRake, updateGlobal } from "./admin.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !["--pause", "--unpause", "--strict", "--dry-run"].includes(argv[i - 1])));
const dry = flag("dry-run");
const baseUrl = process.env.CARDFLEX_BASE_RPC ?? ENDPOINTS.devnet.base;
const perUrl = process.env.CARDFLEX_PER_RPC ?? ENDPOINTS.devnet.per;
const base = new Connection(baseUrl, "confirmed");
const keyPath = opt("keypair", `${homedir()}/.config/cardflex/devnet-deployer.json`)!;
const signer = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const lamports = (x: bigint | number) => `${x} lamports (◎${(Number(x) / 1e9).toFixed(6)})`;

async function send(conn: Connection, ixs: TransactionInstruction[], kp: Keypair, label: string, { skipPreflight = false } = {}) {
  if (dry) {
    for (const ix of ixs) console.log(`[dry-run] ${label}: ${ix.keys.length} accounts, ${ix.data.length} bytes`);
    return;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const tx = new Transaction().add(...ixs);
      const bh = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = kp.publicKey;
      tx.sign(kp);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight });
      const res = await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} (${sig})`);
      console.log(`✓ ${label}  ${sig}`);
      return;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (attempt >= 2 || /failed:|custom program error|Simulation failed/.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function readTable(config: PublicKey) {
  const t = tableAddresses(config);
  const [c, r] = await base.getMultipleAccountsInfo([config, t.runtime]);
  if (!c) throw new Error(`no table at ${config.toBase58()}`);
  return { t, cfg: decodeTableConfig(c.data), rt: r ? decodeRuntime(r.data) : null, live: !!r?.owner.equals(DELEGATION_PROGRAM_ID) };
}

async function main() {
  const [area, cmd, arg] = pos;
  if (area === "global" && cmd === "show") {
    const g = await base.getAccountInfo(globalPda());
    if (!g) return console.log("GlobalConfig not created yet (cf-admin needs the program's upgrade authority: probes' ensureGlobal)");
    const d = decodeGlobal(g.data);
    console.log({ address: globalPda().toBase58(), authority: d.authority.toBase58(), treasury: d.treasury.toBase58(), maxRakeBps: d.max_rake_bps, paused: d.paused });
    return;
  }
  if (area === "global" && cmd === "set") {
    const g = decodeGlobal((await base.getAccountInfo(globalPda()))!.data);
    const next = {
      treasury: opt("treasury") ? new PublicKey(opt("treasury")!) : g.treasury,
      maxRakeBps: opt("max-rake-bps") ? Number(opt("max-rake-bps")) : g.max_rake_bps,
      paused: flag("pause") ? true : flag("unpause") ? false : g.paused,
    };
    console.log("global ->", { treasury: next.treasury.toBase58(), maxRakeBps: next.maxRakeBps, paused: next.paused });
    await send(base, [updateGlobal(signer().publicKey, next)], signer(), "update_global");
    return;
  }
  if (area === "tables") {
    const accs = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }] });
    for (const a of accs) {
      const c = decodeTableConfig(a.account.data);
      console.log(a.pubkey.toBase58(), `seats ${c.max_seats}`, `seated ${c.seated.toString(2).replace(/0/g, "").length}`, c.status === TABLE_STATUS.ACTIVE ? "active" : "refunded", `buy-in ${c.min_buy_in}-${c.max_buy_in}`);
    }
    console.log(`${accs.length} table(s)`);
    return;
  }
  if (area === "table" && cmd === "create") {
    const kp = signer();
    const p = {
      tableId: BigInt(opt("id", String(Date.now()))!), seats: Number(opt("seats", "6")), boot: BigInt(opt("boot") ?? fail("--boot is required")),
      rakeBps: Number(opt("rake-bps", "0")), rakeCap: BigInt(opt("rake-cap", "0")!), refundTimeoutSecs: Number(opt("refund-timeout", "3600")),
    };
    const { config, ixs } = createTable(kp.publicKey, p);
    console.log(`table ${config.toBase58()} (id ${p.tableId}): ${p.seats} seats, boot ${lamports(p.boot)}, buy-in 40–200 boots, rake ${p.rakeBps} bps cap ${p.rakeCap}`);
    await send(base, ixs, kp, "create_table + configure_table");
    return;
  }
  if (area === "table" && arg) {
    const config = new PublicKey(arg);
    if (cmd === "status") {
      const { t, cfg, rt, live } = await readTable(config);
      console.log({
        table: config.toBase58(), live, status: cfg.status === 1 ? "active" : "refunded", maxSeats: cfg.max_seats,
        buyIn: [String(cfg.min_buy_in), String(cfg.max_buy_in)], seatedLedgers: cfg.seated.toString(2), lastSyncTime: new Date(Number(cfg.last_sync_time) * 1000).toISOString(),
        rake: { synced: String(cfg.synced_rake), swept: String(cfg.rake_swept) },
        runtime: rt && { phase: rt.phase, handNo: String(rt.hand_no), occupied: rt.occupied.toString(2), boot: String(rt.boot), button: rt.button, commitSeq: String(rt.commit_seq) },
        vault: t.vault.toBase58(),
      });
      return;
    }
    if (cmd === "check") {
      const { t, cfg } = await readTable(config);
      const v = await base.getAccountInfo(t.vault);
      const rent = BigInt(await base.getMinimumBalanceForRentExemption(v!.data.length));
      let owed = 0n;
      for (let s = 0; s < 6; s++) if ((cfg.seated >> s) & 1) owed += decodeLedger((await base.getAccountInfo(t.ledger(s)))!.data).synced_stack;
      const unswept = cfg.synced_rake - cfg.rake_swept;
      const expected = rent + owed + unswept;
      const tx = new Transaction().add(checkVault(config, cfg.seated, flag("strict")));
      tx.feePayer = signer().publicKey;
      tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
      const sim = await base.simulateTransaction(tx);
      console.log(`vault ${lamports(v!.lamports)}\n  = rent ${rent} + synced stacks ${owed} + unswept rake ${unswept} = ${expected}\n  difference ${BigInt(v!.lamports) - expected}`);
      console.log(`check_vault(strict=${flag("strict")}): ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "OK"}`);
      process.exitCode = sim.value.err ? 1 : 0;
      return;
    }
    if (cmd === "sweep") {
      const g = decodeGlobal((await base.getAccountInfo(globalPda()))!.data);
      const { cfg } = await readTable(config);
      const due = cfg.synced_rake - cfg.rake_swept;
      if (due === 0n) return console.log("nothing to sweep (no synced rake since the last sweep)");
      console.log(`sweeping ${lamports(due)} to treasury ${g.treasury.toBase58()}`);
      await send(base, [sweepRake(signer().publicKey, config, g.treasury)], signer(), "sweep_rake");
      return;
    }
    if (cmd === "open") {
      const kp = signer();
      const { cfg, live } = await readTable(config);
      if (!live) await send(base, [delegateTable(kp.publicKey, config)], kp, "delegate_table");
      const tee = perConnection(dry ? null : (await perLogin(kp, perUrl)).token, perUrl);
      // Wait for PER to see the delegated runtime.
      for (let i = 0; !dry && i < 60; i++) {
        const a = await tee.getAccountInfo(tableAddresses(config).runtime).catch(() => null);
        if (a?.owner.equals(PROGRAM_ID)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      for (const [i, ix] of openTablePer(kp.publicKey, config, cfg.max_seats).entries()) await send(tee, [ix], kp, `PER setup ${i + 1}`, { skipPreflight: true });
      console.log(`table ${config.toBase58()} is live in PER`);
      return;
    }
    if (cmd === "close") {
      const kp = signer();
      const { cfg } = await readTable(config);
      const tee = perConnection(dry ? null : (await perLogin(kp, perUrl)).token, perUrl);
      for (const [i, ix] of closeTablePer(kp.publicKey, config, cfg.max_seats).entries()) {
        await send(tee, [ix], kp, `PER close ${i + 1}`, { skipPreflight: true }).catch((e) => console.log(`  (skipped: ${String(e.message ?? e).slice(0, 80)})`));
      }
      console.log("undelegation requested; the base layer shows it after the commit lands");
      return;
    }
  }
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 18).map((l) => l.slice(3)).join("\n"));
  process.exitCode = 2;
}

function fail(msg: string): never {
  throw new Error(msg);
}

main().catch((e) => {
  console.error("error:", String((e as Error).message ?? e));
  process.exit(1);
});
