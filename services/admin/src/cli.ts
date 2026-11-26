#!/usr/bin/env node
// cf-admin: operator CLI for Card Flex (CF-041). Signs locally with your
// keypair; no server holds keys. Every money rule is enforced by the program:
// this tool can't move player funds (only rake, to the configured treasury).
//
//   cf-admin global show
//   cf-admin global set [--treasury <pk>] [--max-rake-bps N] [--pause | --unpause]
//   cf-admin global sync-authority    settings authority := program upgrade authority (multisig handover, CF-056)
//   cf-admin tables
//   cf-admin token                    PER read token of YOUR key (valid ~30 days). Prefer `table keeper`:
//                                     the keeper then logs in with its own key and no authority
//                                     credential leaves this machine (CF-065).
//   cf-admin table create --boot <lamports> [--rake-bps N] [--rake-cap <lamports>] [--seats 6] [--refund-timeout 1800] [--id N]
//   cf-admin table open <config> [--runtime-reserve 0.05]   delegate to the TEE + create permissions,
//                                     dealer, seat hands, salts; first funds the runtime's reserve
//                                     (it can't be topped up once live)
//   cf-admin table status <config>
//   cf-admin table check <config> [--strict]   reconcile the vault (simulated check_vault + the terms)
//   cf-admin table sweep <config>     rake -> treasury
//   cf-admin table close <config>     close ephemeral accounts and undelegate (one commit)
//   cf-admin table settle <config>    CF-084: sync the last committed state and pay every seat that
//                                     left (permissionless; works on a closed table too)
//   cf-admin table recycle <config>   CF-084: close + open again = a new session with fresh free
//                                     commits (ADR 0007); the keeper does this itself when it
//                                     holds the table authority (CARDFLEX_OPERATOR_KEY)
//   cf-admin table keeper <config> <pubkey|none>   the keeper's own read key (CF-065): a reader of
//                                     the runtime only, never of cards, salts or the seed
//   cf-admin table migrate <config>   grow a runtime made by an older program (1,212 / 1,252 bytes) to
//                                     the current layout (CF-067). Base layer only: a live table made
//                                     before 2026-11-20 can't be migrated; its players leave by
//                                     emergency_refund + claim_refund after the refund timeout.
//   cf-admin table repair <config>    re-create missing dealer / seat hand / salt accounts after
//                                     abort_lost_hand (CF-053); existing ones are left alone
//   cf-admin tee                      our TEE attestation check now: TCB status + measurements (to pin)
//   cf-admin watch [--once] [--every 60] [--tee-every 600] [--authority <pk>] [--webhook <url>]
//                  [--keeper-url <http://host:port/health>] [--keeper <pubkey>]   (CF-060)
//                                     alarms (CF-056): vault short/surplus, refund near/due, claims
//                                     pending, cancel rate; TEE measurements/TCB changed (CF-058). Read-only. --once exits 2 on a critical
//                                     alarm (cron). Webhook also from ALERT_WEBHOOK_URL. See
//                                     docs/runbooks/alarms.md.
//
// Options: --keypair <path> (default ~/.config/cardflex/devnet-deployer.json),
//          --dry-run (print the full instructions, send nothing),
//          --as <pubkey> (with --dry-run: build global set / sync-authority for another
//          signer, e.g. the Squads vault, to propose there; docs/runbooks/multisig.md).
// Env: CARDFLEX_BASE_RPC, CARDFLEX_PER_RPC.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, ENDPOINTS, PROGRAM_ID, TABLE_STATUS, decodeGlobal, decodeLedger, decodeRuntime, decodeTableConfig,
  globalPda, perConnection, perLogin, sizeOf, tableAddresses, magicFeeVault, verifyTee,
  cashOut, delegationRecordPda, syncHand, isProgramError,
} from "@card-flex/client-sdk";
import { sendAndConfirm } from "@card-flex/client-sdk";
import { recycleTable } from "./recycle.ts";
import { checkVault, closeTablePer, createTable, delegateTable, migrateRuntime, openTablePer, setKeeper, sweepRake, syncGlobalAuthority, updateGlobal } from "./admin.ts";
import { keeperAlerts, scan, teeAlerts } from "./watch.ts";
import { parseArgs } from "./args.ts";

