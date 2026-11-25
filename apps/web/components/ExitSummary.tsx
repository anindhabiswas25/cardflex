// CF-078: when a player's sit-down ends (left and paid, or refunded), what
// went in, what came back, the result, and proof from Solana that the table's
// vault paid it: the transaction that closed the seat ledger, with the vault's
// and the wallet's balance changes read from the chain (not from our API).
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { useEffect, useState } from "react";
import { base } from "@/lib/chain";
import { short } from "@/lib/format";
import type { ExitSummary as Exit } from "@/lib/useTable";
import { Sol } from "./Sol";

/** Exact to the lamport where it matters (up to 6 decimals), so the three numbers always add up. */
const sol = (l: bigint) => { const neg = l < 0n; const v = neg ? -l : l; const whole = v / 1_000_000_000n; const frac = (v % 1_000_000_000n).toString().padStart(9, "0").slice(0, 6).replace(/0+$/, ""); return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`; };
const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";
const explorer = (kind: "tx" | "address", id: string) => `https://explorer.solana.com/${kind}/${id}?cluster=${CLUSTER}`;

type Proof = { sig: string; vaultOut: bigint; walletIn: bigint; time: number | null };

/** The payout transaction: the newest one on the (now closed) ledger whose vault balance fell by `paid`. */
async function findPayout(e: Exit): Promise<Proof | null> {
  const sigs = await base.getSignaturesForAddress(new PublicKey(e.ledger), { limit: 6 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await base.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const v = keys.indexOf(e.vault), w = keys.indexOf(e.wallet);
    if (v < 0 || w < 0) continue;
    const vaultOut = BigInt(tx.meta.preBalances[v] - tx.meta.postBalances[v]);
    const walletIn = BigInt(tx.meta.postBalances[w] - tx.meta.preBalances[w]);
    if (vaultOut === e.paid) return { sig: s.signature, vaultOut, walletIn, time: tx.blockTime ?? null };
  }
  return null;
}

export function ExitSummary({ e, tableName, onClose }: { e: Exit; tableName: string; onClose: () => void }) {
  const [proof, setProof] = useState<Proof | null | undefined>(undefined);
  useEffect(() => {
    let off = false;
    (async () => {
      // The payout can take a moment to be indexed: look a few times.
      for (let i = 0; i < 8 && !off; i++) {
        const p = await findPayout(e).catch(() => null);
        if (p) return setProof(p);
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (!off) setProof(null);
    })();
    return () => { off = true; };
  }, [e]);
  useEffect(() => {
    const esc = (k: KeyboardEvent) => k.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);

  const net = e.paid - e.deposited;
  const won = net > 0n, even = net === 0n;
  const rent = proof && proof.walletIn > e.paid ? proof.walletIn - e.paid : 0n;
  return (
    <div className="xs" role="dialog" aria-modal aria-label="Your session at this table" data-testid="exit-summary">
      <button type="button" className="xs-shade" aria-label="Close" onClick={onClose} />
      <div className="xs-box">
        <span className="xs-eyebrow">You left · {tableName} · seat {e.seat + 1}</span>
        <h2 className={won ? "is-won" : even ? "" : "is-lost"}>
          {won ? "You won" : even ? "You broke even" : "You lost"} <Sol size=".9em" /> {sol(won ? net : -net)}
        </h2>
        <dl className="xs-rows">
          <div><dt>You put in</dt><dd><span className="xs-amt"><Sol /> {sol(e.deposited)}</span><small>buy-in + top-ups</small></dd></div>
          <div><dt>{won ? "Sent to you (with your profit)" : "Returned to you"}</dt><dd data-testid="exit-paid"><span className="xs-amt"><Sol /> {sol(e.paid)}</span></dd></div>
          <div className="xs-net"><dt>Result</dt><dd className={won ? "is-won" : even ? "" : "is-lost"}><span className="xs-amt">{won ? "+" : even ? "" : "−"}<Sol /> {sol(won ? net : -net)}</span><small>after rake</small></dd></div>
        </dl>
        <p className="xs-sent" data-testid="paid"><Sol /> {sol(e.paid)} was sent to your wallet.</p>

        <div className={`xs-proof ${proof ? "is-ok" : proof === null ? "is-warn" : ""}`} data-testid="exit-proof">
          {proof === undefined && (<><span className="xs-spin" /> Checking the payout on Solana…</>)}
          {proof && (
            <>
              <b>✓ Verified on Solana</b>
              <span>
                The table vault <a href={explorer("address", e.vault)} target="_blank" rel="noreferrer">{short(e.vault)}</a> paid <Sol /> {sol(proof.vaultOut)} to your wallet{" "}
                <a href={explorer("address", e.wallet)} target="_blank" rel="noreferrer">{short(e.wallet)}</a>
                {rent > 0n && <> (plus <Sol /> {sol(rent)} back: the rent of your seat record)</>}.
              </span>
              <a className="xs-tx" href={explorer("tx", proof.sig)} target="_blank" rel="noreferrer" data-testid="exit-tx">
                Transaction {short(proof.sig)} ↗
              </a>
            </>
          )}
          {proof === null && (
            <span>
              The payout isn&apos;t indexed yet. Check your wallet&apos;s history on{" "}
              <a href={explorer("address", e.wallet)} target="_blank" rel="noreferrer">Solana Explorer ↗</a>; it shows a transfer from the table vault{" "}
              <a href={explorer("address", e.vault)} target="_blank" rel="noreferrer">{short(e.vault)}</a>.
            </span>
          )}
        </div>

        <div className="xs-actions">
          <Link href="/dashboard" className="xs-ghost">Every hand you played →</Link>
          <button type="button" className="xs-ok" onClick={onClose} data-testid="exit-close">Done</button>
        </div>
      </div>
      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.xs{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:16px}
.xs-shade{position:absolute;inset:0;border:0;background:rgba(6,1,16,.72);backdrop-filter:blur(6px);cursor:default}
.xs-box{position:relative;width:min(460px,100%);display:grid;gap:14px;padding:22px 24px;border-radius:26px;background:linear-gradient(170deg,#2a0b47,#120128);border:1px solid rgba(255,214,102,.4);box-shadow:0 40px 90px rgba(0,0,0,.6);color:#fff;font-family:var(--font-outfit),system-ui,sans-serif;animation:xs-in .45s cubic-bezier(.2,1.3,.4,1) both}
@keyframes xs-in{from{opacity:0;transform:translateY(16px) scale(.94)}}
.xs-eyebrow{font-size:11.5px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#ffd76a}
.xs h2{margin:0;font-size:28px;font-weight:600}
.xs .is-won{color:#5cf09a}.xs .is-lost{color:#ff8a9a}
.xs-rows{display:grid;gap:8px;margin:0}
.xs-rows div{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;border-radius:14px;background:rgba(255,255,255,.05)}
.xs-rows dt{font-size:13.5px;color:rgba(233,221,255,.75)}
.xs-rows dd{margin:0;display:grid;justify-items:end;font-size:16px;font-weight:700}
.xs-amt{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.xs-rows dd small{font-size:10.5px;font-weight:500;color:rgba(233,221,255,.5)}
.xs-net{border:1px solid rgba(255,214,102,.3)}
.xs-sent{margin:0;font-size:12.5px;color:rgba(233,221,255,.7)}
.xs-proof{display:grid;gap:6px;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(6,2,16,.45);font-size:12.5px;line-height:1.45;color:rgba(233,221,255,.8)}
.xs-proof.is-ok{border-color:rgba(47,224,122,.45);background:rgba(47,224,122,.07)}
.xs-proof.is-ok b{color:#5cf09a}
.xs-proof.is-warn{border-color:rgba(255,214,102,.4)}
.xs-proof a{color:#ffd76a}
.xs-tx{font-weight:600}
.xs-spin{display:inline-block;width:12px;height:12px;margin-right:6px;border-radius:50%;border:2px solid rgba(255,214,102,.25);border-top-color:#ffd76a;animation:xs-sp .8s linear infinite;vertical-align:-2px}
@keyframes xs-sp{to{transform:rotate(360deg)}}
.xs-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}
.xs-ghost{font-size:13px;color:rgba(233,221,255,.75) !important}
.xs-ok{height:42px;padding:0 26px;border:0;border-radius:99px;background:#ffe800;color:#140f11;font:700 14px var(--font-outfit),sans-serif;cursor:pointer}
`;
