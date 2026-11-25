"use client";
// Checks one hand in the browser with the same verifier as `cf-verify`
// (Rust compiled to WASM). The record comes from the indexer API, or straight
// from the table's public hand log on Solana (latest hand), or is pasted.
// Styled like the landing page (dark stage, gold accents, the card art).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { dealPositions, handRecordFromHandLog, tableAddresses, type HandRecord, type VerifyReport } from "@card-flex/client-sdk";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { cardArt } from "@/lib/cards";
import { base } from "@/lib/chain";
import { CATEGORY_LABEL, END_REASON, short, sol } from "@/lib/format";
import { LOBBY, metaFor } from "@/lib/lobby";
import { useWallet } from "@/lib/wallet";
import { getVerifier } from "@/lib/useTable";
import { rules } from "@card-flex/client-sdk";
import { Sol } from "./Sol";

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

const HOW = [
  { t: "Fetch", d: "The hand's public record", icon: <Sol size="20px" /> },
  { t: "Rebuild", d: "The deck from salts + VRF", icon: "♠" },
  { t: "Replay", d: "Every bet, payout and rake", icon: "⇅" },
];

export function VerifyHand({ table, hand }: { table?: string; hand?: string }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(table ? undefined : null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [pasted, setPasted] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({ table: table ?? "", hand: hand ?? "" });

  useEffect(() => {
    if (!table || !hand) return;
    let off = false;
    setLoaded(undefined);
    setReport(null);
    setCopied(false);
    fetchRecord(table, hand)
      .then((l) => { if (!off) setLoaded(l); })
      .catch((e) => { if (!off) { setErr(String(e?.message ?? e)); setLoaded(null); } });
    return () => { off = true; };
  }, [table, hand]);

  useEffect(() => {
    if (!showRaw) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setShowRaw(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [showRaw]);

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
  const valid = report?.overall === "VALID";
  const passed = report?.checks.filter((c) => c.status === "VALID").length ?? 0;
  const failed = report?.checks.filter((c) => c.status === "INVALID").length ?? 0;
  const skipped = (report?.checks.length ?? 0) - passed - failed; // e.g. "not provided" in this record

  return (
    <div className={`vf ${table ? "is-result" : "is-index"}`}>
      {/* coins resting in the bottom corners */}
      <img className="vf-coin vf-coin-l" src="/landing/coin-stack.webp" alt="" width={280} height={240} aria-hidden />
      <img className="vf-coin vf-coin-r" src="/landing/coin-pile.webp" alt="" width={400} height={201} aria-hidden />

      {/* ---------- header ---------- */}
      <section className="vf-hero">
        <span className="vf-eyebrow">{hand ? "Checked in your browser" : "Verify a hand"}</span>
        {hand ? (
          <h1>Hand #{hand}</h1>
        ) : (
          <h1>
            <small>EVERY DEAL</small>
            ON THE RECORD
          </h1>
        )}
        <p>
          {table ? (
            <>
              {metaFor(table).name} · <code>{short(table)}</code>
            </>
          ) : (
            "Rebuild the deck. Replay the bets. Right in your browser."
          )}
        </p>
      </section>

      {/* ---------- lookup form ---------- */}
      {!table && (
        <section className="vf-panel">
          <HandPicker />
          <div className="vf-toggles">
            <button type="button" className="vf-toggle" onClick={() => { setShowForm((v) => !v); setShowPaste(false); }} aria-expanded={showForm}>
              {showForm ? "−" : "+"} Enter a table and hand number
            </button>
            <button type="button" className="vf-toggle" onClick={() => { setShowPaste((v) => !v); setShowForm(false); }} aria-expanded={showPaste} data-testid="paste-toggle">
              {showPaste ? "−" : "+"} Paste a hand record
            </button>
          </div>
          {showForm && (
          <form
            className="vf-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (form.table && form.hand) router.push(`/verify/${form.table}/${form.hand}`);
            }}
          >
            <label>
              <span>Table</span>
              <input placeholder="Table address" value={form.table} onChange={(e) => setForm({ ...form, table: e.target.value.trim() })} />
            </label>
            <label className="vf-hand-no">
              <span>Hand</span>
              <input placeholder="#" inputMode="numeric" value={form.hand} onChange={(e) => setForm({ ...form, hand: e.target.value.trim() })} />
            </label>
            <button type="submit" className="vf-btn" disabled={!form.table || !form.hand}>
              <span>✓</span>Check
            </button>
          </form>
          )}
          {showPaste && (
            <div className="vf-paste">
              <textarea placeholder="cf-hand-record/2 JSON (from “Download record” on a hand's page)" value={pasted} onChange={(e) => setPasted(e.target.value)} data-testid="paste-record" />
              <div className="vf-paste-row">
                <button type="button" className="vf-btn vf-btn-ghost" onClick={verifyPasted} disabled={!pasted.trim()} data-testid="verify-pasted">
                  Verify record
                </button>
                <label className="vf-link vf-file">
                  or load a .json file
                  <input type="file" accept="application/json,.json" onChange={(e) => e.target.files?.[0]?.text().then(setPasted)} />
                </label>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------- how it works (until there is a result) ---------- */}
      {!report && loaded !== undefined && (
        <ol className="vf-how">
          {HOW.map((s, i) => (
            <li key={s.t}>
              <span className="vf-ico">{s.icon}</span>
              <em>{String(i + 1).padStart(2, "0")}</em>
              <b>{s.t}</b>
              <small>{s.d}</small>
            </li>
          ))}
        </ol>
      )}

      {loaded === undefined && (
        <div className="vf-loading">
          <span className="vf-spin" />
          Fetching the hand record…
        </div>
      )}
      {table && loaded === null && !err && (
        <p className="vf-msg">
          No record for this hand. The indexer API hasn&apos;t seen it, and the table&apos;s hand log now holds a later hand.
        </p>
      )}
      {err && <p className="vf-msg vf-msg-bad">{err}</p>}

      {/* ---------- result ---------- */}
      {report && rec && (
        <div className="vf-grid">
          <div className="vf-col">
          <section className={`vf-verdict ${valid ? "is-valid" : "is-invalid"}`}>
            <span className="vf-seal" aria-hidden>
              {valid ? "✓" : "✕"}
            </span>
            <div data-testid="verify-overall">
              <small>The hand is</small>
              <strong>{valid ? "VALID" : "INVALID"}</strong>
            </div>
            <div className="vf-verdict-meta">
              <span>{passed} checks passed</span>
              {failed > 0 && <span className="is-bad">{failed} failed</span>}
              {skipped > 0 && <span>{skipped} not in this record</span>}
              <span>from {loaded!.source}</span>
            </div>
          </section>

          <section className="vf-sec">
            <header className="vf-head">
              <span className="vf-eyebrow">The hand</span>
              <div className="vf-chips">
                {END_REASON[rec.game.end_reason] && <span>Ended by {END_REASON[rec.game.end_reason]}</span>}
                <span>Boot <Sol /> {sol(rec.game.boot)}</span>
                <span>Rake <Sol /> {sol(rec.game.rake)}</span>
              </div>
            </header>
            <div className="vf-seats">
              {hands.map(({ seat, cards }) => {
                const k = order.indexOf(seat);
                const won = rec.game.winners.includes(seat);
                // Hand records list payouts and start stacks in dealing order.
                const payout = BigInt(rec.game.payouts[k] ?? "0");
                return (
                  <div key={seat} className={`vf-seat ${won ? "is-won" : ""}`}>
                    {won && <span className="vf-crown">Winner</span>}
                    <div className="vf-fan">
                      {cards.map((c, i) => (
                        <img key={i} src={cardArt(c)} alt="" width={300} height={440} style={{ "--i": i - 1 } as React.CSSProperties} />
                      ))}
                    </div>
                    <b>{CATEGORY_LABEL[rules.categoryOf(cards)]}</b>
                    <span>
                      Seat {seat + 1} · {short(rec.seats[k].wallet)}
                    </span>
                    {won && <em>+<Sol /> {sol(payout)}</em>}
                  </div>
                );
              })}
            </div>
          </section>
          {table && <Actions table={table} />}
          </div>

          <section className="vf-sec vf-col">
            <header className="vf-head">
              <span className="vf-eyebrow">The checks</span>
              <span className="vf-rec-btns">
                <button type="button" className="vf-link vf-raw-btn" onClick={() => setShowRaw(true)}>
                  Raw record ↗
                </button>
                <button type="button" className="vf-link vf-raw-btn" onClick={() => copyRecord(rec).then(() => setCopied(true))} data-testid="copy-record">
                  {copied ? "Copied ✓" : "Copy"}
                </button>
                <button type="button" className="vf-link vf-raw-btn" onClick={() => downloadRecord(rec)} data-testid="download-record">
                  Download record ↓
                </button>
              </span>
            </header>
            <ul className="vf-checks">
              {report.checks.map((c) => (
                <li key={c.name} className={`is-${c.status.toLowerCase()}`}>
                  <span className="vf-dot">{c.status === "VALID" ? "✓" : c.status === "INVALID" ? "✕" : "–"}</span>
                  <div>
                    <b>{c.name}</b>
                    {c.detail && <small title={c.detail}>{c.detail}</small>}
                  </div>
                  <em>{c.status}</em>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      {/* raw record in a pop-up, so it never makes the page scroll */}
      {showRaw && rec && (
        <div className="vf-modal" role="dialog" aria-modal aria-label="Raw hand record">
          <button type="button" className="vf-modal-shade" aria-label="Close" onClick={() => setShowRaw(false)} />
          <div className="vf-modal-box">
            <header>
              <span className="vf-eyebrow">Raw hand record</span>
              <button type="button" className="vf-link vf-raw-btn" onClick={() => downloadRecord(rec)}>
                Download ↓
              </button>
              <button type="button" className="vf-modal-x" aria-label="Close" onClick={() => setShowRaw(false)}>
                ✕
              </button>
            </header>
            <pre>{JSON.stringify(rec, null, 2)}</pre>
          </div>
        </div>
      )}

      {table && !report && <Actions table={table} />}

      <style>{CSS}</style>
    </div>
  );
}

/** The record as players keep it: re-check it here (paste) or offline with `cf-verify <file>`. */
const recordJson = (rec: HandRecord) => JSON.stringify(rec, null, 2);
function downloadRecord(rec: HandRecord) {
  const url = URL.createObjectURL(new Blob([recordJson(rec)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `cardflex-hand-${rec.table.slice(0, 8)}-${rec.hand_no}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
const copyRecord = (rec: HandRecord) => navigator.clipboard.writeText(recordJson(rec));

type PickRow = { table: string; handNo: string; endReason: string; verified: boolean; note: string };
const reason = (r: string) => r.replace(/_/g, " ");

/** Recent hands to pick from: the wallet's own (if connected), or any lobby table's. From the indexer API. */
function HandPicker() {
  const { wallet } = useWallet();
  const me = wallet?.publicKey.toBase58();
  const tabs = [...(me ? [{ id: "me", label: "My hands" }] : []), ...LOBBY.map((t) => ({ id: t.config, label: t.name }))];
  const [tab, setTab] = useState<string | null>(null);
  const active = tab && tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id;
  const [rows, setRows] = useState<PickRow[] | null | undefined>(undefined);
  // Pages, never a scrolling list: as many rows as the screen has room for.
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(5);
  useEffect(() => {
    const fit = () => setPerPage(window.innerWidth < 1000 ? 3 : window.innerHeight < 800 ? 4 : 5);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    if (!active) return;
    let off = false;
    setRows(undefined);
    setPage(0);
    const load: Promise<PickRow[] | null> =
      active === "me"
        ? api.player(me!, 30).then((p) => p && p.recent.map((h) => ({ table: h.table, handNo: h.handNo, endReason: h.endReason, verified: h.verified, note: `${h.won ? "won" : "net"} ${BigInt(h.net) > 0n ? "+" : ""}${sol(h.net)}` })))
        : api.tableHands(active, 30).then((hs) => hs && hs.map((h) => ({ table: h.table, handNo: h.handNo, endReason: h.endReason, verified: h.verified, note: `pot ${sol(h.pot)}` })));
    load.then((r) => { if (!off) setRows(r); });
    return () => { off = true; };
  }, [active, me]);
  return (
    <div className="vf-pick" data-testid="hand-picker">
      <div className="vf-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={t.id === active ? "is-on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {rows === undefined && <p className="vf-pick-note">Loading hands…</p>}
      {rows === null && <p className="vf-pick-note">The hand list comes from our indexer, which isn&apos;t reachable right now. Enter a table and hand below, or paste a record you saved.</p>}
      {rows && !rows.length && <p className="vf-pick-note">{active === "me" ? "No hands played with this wallet yet." : "No hands at this table yet."}</p>}
      {rows && rows.length > 0 && (
        <ul className="vf-pick-list">
          {rows.slice(page * perPage, (page + 1) * perPage).map((h) => (
            <li key={`${h.table}-${h.handNo}`}>
              <Link href={`/verify/${h.table}/${h.handNo}`} data-testid="pick-hand">
                <b>Hand #{h.handNo}</b>
                <span>
                  {metaFor(h.table).name} · {reason(h.endReason)} · <Sol /> {h.note}
                </span>
                <em>{h.verified ? "✓ verified" : "check"} →</em>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {rows && rows.length > perPage && (
        <div className="vf-pager">
          <button type="button" aria-label="Newer hands" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="pick-prev">
            ‹
          </button>
          <span data-testid="pick-range">
            {page * perPage + 1}–{Math.min((page + 1) * perPage, rows.length)} of {rows.length}
          </span>
          <button type="button" aria-label="Older hands" disabled={(page + 1) * perPage >= rows.length} onClick={() => setPage(page + 1)} data-testid="pick-next">
            ›
          </button>
        </div>
      )}
    </div>
  );
}

function Actions({ table }: { table: string }) {
  return (
    <div className="vf-actions">
      <Link href={`/table/${table}`} className="vf-btn">
        <span>▶</span>Back to the table
      </Link>
      <Link href="/verify" className="vf-link">
        Check another hand
      </Link>
    </div>
  );
}

const OUT = "cubic-bezier(.2,.8,.2,1)";
const CSS = `
.vf{--cl:clamp(96px,min(10.5vw,17vh),160px);--cr:clamp(128px,min(14.5vw,22vh),224px);position:relative;z-index:1;margin:0 auto;width:100%;max-width:60rem;padding:0 16px 150px;font-family:var(--font-outfit),system-ui,sans-serif;color:#fff}
/* desktop: everything fits one screen (below the 96px top bar), no scrolling */
@media (min-width:1000px){.vf{display:flex;flex-direction:column;min-height:calc(100dvh - 96px);padding:0 24px 22px}.vf.is-index{justify-content:center;padding-bottom:70px;max-width:min(60rem,calc(100vw - 2 * (var(--cr) + 30px)))}.vf.is-result{max-width:min(76rem,calc(100vw - 2 * (var(--cr) + 30px)))}}
.vf::before{content:"";position:fixed;inset:0;z-index:-2;background:radial-gradient(55% 45% at 50% 0%,rgba(190,70,255,.22),transparent 70%),radial-gradient(40% 35% at 0% 100%,rgba(255,190,60,.10),transparent 70%),radial-gradient(40% 35% at 100% 100%,rgba(255,190,60,.10),transparent 70%),linear-gradient(#140f0e,#120128 70%)}
.vf h1,.vf h2,.vf p{margin:0}
.vf code{font-family:ui-monospace,monospace;font-size:.92em;color:#ffd76a}
.vf-eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:11.5px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:#ffd76a}
.vf-eyebrow::before,.vf-hero .vf-eyebrow::after{content:"";width:28px;height:1px;background:linear-gradient(90deg,transparent,#ffd76a)}
.vf-hero .vf-eyebrow::after{transform:scaleX(-1)}

/* coins in the bottom corners of the screen (decor, behind the content) */
.vf-coin{position:fixed;bottom:14px;z-index:-1;height:auto;pointer-events:none;filter:drop-shadow(0 18px 30px rgba(0,0,0,.55));animation:vf-coin-in .9s ${OUT} .2s both}
.vf-coin-l{left:18px;width:var(--cl)}
.vf-coin-r{right:18px;width:var(--cr);animation-delay:.32s}
@keyframes vf-coin-in{from{opacity:0;transform:translateY(60px)}}
/* narrow screens: no side gutters, so the coins rest at the end of the page instead */
@media (max-width:999px){.vf-coin{position:absolute;bottom:18px}}

/* header */
.vf-hero{display:grid;justify-items:center;gap:14px;margin-top:30px;text-align:center}
.is-result .vf-hero{gap:8px;margin-top:14px}
.vf-hero h1{font-size:clamp(38px,min(6.4vw,8vh),72px);line-height:1;font-weight:500;letter-spacing:-1px}
.vf-hero h1 small{display:block;margin-bottom:8px;font-size:.4em;letter-spacing:4px;color:#ffd76a;font-weight:500}
.vf-hero p{font-size:16px;color:rgba(255,255,255,.7)}

/* framed panel, like the landing page's stage */
.is-result .vf-hero h1{font-size:clamp(32px,min(4vw,5vh),46px);line-height:1.05}
.vf-panel{margin-top:32px;padding:26px;border:6px solid #1d3743;border-radius:40px;background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.01))}
@media (min-width:640px){.vf-panel{padding:34px 38px;border-width:8px;border-radius:52px}}
.vf-form{display:grid;gap:14px}
@media (min-width:700px){.vf-form{grid-template-columns:1fr 130px auto;align-items:end}}
.vf-form label{display:grid;gap:8px}
.vf-form label span{font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(233,221,255,.55)}
.vf input,.vf textarea{width:100%;padding:15px 18px;border-radius:18px;border:1px solid rgba(255,214,102,.22);background:rgba(6,2,16,.55);color:#fff;font:500 15px var(--font-outfit),sans-serif;outline:none;transition:border-color .2s,box-shadow .2s}
.vf input:focus,.vf textarea:focus{border-color:#ffd76a;box-shadow:0 0 0 4px rgba(255,214,102,.12)}
.vf input::placeholder,.vf textarea::placeholder{color:rgba(233,221,255,.35)}
.vf-btn{display:inline-flex;align-items:center;justify-content:center;gap:14px;height:56px;padding:0 26px 0 8px;border:0;border-radius:99px;background:#ffe800;color:#140f11 !important;font:600 15px var(--font-outfit),sans-serif;cursor:pointer;transition:transform .2s,opacity .2s;white-space:nowrap}
.vf-btn:hover:not(:disabled){transform:translateY(-2px)}
.vf-btn:disabled{opacity:.55;cursor:default}
.vf-btn span{display:grid;place-items:center;width:40px;height:40px;border-radius:50%;background:#fff;font-size:14px}
.vf-btn-ghost{padding:0 24px;background:rgba(255,255,255,.08);border:1px solid rgba(255,214,102,.35);color:#fff !important}
.vf-toggle{margin-top:18px;padding:0;border:0;background:none;color:rgba(233,221,255,.65);font:500 13.5px var(--font-outfit),sans-serif;cursor:pointer}
.vf-toggle:hover{color:#fff}
.vf-paste{display:grid;gap:12px;margin-top:14px;animation:vf-rise .4s ${OUT} both}
.vf-paste textarea{height:130px;resize:vertical;font:12.5px ui-monospace,monospace}
.vf-paste .vf-btn{justify-self:start}

/* hand picker */
/* the picker is the start page's content now; the three steps show while a hand loads */
.is-index .vf-how{display:none}
.vf-pick{display:grid;gap:12px}
.vf-tabs{display:flex;flex-wrap:wrap;gap:8px}
.vf-tabs button{height:36px;padding:0 15px;border-radius:99px;border:1px solid rgba(255,214,102,.22);background:rgba(255,255,255,.04);color:rgba(233,221,255,.75);font:500 13.5px var(--font-outfit),sans-serif;cursor:pointer}
.vf-tabs button.is-on{background:#ffe800;border-color:#ffe800;color:#140f11}
.vf-pick-note{padding:12px 4px;font-size:13.5px;color:rgba(233,221,255,.6)}
.vf-pick-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.vf-pick-list a{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;padding:9px 14px;border-radius:15px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03);color:#fff !important;transition:border-color .2s,background .2s}
.vf-pick-list a:hover{border-color:rgba(255,214,102,.45);background:rgba(255,214,102,.06)}
.vf-pick-list b{font-size:14px;font-weight:600}
.vf-pick-list span{min-width:0;font-size:12.5px;color:rgba(233,221,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vf-pick-list em{font-style:normal;font-size:12px;font-weight:600;color:#5cf09a}
@media (max-width:600px){.vf-pick-list a{grid-template-columns:1fr auto;row-gap:2px}.vf-pick-list span{grid-column:1/-1;grid-row:2;white-space:normal}}
.vf-pager{display:flex;align-items:center;justify-content:center;gap:14px;font-size:12.5px;color:rgba(233,221,255,.6)}
.vf-pager button{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,214,102,.4);background:rgba(255,214,102,.06);color:#ffd76a;font:600 18px/1 var(--font-outfit),sans-serif;cursor:pointer;transition:background .2s,opacity .2s}
.vf-pager button:hover:not(:disabled){background:rgba(255,214,102,.16)}
.vf-pager button:disabled{opacity:.3;cursor:default}
.vf-toggles{display:flex;flex-wrap:wrap;gap:10px 26px;margin-top:18px}
.vf-toggles .vf-toggle{margin-top:0}
.vf-toggles + .vf-form{margin-top:16px;animation:vf-rise .4s cubic-bezier(.2,.8,.2,1) both}
.vf-paste-row{display:flex;flex-wrap:wrap;align-items:center;gap:18px}
.vf-file{position:relative;cursor:pointer}
.vf-file input{position:absolute;inset:0;opacity:0;cursor:pointer}
.vf-rec-btns{display:flex;flex-wrap:wrap;gap:16px}

/* how it works */
.vf-how{display:grid;gap:12px;margin:20px 0 0;padding:0;list-style:none}
@media (min-width:700px){.vf-how{grid-template-columns:repeat(3,1fr)}}
.vf-how li{position:relative;display:grid;gap:4px;padding:16px 18px;border-radius:24px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035)}
.vf-how em{position:absolute;right:18px;top:18px;font-style:normal;font-size:12.5px;font-weight:600;color:rgba(255,214,102,.55)}
.vf-how b{margin-top:12px;font-size:17px;font-weight:600}
.vf-how small{font-size:13.5px;color:rgba(233,221,255,.6)}
.vf-ico{display:grid;place-items:center;width:46px;height:46px;border-radius:15px;font-size:19px;color:#ffd76a;border:1.5px solid transparent;background:linear-gradient(160deg,#341257,#1b0733) padding-box,linear-gradient(160deg,#ffe9a3,#c98a12 55%,#6b3d06) border-box}

/* loading + messages */
.vf-loading{display:flex;align-items:center;justify-content:center;gap:14px;margin-top:48px;font-size:15px;color:rgba(233,221,255,.75)}
.vf-spin{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(255,214,102,.25);border-top-color:#ffd76a;animation:vf-spin .8s linear infinite}
@keyframes vf-spin{to{transform:rotate(360deg)}}
.vf-msg{margin-top:28px;padding:18px 22px;border-radius:20px;border:1px solid rgba(255,214,102,.3);background:rgba(255,214,102,.06);font-size:14.5px;line-height:1.5;color:#ffe9a3;text-align:center}
.vf-msg-bad{border-color:rgba(255,90,110,.4);background:rgba(255,90,110,.08);color:#ffb3bf}

/* verdict */
.vf-verdict{position:relative;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:18px;padding:18px 24px;border-radius:30px;overflow:hidden;animation:vf-rise .6s ${OUT} both}
@media (min-width:700px){.vf-verdict{grid-template-columns:auto 1fr auto}}
.vf-verdict.is-valid{border:1.5px solid rgba(47,224,122,.5);background:radial-gradient(70% 120% at 0% 50%,rgba(47,224,122,.2),transparent 70%),rgba(255,255,255,.03)}
.vf-verdict.is-invalid{border:1.5px solid rgba(255,90,110,.55);background:radial-gradient(70% 120% at 0% 50%,rgba(255,90,110,.22),transparent 70%),rgba(255,255,255,.03)}
.vf-seal{display:grid;place-items:center;width:68px;height:68px;border-radius:50%;font-size:31px;font-weight:700;animation:vf-pop .7s ${OUT} .15s both}
.is-valid .vf-seal{color:#0a2e17;background:radial-gradient(circle at 35% 30%,#8dffc0,#2fe07a 60%,#14a24f);box-shadow:0 0 0 6px rgba(47,224,122,.18),0 0 40px rgba(47,224,122,.45)}
.is-invalid .vf-seal{color:#3a0610;background:radial-gradient(circle at 35% 30%,#ffb3bf,#ff5a6e 60%,#c22b40);box-shadow:0 0 0 6px rgba(255,90,110,.18),0 0 40px rgba(255,90,110,.45)}
@keyframes vf-pop{from{transform:scale(.4);opacity:0}60%{transform:scale(1.08)}}
.vf-verdict small{display:block;font-size:12px;font-weight:600;letter-spacing:2.5px;text-transform:uppercase;color:rgba(233,221,255,.6)}
.vf-verdict strong{display:block;font-size:clamp(36px,4.4vw,48px);line-height:1.05;font-weight:600;letter-spacing:1px}
.is-valid strong{color:#5cf09a}
.is-invalid strong{color:#ff7d8d}
.vf-verdict-meta{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px}
@media (min-width:700px){.vf-verdict-meta{grid-column:auto;flex-direction:column;align-items:flex-end}}
.vf-verdict-meta{gap:6px}
.vf-verdict-meta span{padding:4px 11px;border-radius:99px;background:rgba(255,255,255,.07);font-size:11.5px;color:rgba(233,221,255,.75)}
.vf-verdict-meta span.is-bad{background:rgba(255,90,110,.2);color:#ffb3bf}

/* sections */
.vf-sec{margin-top:22px;animation:vf-rise .6s ${OUT} .1s both}
/* result: verdict + hand on the left, the checks on the right */
.vf-grid{display:grid;gap:22px;margin-top:22px}
@media (min-width:1000px){.vf-grid{grid-template-columns:1.1fr 1fr;align-items:start}.vf-grid > .vf-sec{margin-top:0}}
.vf-col{min-width:0}
.vf-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.vf-chips{display:flex;flex-wrap:wrap;gap:8px}
.vf-chips span{padding:7px 13px;border-radius:99px;border:1px solid rgba(255,214,102,.22);font-size:12.5px;color:rgba(233,221,255,.8)}

/* seats */
.vf-seats{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(132px,1fr))}
.vf-seat{position:relative;display:grid;justify-items:center;gap:3px;padding:40px 10px 14px;border-radius:26px;text-align:center;border:1px solid rgba(255,255,255,.08);background:linear-gradient(160deg,rgba(255,255,255,.05),rgba(255,255,255,.012));transition:border-color .3s,transform .3s ${OUT}}
.vf-seat:hover{border-color:rgba(255,214,102,.4);transform:translateY(-3px)}
.vf-seat.is-won{border-color:rgba(255,214,102,.55);background:radial-gradient(120% 70% at 50% 0%,rgba(255,196,60,.2),transparent 70%),linear-gradient(160deg,rgba(255,255,255,.06),rgba(255,255,255,.02))}
.vf-crown{position:absolute;top:13px;left:50%;transform:translateX(-50%);padding:4px 10px;border-radius:99px;background:#ffe800;color:#140f11;font-size:10.5px;font-weight:600;letter-spacing:1px;text-transform:uppercase}
.vf-fan{display:flex;justify-content:center;height:84px;margin-bottom:8px;--w:56px}
.vf-fan img{width:var(--w);height:auto;margin:0 calc(var(--w) * -.18);transform:rotate(calc(var(--i) * 9deg)) translateY(calc(var(--i) * var(--i) * 3px));transform-origin:50% 90%;filter:drop-shadow(0 8px 12px rgba(0,0,0,.5));transition:transform .45s ${OUT}}
.vf-seat:hover .vf-fan img{transform:rotate(calc(var(--i) * 14deg)) translate(calc(var(--i) * 9px),calc(var(--i) * var(--i) * 4px - 4px))}
.vf-seat b{font-size:15.5px;font-weight:600}
.vf-seat span{font-size:12.5px;color:rgba(233,221,255,.55)}
.vf-seat .vf-crown{font-size:10.5px;color:#140f11}
.vf-seat em{font-style:normal;font-size:15px;font-weight:600;color:#ffe800}

/* checks */
.vf-checks{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.vf-checks li{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;padding:6px 14px;line-height:1.25;border-radius:15px;border:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.03)}
.vf-checks b{display:block;font-size:13.5px;font-weight:500}
.vf-checks li > div{min-width:0}
.vf-checks small{display:block;margin-top:1px;font-size:11.5px;color:rgba(233,221,255,.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vf-dot{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;font-size:13px;font-weight:700;background:rgba(255,255,255,.1);color:rgba(233,221,255,.7)}
.vf-checks .is-valid .vf-dot{background:rgba(47,224,122,.18);color:#5cf09a}
.vf-checks .is-invalid .vf-dot{background:rgba(255,90,110,.2);color:#ff7d8d}
.vf-checks em{font-style:normal;font-size:11px;font-weight:600;letter-spacing:1px;color:rgba(233,221,255,.5)}
.vf-checks .is-valid em{color:#5cf09a}
.vf-checks .is-invalid em{color:#ff7d8d}
.vf-raw-btn{padding:0;border:0;background:none;cursor:pointer;font:500 13px var(--font-outfit),sans-serif}
.vf-modal{position:fixed;inset:0;z-index:70;display:grid;place-items:center;padding:20px}
.vf-modal-shade{position:absolute;inset:0;border:0;background:rgba(6,1,16,.7);backdrop-filter:blur(6px);cursor:default;animation:vf-fade .25s both}
.vf-modal-box{position:relative;width:min(760px,100%);max-height:min(80vh,720px);display:flex;flex-direction:column;padding:20px 22px;border-radius:28px;background:linear-gradient(170deg,#2a0b47,#120128);border:1px solid rgba(255,214,102,.35);box-shadow:0 40px 90px rgba(0,0,0,.6);animation:vf-rise .35s ${OUT} both}
.vf-modal-box header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.vf-modal-x{width:36px;height:36px;border-radius:50%;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;cursor:pointer}
.vf-modal-box pre{margin:0;overflow:auto;padding:16px 22px 16px 16px;border-radius:18px;background:rgba(6,2,16,.6);font-size:11.5px;color:rgba(233,221,255,.8)}
/* a slim pearl bar inside the card instead of the system scrollbar */
.vf-modal-box pre::-webkit-scrollbar{width:14px;height:14px}
.vf-modal-box pre::-webkit-scrollbar-button{display:none}
.vf-modal-box pre::-webkit-scrollbar-track{margin:14px 0;background:transparent}
.vf-modal-box pre::-webkit-scrollbar-corner{background:transparent}
.vf-modal-box pre::-webkit-scrollbar-thumb{border:4px solid transparent;border-radius:99px;background:linear-gradient(180deg,#fffaf0,#efe3f7 35%,#dcebf3 65%,#f5e7cf) padding-box;box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
.vf-modal-box pre::-webkit-scrollbar-thumb:hover{background:linear-gradient(180deg,#ffffff,#f4eafb 35%,#e4f2f8 65%,#fbefd9) padding-box}
@supports (-moz-appearance:none){.vf-modal-box pre{scrollbar-width:thin;scrollbar-color:#eadff3 transparent}}
@keyframes vf-fade{from{opacity:0}}

/* actions */
.vf-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:24px;margin-top:26px}
.vf-col .vf-actions{justify-content:flex-start;margin-top:20px}
.vf-actions .vf-btn{height:50px}
.vf-actions .vf-btn span{width:36px;height:36px}
.vf-link{font-size:14px;font-weight:500;color:rgba(255,255,255,.7) !important}
.vf-link:hover{color:#fff !important}
@media (min-width:1000px) and (max-height:760px){.vf-hero{margin-top:10px}.vf-panel{margin-top:20px;padding:22px 30px}.vf-how small{display:none}.vf-how li{padding:12px 16px}}
@media (min-width:1000px) and (max-height:740px){.is-result .vf-hero .vf-eyebrow{display:none}}
/* phones: the start page fits one screen too (steps hidden, coins tucked under the form) */
@media (max-width:999px){.vf.is-index{display:flex;flex-direction:column;justify-content:center;min-height:calc(100dvh - 90px);padding-bottom:130px}.is-index .vf-how{display:none}.is-index .vf-hero{margin-top:8px}.is-index .vf-panel{margin-top:22px;padding:20px}}
/* short laptop screens (e.g. 1366x768): tighten so the result still fits */
@media (min-width:1000px) and (max-height:820px){.is-result .vf-hero{margin-top:4px}.vf-grid{margin-top:14px}.vf-checks{gap:4px}.vf-checks li{padding:4px 14px}.vf-head{margin-bottom:10px}.vf-sec{margin-top:16px}}
@keyframes vf-rise{from{opacity:0;transform:translateY(18px)}}
@media (prefers-reduced-motion:reduce){.vf *{animation:none !important;transition:none !important}}
`;