const { flag, opt, pos } = parseArgs(process.argv.slice(2));
const dry = flag("dry-run");
const baseUrl = process.env.CARDFLEX_BASE_RPC ?? ENDPOINTS.devnet.base;
const perUrl = process.env.CARDFLEX_PER_RPC ?? ENDPOINTS.devnet.per;
const base = new Connection(baseUrl, "confirmed");
const keyPath = opt("keypair", `${homedir()}/.config/cardflex/devnet-deployer.json`)!;
const signer = () => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
/** Who signs: --as <pubkey> builds for another signer (e.g. a Squads vault) in --dry-run. */
const actor = () => {
  if (!opt("as")) return signer().publicKey;
  if (!dry) throw new Error("--as only builds instructions (--dry-run): we hold no key for it");
  return new PublicKey(opt("as")!);
};
const lamports = (x: bigint | number) => `${x} lamports (◎${(Number(x) / 1e9).toFixed(6)})`;

async function send(conn: Connection, ixs: TransactionInstruction[], kp: Keypair, label: string, { skipPreflight = false } = {}) {
  if (dry) {
    // Full instruction, so it can be proposed to a multisig (Squads) as is.
    for (const ix of ixs) {
      console.log(`[dry-run] ${label}: ${JSON.stringify({
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        dataBase64: Buffer.from(ix.data).toString("base64"),
      })}`);
    }
    return;
  }
  // CF-067: retries through network blips never resend a landed transaction;
  // a program error is final.
  try {
    const sig = await sendAndConfirm(conn, ixs, [kp], { skipPreflight, retries: 2, backoffMs: 1_500 });
    console.log(`✓ ${label}  ${sig}`);
  } catch (e) {
    throw new Error(`${label} failed: ${String((e as Error).message ?? e)}`);
  }
}

