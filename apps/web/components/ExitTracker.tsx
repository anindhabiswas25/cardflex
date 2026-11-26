"use client";
// After "Leave table" the player lands on the Boards page right away. This
// popup follows the money for each sit-down they left (lib/exits): the keeper
// commits the table, syncs the final stack to the seat ledger and pays it from
// the vault. While that runs it shows the expected result; once the ledger is
// closed it becomes the full summary (ExitSummary) with the payout proven from
// the chain.
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { decodeLedger, tableAddresses } from "@card-flex/client-sdk";
import { base } from "@/lib/chain";
import { dropExit, exitsFor, type PendingExit } from "@/lib/exits";
import { dropSession } from "@/lib/session";
import { sol } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { LOBBY } from "@/lib/lobby";
import type { ExitSummary as Exit } from "@/lib/useTable";
import { ExitSummary } from "./ExitSummary";
import { Sol } from "./Sol";

const POLL_MS = 3_000;
/** After this long without a payout, explain that it's waiting on the table's sync. */
const SLOW_MS = 120_000;

type State =
  | { kind: "settling" } // ledger still open, final stack not synced yet
  | { kind: "paying"; amount: bigint } // synced (ledger.left); cash_out next
  | { kind: "paid"; exit: Exit };

/** The cash_out that closed the ledger: newest successful tx on it where the vault paid the wallet. */
async function payoutOf(ledger: string, vault: string, wallet: string): Promise<bigint | null> {
  const sigs = await base.getSignaturesForAddress(new PublicKey(ledger), { limit: 6 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await base.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const v = keys.indexOf(vault), w = keys.indexOf(wallet);
    if (v < 0 || w < 0) continue;
    const out = BigInt(tx.meta.preBalances[v] - tx.meta.postBalances[v]);
    if (out > 0n) return out;
  }
  return null;
}

export function ExitTracker() {
  const { wallet } = useWallet();
  const me = wallet?.publicKey.toBase58() ?? null;
  const [recs, setRecs] = useState<PendingExit[]>([]);
  useEffect(() => {
    const load = () => setRecs(exitsFor(me));
    load();
    window.addEventListener("cf:exits", load);
    return () => window.removeEventListener("cf:exits", load);
  }, [me]);
  // One popup at a time: the oldest exit first.
  const rec = recs.slice().sort((a, b) => a.at - b.at)[0];
  return rec ? <Tracked key={`${rec.config}:${rec.epoch}`} rec={rec} /> : null;
}

function Tracked({ rec }: { rec: PendingExit }) {
  const [st, setSt] = useState<State>({ kind: "settling" });
  const [now, setNow] = useState(() => Date.now());
  const [hidden, setHidden] = useState(false);
  const config = new PublicKey(rec.config);
  const a = tableAddresses(config);
  const ledgerAddr = a.ledger(rec.seat).toBase58();
  const vault = a.vault.toBase58();

  const lastLeft = useRef<bigint | null>(null);
  const done = useRef(false);
  useEffect(() => {
    let off = false;
    const tick = async () => {
      if (done.current) return;
      try {
        const info = await base.getAccountInfo(a.ledger(rec.seat), "confirmed");
        const l = info ? decodeLedger(info.data) : null;
        if (off) return;
        if (l && l.epoch === rec.epoch) {
          if (l.left) { lastLeft.current = l.synced_stack; setSt({ kind: "paying", amount: l.synced_stack }); }
          else setSt({ kind: "settling" });
          return;
        }
        // Ledger closed (or the seat already reused): paid. Read the amount from the payout itself.
        const paid = (await payoutOf(ledgerAddr, vault, rec.wallet).catch(() => null)) ?? lastLeft.current ?? BigInt(rec.stack);
        if (off) return;
        done.current = true;
        setSt({ kind: "paid", exit: { seat: rec.seat, deposited: BigInt(rec.deposited), paid, ledger: ledgerAddr, vault, wallet: rec.wallet } });
        dropSession(rec.config, rec.wallet);
      } catch { /* network blip: next poll */ }
    };
    tick();
    const id = setInterval(() => { tick(); setNow(Date.now()); }, POLL_MS);
    return () => { off = true; clearInterval(id); };
  }, [rec.config, rec.seat, rec.epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => dropExit(rec.config, rec.wallet);
  const name = rec.name || LOBBY.find((m) => m.config === rec.config)?.name || "the table";
  const session = rec.reason === "session";
  const again = `/table/${rec.config}`;
  if (st.kind === "paid") return <ExitSummary e={st.exit} tableName={name} onClose={close} again={again} sessionEnded={session} />;
  if (hidden) {
    return (
      <button className="xt-chip" onClick={() => setHidden(false)} data-testid="exit-pending-chip">
        <span className="xt-spin" /> Paying out {name}…
        <style>{CSS}</style>
      </button>
    );
  }

  const expect = st.kind === "paying" ? st.amount : BigInt(rec.stack);
  const net = expect - BigInt(rec.deposited);
  const slow = now - rec.at > SLOW_MS;
  return (
    <div className="xt" role="dialog" aria-modal aria-label="Leaving the table" data-testid="exit-pending">
      <button type="button" className="xt-shade" aria-label="Hide" onClick={() => setHidden(true)} />
      <div className="xt-box">
        <span className="xt-eyebrow">{session ? "Session ended" : "You left"} · {name} · seat {rec.seat + 1}</span>
        {session && (
          <p className="xt-note is-info">
            This table plays in sessions of about 20 hands (MagicBlock&apos;s free commits). Everyone was paid out and the
            table is starting a fresh session: sit down again in a moment.
          </p>
        )}
        <h2 className={net > 0n ? "is-won" : net < 0n ? "is-lost" : ""}>
          {net > 0n ? "You're up" : net < 0n ? "You're down" : "Even"} <Sol size=".9em" /> {sol(net < 0n ? -net : net)}
        </h2>
        <dl className="xt-rows">
          <div><dt>You put in</dt><dd><Sol /> {sol(BigInt(rec.deposited))}</dd></div>
          <div><dt>{st.kind === "paying" ? "Final stack (synced)" : "Your stack when you left"}</dt><dd><Sol /> {sol(expect)}</dd></div>
        </dl>
        <ol className="xt-steps">
          <li className="is-done">Left the table</li>
          <li className={st.kind === "paying" ? "is-done" : "is-on"}>Final stack synced to Solana</li>
          <li className={st.kind === "paying" ? "is-on" : ""}>Paid from the table vault to your wallet</li>
        </ol>
        {slow && st.kind === "settling" && (
          <p className="xt-note">
            Still waiting for the table to sync. Your chips are safe in the table vault; the keeper finishes this when it
            next commits the table. If the table stays stuck past its refund timeout, the table page offers a refund.
          </p>
        )}
        <div className="xt-actions">
          <Link href={again} className="xt-ghost">{session ? "Play again →" : "Open the table"}</Link>
          <button type="button" className="xt-ok" onClick={() => setHidden(true)}>Keep browsing</button>
        </div>
      </div>
      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.xt{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:16px}
.xt-shade{position:absolute;inset:0;border:0;background:rgba(6,1,16,.72);backdrop-filter:blur(6px);cursor:default}
.xt-box{position:relative;width:min(440px,100%);display:grid;gap:14px;padding:22px 24px;border-radius:26px;background:linear-gradient(170deg,#2a0b47,#120128);border:1px solid rgba(255,214,102,.4);box-shadow:0 40px 90px rgba(0,0,0,.6);color:#fff;font-family:var(--font-outfit),system-ui,sans-serif;animation:xt-in .45s cubic-bezier(.2,1.3,.4,1) both}
@keyframes xt-in{from{opacity:0;transform:translateY(16px) scale(.94)}}
.xt-eyebrow{font-size:11.5px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#ffd76a}
.xt h2{margin:0;font-size:26px;font-weight:600;display:flex;align-items:center;gap:6px}
.xt .is-won{color:#5cf09a}.xt .is-lost{color:#ff8a9a}
.xt-rows{display:grid;gap:8px;margin:0}
.xt-rows div{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;border-radius:14px;background:rgba(255,255,255,.05)}
.xt-rows dt{font-size:13.5px;color:rgba(233,221,255,.75)}
.xt-rows dd{margin:0;display:inline-flex;align-items:center;gap:5px;font-size:16px;font-weight:700}
.xt-steps{display:grid;gap:6px;margin:0;padding:0;list-style:none;font-size:13px;color:rgba(233,221,255,.5)}
.xt-steps li{display:flex;align-items:center;gap:8px}
.xt-steps li::before{content:"";width:10px;height:10px;border-radius:50%;border:2px solid rgba(233,221,255,.3)}
.xt-steps li.is-done{color:#c8f7a0}.xt-steps li.is-done::before{background:#5cf09a;border-color:#5cf09a}
.xt-steps li.is-on{color:#fff}.xt-steps li.is-on::before{border-color:#ffd76a;border-top-color:transparent;animation:xt-sp .8s linear infinite}
.xt-note{margin:0;padding:10px 12px;border-radius:12px;border:1px solid rgba(255,214,102,.35);font-size:12.5px;line-height:1.45;color:rgba(233,221,255,.8)}
.xt-note.is-info{border-color:rgba(201,139,255,.4)}
.xt-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}
.xt-ghost{font-size:13px;color:rgba(233,221,255,.75) !important}
.xt-ok{height:42px;padding:0 24px;border:0;border-radius:99px;background:#ffe800;color:#140f11;font:700 14px var(--font-outfit),sans-serif;cursor:pointer}
.xt-chip{position:fixed;right:16px;bottom:16px;z-index:70;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border-radius:99px;border:1px solid rgba(255,214,102,.45);background:rgba(18,1,40,.92);color:#ffe9a3;font:600 13px var(--font-outfit),sans-serif;cursor:pointer}
.xt-spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,214,102,.25);border-top-color:#ffd76a;animation:xt-sp .8s linear infinite}
@keyframes xt-sp{to{transform:rotate(360deg)}}
`;
