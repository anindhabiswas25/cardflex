#!/usr/bin/env node
// CF-013 step 4: validator restart drill on the LOCAL MagicBlock stack.
//
//   phase "before": table delegated, ephemeral hands + salts with permissions,
//                   hand started, 2 of 3 salts in (mid-hand). Saves state.
//   (the caller kills and restarts the ephemeral validator)
//   phase "after":  checks the same state survived, then continues the hand
//                   (last salt, test-deck deal) without any redeal.
//
// Usage (see scripts/restart-drill.sh):
//   CARDFLEX_BASE_RPC=http://127.0.0.1:8899 CARDFLEX_TEE_RPC=http://127.0.0.1:6699 \
//   CARDFLEX_TEE_WS=ws://127.0.0.1:6700 CARDFLEX_VALIDATOR=mAGic… CARDFLEX_DEVNET_KEYPAIR=<local payer> \
//   node src/restart.mjs --phase before|after --state <file>

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { permissionPdaFromAccount, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID, BASE_RPC, repoRoot, loadDiscriminators, makeIx, send, rejected, tokenFor, teeConn, waitFor, log, w, r, u8, RT, PHASE, HAND,
  NO_FEE_VAULT,
} from "./common.mjs";
import { setupTable } from "./table.mjs";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const phaseArg = arg("phase");
const stateFile = arg("state");
if (!["before", "after"].includes(phaseArg) || !stateFile) { console.error("usage: --phase before|after --state <file>"); process.exit(2); }