async function readTable(config: PublicKey) {
  const t = tableAddresses(config);
  const [c, r] = await base.getMultipleAccountsInfo([config, t.runtime]);
  if (!c) throw new Error(`no table at ${config.toBase58()}`);
  // An older runtime layout (before `migrate_runtime`) doesn't decode; close,
  // settle and migrate don't need it, so it reads as unknown here.
  let rt: ReturnType<typeof decodeRuntime> | null = null;
  try { rt = r ? decodeRuntime(r.data) : null; } catch { console.log(`note: runtime has an older layout (${r?.data.length} bytes); migrate it after closing`); }
  return { t, cfg: decodeTableConfig(c.data), rt, live: !!r?.owner.equals(DELEGATION_PROGRAM_ID) };
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
    await send(base, [updateGlobal(actor(), next)], dry ? Keypair.generate() : signer(), "update_global");
    return;
  }
  if (area === "global" && cmd === "sync-authority") {
    // The signer must be the program's upgrade authority; with a multisig, use
    // --dry-run and propose the printed instruction instead.
    await send(base, [syncGlobalAuthority(actor())], dry ? Keypair.generate() : signer(), "sync_global_authority");
    return;
  }
  if (area === "watch") {
    const authority = opt("authority") ? new PublicKey(opt("authority")!) : signer().publicKey;
    const webhook = opt("webhook") ?? process.env.ALERT_WEBHOOK_URL;
    const every = Number(opt("every", "60")) * 1000;
    const teeEvery = Number(opt("tee-every", "600")) * 1000;
    let teeAt = 0;
    let teeLast: ReturnType<typeof teeAlerts> = [];
    for (;;) {
      const alerts: ReturnType<typeof teeAlerts> = await scan(base, { authority }).catch((e) => [{ level: "critical" as const, code: "WATCH_FAILED", table: "-", detail: String((e as Error).message ?? e).slice(0, 200) }]);
      // CF-058: the TEE check needs PCCS collateral; run it less often, but keep its alarms up.
      if (Date.now() - teeAt >= teeEvery) {
        teeAt = Date.now();
        teeLast = teeAlerts(perUrl, await verifyTee(perUrl).catch((e) => ({ error: String((e as Error).message ?? e) })));
      }
      alerts.push(...teeLast);
      // CF-060: keeper health endpoint and wallet balance.
      const keeperUrl = opt("keeper-url") ?? process.env.KEEPER_HEALTH_URL;
      const keeperPk = opt("keeper") ?? process.env.CARDFLEX_KEEPER_PUBKEY;
      alerts.push(...keeperAlerts({
        url: keeperUrl,
        health: keeperUrl ? await fetch(keeperUrl, { signal: AbortSignal.timeout(10_000) }).then((r) => r.json() as Promise<{ ok: boolean; reasons: string[] }>).catch((e) => ({ error: String((e as Error).message ?? e) })) : undefined,
        keeper: keeperPk,
        balance: keeperPk ? BigInt(await base.getBalance(new PublicKey(keeperPk)).catch(() => Number.MAX_SAFE_INTEGER)) : undefined,
      }));
      const at = new Date().toISOString();
      if (!alerts.length) console.log(`${at} ok: no alarms for ${authority.toBase58()}`);
      for (const a of alerts) console.log(`${at} ${a.level.toUpperCase()} ${a.code} ${a.table} ${a.detail}`);
      if (webhook && alerts.length) {
        await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ at, authority: authority.toBase58(), alerts }) })
          .catch((e) => console.error(`webhook failed: ${String((e as Error).message ?? e)}`));
      }
      if (flag("once")) process.exit(alerts.some((a) => a.level === "critical") ? 2 : 0);
      await new Promise((r) => setTimeout(r, every));
    }
  }
  if (area === "tee") {
    const r = await verifyTee(perUrl);
    console.log(JSON.stringify({ endpoint: perUrl, ok: r.ok, reasons: r.reasons, tcbStatus: r.tcbStatus, advisoryIds: r.advisoryIds, measurements: r.measurements }, null, 2));
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  if (area === "token") {
    const { token, expiresAt } = await perLogin(signer(), perUrl);
    console.log(token);
    console.error(`PER read token for ${signer().publicKey.toBase58()}, valid until ${new Date(expiresAt).toISOString()}. Give it to the keeper as CARDFLEX_PER_TOKEN; it can read, never sign.`);
    return;
  }
  if (area === "tables") {
    const accs = await base.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 8 + sizeOf({ defined: { name: "TableConfig" } }) }] });
    const want = 8 + sizeOf({ defined: { name: "TableRuntime" } });
    const rts: (Awaited<ReturnType<typeof base.getAccountInfo>>)[] = [];
    for (let i = 0; i < accs.length; i += 100) rts.push(...(await base.getMultipleAccountsInfo(accs.slice(i, i + 100).map((a) => tableAddresses(a.pubkey).runtime))));
    let old = 0;
    for (const [i, a] of accs.entries()) {
      const c = decodeTableConfig(a.account.data);
      const r = rts[i];
      const len = r?.data.length ?? 0;
      const layout = !r ? "no runtime" : len === want ? "current" : r.owner.equals(DELEGATION_PROGRAM_ID) ? `OLD ${len} B, live (refund only)` : `OLD ${len} B (cf-admin table migrate)`;
      if (r && len !== want) old++;
      console.log(a.pubkey.toBase58(), `seats ${c.max_seats}`, `seated ${c.seated.toString(2).replace(/0/g, "").length}`, c.status === TABLE_STATUS.ACTIVE ? "active" : "refunded", `buy-in ${c.min_buy_in}-${c.max_buy_in}`, layout);
    }
    console.log(`${accs.length} table(s), ${old} with an old runtime layout`);
    return;
  }
  if (area === "table" && cmd === "create") {
    const kp = signer();
    const p = {
      tableId: BigInt(opt("id", String(Date.now()))!), seats: Number(opt("seats", "6")), boot: BigInt(opt("boot") ?? fail("--boot is required")),
      rakeBps: Number(opt("rake-bps", "0")), rakeCap: BigInt(opt("rake-cap", "0")!), refundTimeoutSecs: Number(opt("refund-timeout", "1800")),
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
      if (!live) {
        // The runtime pays for the table's PER accounts and must keep a
        // margin MagicBlock requires of a commit payer; once delegated it
        // can't be topped up (found in the web E2E: a busy table fell below
        // it and could no longer commit). Fund a reserve before delegating.
        const reserve = BigInt(Math.round(Number(opt("runtime-reserve", "0.05")) * 1e9));
        const ixs = reserve > 0n ? [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: tableAddresses(config).runtime, lamports: reserve })] : [];
        await send(base, [...ixs, delegateTable(kp.publicKey, config)], kp, `delegate_table (+ runtime reserve ${lamports(reserve)})`);
      }
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
      for (const [i, ix] of closeTablePer(kp.publicKey, config, cfg.max_seats, magicFeeVault()).entries()) {
        await send(tee, [ix], kp, `PER close ${i + 1}`, { skipPreflight: true }).catch((e) => console.log(`  (skipped: ${String(e.message ?? e).slice(0, 80)})`));
      }
      console.log("undelegation requested; the base layer shows it after the commit lands");
      return;
    }
    if (cmd === "migrate") {
      const kp = signer();
      const r = await base.getAccountInfo(tableAddresses(config).runtime);
      const want = 8 + sizeOf({ defined: { name: "TableRuntime" } });
      if (!r) return fail("no runtime for this table");
      if (r.data.length === want) return console.log(`runtime already current (${want} bytes)`);
      if (r.owner.equals(DELEGATION_PROGRAM_ID)) return fail("table is live in PER (delegated): can't migrate; players leave by emergency_refund + claim_refund after the refund timeout");
      // Only the config: the runtime has the old layout and can't be decoded yet.
      const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
      await send(base, [migrateRuntime(kp.publicKey, config, cfg.seated)], kp, `migrate_runtime ${r.data.length} -> ${want} bytes (${[0, 1, 2, 3, 4, 5].filter((x) => (cfg.seated >> x) & 1).length} seat ledger(s))`);
      return;
    }
    if (cmd === "keeper") {
      const kp = signer();
      const k = pos[3] ?? fail("usage: cf-admin table keeper <config> <pubkey|none>");
      const keeper = k === "none" ? PublicKey.default : new PublicKey(k);
      const { live, rt } = await readTable(config);
      // A table opened before keeps its permissions in PER: name the keeper while it is live.
      if (!live && rt?.locked) return fail("this table was opened in PER before: run `cf-admin table open` first, then `table keeper` (the permission lives in PER)");
      const ix = setKeeper(kp.publicKey, config, keeper, live);
      if (live) await send(perConnection(dry ? null : (await perLogin(kp, perUrl)).token, perUrl), [ix], kp, "set_keeper (PER)", { skipPreflight: true });
      else await send(base, [ix], kp, "set_keeper");
      console.log(keeper.equals(PublicKey.default) ? "keeper read key cleared" : `keeper ${keeper.toBase58()} can read this table's runtime (start it without CARDFLEX_PER_TOKEN)`);
      return;
    }
    if (cmd === "settle") {
      const kp = signer();
      const t = tableAddresses(config);
      const cfg0 = decodeTableConfig((await base.getAccountInfo(config))!.data);
      try {
        await send(base, [syncHand({ config, delegationRecord: delegationRecordPda(t.runtime), seated: cfg0.seated })], kp, "sync_hand");
      } catch (e) {
        if (!isProgramError(e, "StaleCommit")) throw e;
        console.log("already synced (no newer commit)");
      }
      const cfg = decodeTableConfig((await base.getAccountInfo(config))!.data);
      const seats = [0, 1, 2, 3, 4, 5].filter((s) => (cfg.seated >> s) & 1);
      const infos = await base.getMultipleAccountsInfo(seats.map((s) => t.ledger(s)));
      for (const [i, a] of infos.entries()) {
        const l = a && decodeLedger(a.data);
        if (!l) continue;
        if (!l.left) { console.log(`seat ${seats[i]}: still seated (not paid)`); continue; }
        await send(base, [cashOut({ payer: kp.publicKey, config, seat: seats[i], wallet: l.wallet })], kp, `cash_out seat ${seats[i]}: ${lamports(l.synced_stack)} to ${l.wallet.toBase58()}`);
      }
      return;
    }
    if (cmd === "recycle") {
      if (dry) return fail("recycle has no --dry-run (it waits for the undelegation between steps)");
      await recycleTable({ base, perUrl, authority: signer(), config, log: (m) => console.log(m) });
      return;
    }
    if (cmd === "repair") {
      // CF-053/056: after abort_lost_hand the lost ephemeral accounts must be
      // re-created before the next hand. They are private, so we can't see
      // which are missing: try each open; an existing one fails harmlessly.
      const kp = signer();
      const { cfg, rt } = await readTable(config);
      if (rt && rt.phase !== 0) console.log(`note: committed phase is ${rt.phase}; open_* only works between hands (IDLE)`);
      const tee = perConnection(dry ? null : (await perLogin(kp, perUrl)).token, perUrl);
      const opens = openTablePer(kp.publicKey, config, cfg.max_seats).slice(2); // permissions of runtime + hand log are delegated, not ephemeral
      let made = 0;
      for (const [i, ix] of opens.entries()) {
        const label = i === 0 ? "dealer" : `${i % 2 ? "seat hand" : "salt"} ${Math.floor((i - 1) / 2)}`;
        await send(tee, [ix], kp, `re-create ${label}`, { skipPreflight: true }).then(() => made++).catch((e) => {
          // Re-creating an ephemeral account that still exists fails with
          // InvalidAccountData inside PER (seen on Devnet, CF-056).
          const m = String((e as Error).message ?? e);
          console.log(/InvalidAccountData|already in use/.test(m) ? `  ${label}: exists (left alone)` : `  ${label}: FAILED, retry: ${m.slice(0, 120)}`);
        });
      }
      console.log(`${made} account(s) re-created`);
      return;
    }
  }
  const src = readFileSync(new URL(import.meta.url), "utf8").split("\n");
  const first = src.findIndex((l) => l.startsWith("//")); // after the #! line
  console.log(src.slice(first, src.findIndex((l, i) => i > first && !l.startsWith("//"))).map((l) => l.slice(3)).join("\n"));
  process.exitCode = 2;
}

function fail(msg: string): never {
  throw new Error(msg);
}

main().catch((e) => {
  console.error("error:", String((e as Error).message ?? e));
  process.exit(1);
});
