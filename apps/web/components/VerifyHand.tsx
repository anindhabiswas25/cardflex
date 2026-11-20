"use client";
// Checks one hand in the browser with the same verifier as `cf-verify`
// (Rust compiled to WASM). The record comes from the indexer API, or straight
// from the table's public hand log on Solana (latest hand), or is pasted.
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { dealPositions, handRecordFromHandLog, tableAddresses, type HandRecord, type VerifyReport } from "@card-flex/client-sdk";
import { useEffect, useState } from "react";
import { PlayingCard } from "./PlayingCard";
import { api } from "@/lib/api";
import { base } from "@/lib/chain";
import { CATEGORY_LABEL, END_REASON, short, sol } from "@/lib/format";
import { metaFor } from "@/lib/lobby";
import { getVerifier } from "@/lib/useTable";
import { rules } from "@card-flex/client-sdk";

type Loaded = { record: HandRecord; source: string };

async function fetchRecord(table: string, hand: string): Promise<Loaded | null> {
  const fromApi = await api.hand(table, hand);
  if (fromApi?.record) return { record: fromApi.record as HandRecord, source: "indexer API" };
  // The table's hand log on Solana holds the latest revealed hand.
  const t = tableAddresses(new PublicKey(table));
  const a = await base.getAccountInfo(t.handLog);
  const rec = a && handRecordFromHandLog(Uint8Array.from(a.data));
  if (rec && rec.hand_no === hand) return { record: rec, source: "the table's hand log on Solana" };
  return null;
}

export function VerifyHand({ table, hand }: { table?: string; hand?: string }) {
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(table ? undefined : null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [pasted, setPasted] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ table: table ?? "", hand: hand ?? "" });

  useEffect(() => {
    if (!table || !hand) return;
    let off = false;
    setLoaded(undefined);
    setReport(null);
    fetchRecord(table, hand)
      .then((l) => { if (!off) setLoaded(l); })
      .catch((e) => { if (!off) { setErr(String(e?.message ?? e)); setLoaded(null); } });
    return () => { off = true; };
  }, [table, hand]);

  useEffect(() => {
    if (!loaded) return;
    getVerifier().then((v) => setReport(v.verify(loaded.record))).catch((e) => setErr(`Verifier failed to load: ${e?.message ?? e}`));
  }, [loaded]);

  function verifyPasted() {
    setErr(null);
    try {
      const record = JSON.parse(pasted) as HandRecord;
      setLoaded({ record, source: "pasted record" });
    } catch {
      setErr("That isn't valid JSON.");
    }
  }

  const rec = loaded?.record;
  const order = rec?.seats.map((s) => s.seat) ?? [];
  const hands = report?.deck && rec ? order.map((seat, k) => ({ seat, cards: dealPositions(k, order.length).map((p) => report.deck![p]) })) : [];
  return (
    <div className="glass rounded-3xl p-6 sm:p-8">
      <h1 className="font-[family-name:var(--font-display)] text-3xl">{hand ? `Verify hand #${hand}` : "Verify a hand"}</h1>
      {table && <p className="mt-1 text-sm text-violet-300">{metaFor(table).name} · {short(table)} · checked in your browser by the same verifier as <code>cf-verify</code> (WASM)</p>}

      {!table && (
        <div className="mt-5 grid gap-3">
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto]">
            <input className="rounded-xl bg-black/30 px-3 py-2 text-sm ring-1 ring-violet-400/30" placeholder="Table address" value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value.trim() })} />
            <input className="rounded-xl bg-black/30 px-3 py-2 text-sm ring-1 ring-violet-400/30" placeholder="Hand #" value={form.hand} onChange={(e) => setForm({ ...form, hand: e.target.value.trim() })} />
            <Link className="btn btn-lime text-sm" href={form.table && form.hand ? `/verify/${form.table}/${form.hand}` : "/verify"}>Check</Link>
          </div>
          <p className="text-xs text-violet-300">…or paste a hand record (<code>cf-hand-record/2</code> JSON):</p>
          <textarea className="h-28 rounded-xl bg-black/30 p-3 font-mono text-xs ring-1 ring-violet-400/30" value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <button className="btn btn-violet w-fit text-sm" onClick={verifyPasted} disabled={!pasted.trim()}>Verify pasted record</button>
        </div>
      )}

      {loaded === undefined && <p className="mt-6 text-violet-200">Fetching the hand record…</p>}
      {table && loaded === null && (
        <p className="mt-6 text-amber-200">
          No record for this hand: the indexer API isn&apos;t reachable or hasn&apos;t seen it, and the table&apos;s hand log on Solana now holds a later hand. Run the API (<code>pnpm api</code>) to keep every hand.
        </p>
      )}
      {err && <p className="mt-4 text-rose-300">{err}</p>}

      {report && rec && (
        <>
          <div className={`mt-6 flex items-center justify-between rounded-2xl px-4 py-3 ${report.overall === "VALID" ? "bg-lime-500/15" : "bg-rose-500/20"}`} data-testid="verify-overall">
            <span className="font-[family-name:var(--font-display)] text-2xl">{report.overall === "VALID" ? "Hand is VALID" : "Hand is INVALID"}</span>
            <span className="text-xs text-violet-200">source: {loaded!.source}</span>
          </div>
          <ul className="mt-4 divide-y divide-violet-400/15">
            {report.checks.map((c) => (
              <li key={c.name} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <span>
                  {c.name}
                  {c.detail && <span className="block text-xs text-violet-300">{c.detail}</span>}
                </span>
                <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-black ${c.status === "VALID" ? "bg-lime-500/15 text-lime-300" : c.status === "INVALID" ? "bg-rose-500/20 text-rose-300" : "bg-white/10 text-violet-200"}`}>{c.status}</span>
              </li>
            ))}
          </ul>

          <h2 className="mt-8 font-[family-name:var(--font-display)] text-2xl">The hand</h2>
          <p className="text-sm text-violet-300">
            {END_REASON[rec.game.end_reason] ? `Ended by ${END_REASON[rec.game.end_reason]}` : ""} · boot ◎{sol(rec.game.boot)} · rake ◎{sol(rec.game.rake)}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {hands.map(({ seat, cards }) => {
              const k = order.indexOf(seat);
              const won = rec.game.winners.includes(seat);
              // Hand records list payouts and start stacks in dealing order.
              const payout = BigInt(rec.game.payouts[k] ?? "0");
              const start = BigInt(rec.game.start_stacks[k] ?? "0");
              return (
                <div key={seat} className={`rounded-2xl p-3 ring-1 ${won ? "bg-amber-400/10 ring-amber-300/50" : "bg-black/20 ring-violet-400/20"}`}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-extrabold">Seat {seat + 1} · {short(rec.seats[k].wallet)}</span>
                    {won && <span className="font-black text-amber-300">won ◎{sol(payout)}</span>}
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="flex">{cards.map((c, i) => <PlayingCard key={i} id={c} width="2.6rem" rotate={(i - 1) * 8} className={i ? "-ml-3" : ""} />)}</div>
                    <span className="text-sm text-violet-200">{CATEGORY_LABEL[rules.categoryOf(cards)]}{start ? ` · started ◎${sol(start)}` : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <details className="mt-6 text-xs text-violet-300">
            <summary className="cursor-pointer">Raw hand record</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-black/40 p-3">{JSON.stringify(rec, null, 2)}</pre>
          </details>
        </>
      )}
      {table && <Link href={`/table/${table}`} className="btn btn-lime mt-6">Back to the table</Link>}
    </div>
  );
}