const kp = (arr) => Keypair.fromSecretKey(Uint8Array.from(arr));
const out = { phase: phaseArg, checks: [] };
const check = (name, expected, actual, note) => {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  out.checks.push({ name, expected, actual, pass, ...(note ? { note } : {}) });
  if (!pass) log(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

try {
  if (phaseArg === "before") {
    const t = await setupTable({ seats: 3 });
    const { ix, tee, authority, players, config, runtime, saltAccs } = t;
    await send(tee, [ix("start_hand", [r(authority.publicKey, true), r(config), w(runtime)])], [authority], { skipPreflight: true });
    const salts = players.map(() => randomBytes(32));
    for (const s of [0, 1]) {
      await send(tee, [ix("submit_salt", [r(players[s].session.publicKey, true), w(runtime), w(saltAccs[s])], Buffer.concat([u8(s), salts[s]]))], [players[s].session], { skipPreflight: true });
    }
    const rt = (await tee.getAccountInfo(runtime)).data;
    check("before: phase SALTS_PENDING with 2 salts in", [PHASE.SALTS_PENDING, 0b011], [rt[RT.phase], rt[RT.salts_in]]);
    const snapshot = {
      hand_ctx: rt.subarray(RT.hand_ctx, RT.hand_ctx + 32).toString("hex"),
      commitments: rt.subarray(RT.salt_commitments, RT.salt_commitments + 96).toString("hex"),
      hand_no: rt.readBigUInt64LE(RT.hand_no).toString(),
    };
    writeFileSync(stateFile, JSON.stringify({
      authority: [...authority.secretKey],
      players: players.map((p) => ({ wallet: [...p.wallet.secretKey], session: [...p.session.secretKey] })),
      config: config.toBase58(), runtime: runtime.toBase58(), handLog: t.handLog.toBase58(), dealer: t.dealer.toBase58(),
      hands: t.hands.map(String), saltAccs: saltAccs.map(String), salt2: salts[2].toString("hex"), snapshot,
    }));
    out.snapshot = snapshot;
  } else {
    const st = JSON.parse(readFileSync(stateFile, "utf8"));
    const ix = makeIx(loadDiscriminators());
    const authority = kp(st.authority);
    const players = st.players.map((p) => ({ wallet: kp(p.wallet), session: kp(p.session) }));
    const [config, runtime, handLog, dealer] = [st.config, st.runtime, st.handLog, st.dealer].map((k) => new PublicKey(k));
    const hands = st.hands.map((k) => new PublicKey(k));
    const saltAccs = st.saltAccs.map((k) => new PublicKey(k));
    const tee = teeConn(await tokenFor(authority));
    const base = new Connection(BASE_RPC, "confirmed");

    const back = await waitFor(async () => { const a = await tee.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 120_000, 500);
    check("after restart: runtime still delegated and readable in the ER", true, !!back.value);
    const rt = back.value.data;
    check("after restart: same hand number", st.snapshot.hand_no, rt.readBigUInt64LE(RT.hand_no).toString());
    check("after restart: same hand_ctx", st.snapshot.hand_ctx, rt.subarray(RT.hand_ctx, RT.hand_ctx + 32).toString("hex"));
    check("after restart: same salt commitments", st.snapshot.commitments, rt.subarray(RT.salt_commitments, RT.salt_commitments + 96).toString("hex"));
    check("after restart: phase still SALTS_PENDING, 2 salts in", [PHASE.SALTS_PENDING, 0b011], [rt[RT.phase], rt[RT.salts_in]]);
    const baseRt = await base.getAccountInfo(runtime);
    check("base layer: runtime still owned by the delegation program", "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", baseRt.owner.toBase58());
    const s0 = teeConn(await tokenFor(players[0].session));
    const h0 = await s0.getAccountInfo(hands[0]);
    check("after restart: ephemeral seat hand still exists for its owner", true, !!h0 && h0.data.length === HAND.len);
    const stranger = teeConn(await tokenFor(Keypair.generate()));
    check("after restart: permissions still hide hand 0 from a stranger", null, await stranger.getAccountInfo(hands[0]));
    const s1 = teeConn(await tokenFor(players[1].session));
    check("after restart: permissions still hide hand 0 from seat 1", null, await s1.getAccountInfo(hands[0]));
    // The salt accounts survived if the program still accepts/rejects as before.
    const submit = (seat, salt) => ix("submit_salt", [r(players[seat].session.publicKey, true), w(runtime), w(saltAccs[seat])], Buffer.concat([u8(seat), salt]));
    check("after restart: seat 0 can't resubmit (state kept)", true, await rejected(tee, [submit(0, randomBytes(32))], [players[0].session]));
    await send(tee, [submit(2, Buffer.from(st.salt2, "hex"))], [players[2].session], { skipPreflight: true });
    const rt2 = (await tee.getAccountInfo(runtime)).data;
    check("after restart: last salt accepted, phase SALTS_DONE", PHASE.SALTS_DONE, rt2[RT.phase]);
    // Continue the hand with the test-deck deal (no VRF on the local stack).
    await send(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority], { skipPreflight: true });
    const dealt = await s0.getAccountInfo(hands[0]);
    check("after restart: hand continues, seat 0 receives cards", true, !!dealt && (dealt.data[HAND.cards] | dealt.data[HAND.cards + 1] | dealt.data[HAND.cards + 2]) !== 0);
    check("after restart: no second deal", true, await rejected(tee, [ix("poc_deal", [r(authority.publicKey, true), w(runtime), w(dealer), ...hands.map((h) => w(h))])], [authority]));
    // Liveness after the restart: a commit must still reach the base layer.
    const seqOff = RT.commit_seq;
    const baseSeq = async () => { const a = await base.getAccountInfo(runtime); return a ? a.data.readBigUInt64LE(seqOff) : -1n; };
    const seq0 = await baseSeq();
    const keeper = authority;
    const tc = performance.now();
    await send(tee, [ix("commit_hand", [w(keeper.publicKey, true), w(runtime), w(handLog), r(NO_FEE_VAULT), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [keeper], { skipPreflight: true });
    const committed = await waitFor(async () => ((await baseSeq()) > seq0 ? true : null), 180_000, 1000);
    check("after restart: commit_hand reaches the base layer", true, !!committed.value, `${Math.round(performance.now() - tc)} ms`);
    // Tidy up.
    const perKeys = (target) => [r(authority.publicKey, true), w(runtime), w(target), w(permissionPdaFromAccount(target)), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID)];
    for (let s = 0; s < 3; s++) {
      await send(tee, [ix("close_ephemeral", perKeys(hands[s]), Buffer.from([1, s]))], [authority], { skipPreflight: true });
      await send(tee, [ix("close_salt", perKeys(saltAccs[s]), u8(s))], [authority], { skipPreflight: true });
    }
    await send(tee, [ix("close_ephemeral", perKeys(dealer), Buffer.from([0]))], [authority], { skipPreflight: true });
    await send(tee, [ix("undelegate_table", [w(authority.publicKey, true), w(runtime), w(handLog), r(NO_FEE_VAULT), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
    const tu = performance.now();
    const home = await waitFor(async () => { const a = await base.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 180_000, 1000);
    out.undelegate_ms = Math.round(performance.now() - tu);
    check("teardown: runtime back on the base layer", true, !!home.value);
  }
} catch (e) {
  out.error = (e instanceof Error ? String(e.stack ?? e) : JSON.stringify(e)).slice(0, 800);
}
out.ok = !out.error && out.checks.every((c) => c.pass);
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
