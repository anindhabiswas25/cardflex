// Shared Devnet table setup for P2 scripts: create a six-seat table, delegate
// it to the TEE validator, open permissions, dealer, hands and salts.
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID, EPHEMERAL_VAULT_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram, delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount, permissionPdaFromAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PROGRAM_ID, TEE_VALIDATOR, BASE_RPC, loadDiscriminators, loadPayer, makeIx, send, tokenFor, teeConn,
  waitFor, log, w, r, u8, u64, RT, GAME, PHASE, ACTION,
} from "./common.mjs";

// Every seat buys in for real (vault + seat ledgers, ADR 0004). The table is
// configured first: boot (lamports), rake and refund timeout. Buy-in must be
// 40-200 boots (rules v1 section 6); the defaults give 40 boots.
export async function setupTable({ seats = 6, boot = 25_000, buyIn = 40 * boot, rakeBps = 0, rakeCap = 0, refundTimeout = 3600 } = {}) {
  const ix = makeIx(loadDiscriminators());
  const payer = loadPayer();
  const base = new Connection(BASE_RPC, "confirmed");
  const authority = Keypair.generate();
  const players = Array.from({ length: seats }, () => ({ wallet: Keypair.generate(), session: Keypair.generate() }));
  const tableId = BigInt(Date.now());
  const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const config = pda(Buffer.from("table"), authority.publicKey.toBuffer(), u64(tableId));
  const runtime = pda(Buffer.from("table-runtime"), config.toBuffer());
  const handLog = pda(Buffer.from("hand-log"), runtime.toBuffer());
  const vault = pda(Buffer.from("table-vault"), config.toBuffer());
  const dealer = pda(Buffer.from("dealer"), runtime.toBuffer());
  const hands = players.map((_, s) => pda(Buffer.from("seat-hand"), runtime.toBuffer(), u8(s)));
  const saltAccs = players.map((_, s) => pda(Buffer.from("salt"), runtime.toBuffer(), u8(s)));
  const perKeys = (target, signer = authority) => [
    r(signer.publicKey, true), w(runtime), w(target), w(permissionPdaFromAccount(target)),
    r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
  ];

  log("setup: table, players, delegate");
  await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: authority.publicKey, lamports: 30_000_000 })], [payer]);
  await send(base, [ix("create_table", [w(config), w(runtime), w(handLog), w(vault), w(authority.publicKey, true), r(SystemProgram.programId)], Buffer.concat([u64(tableId), u8(seats)]))], [authority]);
  const ledgers = players.map((_, s) => pda(Buffer.from("seat-ledger"), config.toBuffer(), u8(s)));
  {
    // configure_table(boot u64, rake_bps u16, rake_cap u64, refund_timeout_secs u32)
    const cfgData = Buffer.alloc(22);
    cfgData.writeBigUInt64LE(BigInt(boot), 0); cfgData.writeUInt16LE(rakeBps, 8);
    cfgData.writeBigUInt64LE(BigInt(rakeCap), 10); cfgData.writeUInt32LE(refundTimeout, 18);
    await send(base, [ix("configure_table", [r(authority.publicKey, true), w(config), w(runtime)], cfgData)], [authority]);
    for (let s = 0; s < seats; s++) {
      // Fund each wallet for its buy-in plus the seat-ledger rent.
      await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: players[s].wallet.publicKey, lamports: buyIn + 5_000_000 })], [payer]);
      await send(base, [ix("buy_in", [w(players[s].wallet.publicKey, true), w(config), w(runtime), w(vault), w(ledgers[s]), r(SystemProgram.programId)],
        Buffer.concat([u8(s), u64(buyIn), players[s].session.publicKey.toBuffer()]))], [players[s].wallet]);
    }
  }
  await send(base, [ix("delegate_table", [
    r(authority.publicKey, true), w(config),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(runtime, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(runtime)), w(delegationMetadataPdaFromDelegatedAccount(runtime)),
    w(runtime),
    w(delegateBufferPdaFromDelegatedAccountAndOwnerProgram(handLog, PROGRAM_ID)),
    w(delegationRecordPdaFromDelegatedAccount(handLog)), w(delegationMetadataPdaFromDelegatedAccount(handLog)),
    w(handLog), r(TEE_VALIDATOR), r(PROGRAM_ID), r(DELEGATION_PROGRAM_ID), r(SystemProgram.programId),
  ])], [authority]);

  const tee = teeConn(await tokenFor(authority));
  const vis = await waitFor(async () => { const a = await tee.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 60_000);
  if (!vis.value) throw new Error("runtime never appeared in PER");

  log("setup: permissions, dealer, hands, salts");
  await send(tee, [ix("open_runtime_permission", perKeys(runtime))], [authority], { skipPreflight: true });
  await send(tee, [ix("open_hand_log_permission", perKeys(handLog))], [authority], { skipPreflight: true });
  await send(tee, [ix("open_dealer", perKeys(dealer))], [authority], { skipPreflight: true });
  for (let s = 0; s < seats; s++) await send(tee, [ix("open_seat_hand", perKeys(hands[s]), u8(s))], [authority], { skipPreflight: true });
  for (let s = 0; s < seats; s++) await send(tee, [ix("open_salt", perKeys(saltAccs[s]), u8(s))], [authority], { skipPreflight: true });

  async function teardown() {
    log("teardown: close ephemerals, undelegate");
    for (let s = 0; s < seats; s++) {
      await send(tee, [ix("close_ephemeral", perKeys(hands[s]), Buffer.from([1, s]))], [authority], { skipPreflight: true }).catch(() => {});
      await send(tee, [ix("close_salt", perKeys(saltAccs[s]), u8(s))], [authority], { skipPreflight: true }).catch(() => {});
    }
    await send(tee, [ix("close_ephemeral", perKeys(dealer), Buffer.from([0]))], [authority], { skipPreflight: true }).catch(() => {});
    await send(tee, [ix("undelegate_table", [w(authority.publicKey, true), w(runtime), w(handLog), r(MAGIC_PROGRAM_ID), w(MAGIC_CONTEXT_ID)])], [authority], { skipPreflight: true });
    return waitFor(async () => { const a = await base.getAccountInfo(runtime); return a && a.owner.equals(PROGRAM_ID) ? a : null; }, 120_000, 500);
  }

  // CF-020 player action, signed by the seat's session key. Seat hands of the
  // dealt seats follow in dealing order (read from the on-chain game).
  const readRuntime = async (conn = tee) => (await conn.getAccountInfo(runtime))?.data;
  const actIx = (d, s, code, amount = 0n) => {
    const n = d[GAME.n];
    const order = [...d.subarray(GAME.order, GAME.order + n)];
    return ix("act", [r(players[s].session.publicKey, true), w(runtime), w(handLog), ...order.map((k) => r(hands[k]))],
      Buffer.concat([u8(code), u64(BigInt(amount)), u64(d.readBigUInt64LE(RT.action_seq))]));
  };
  // Sends one action for seat s and waits until the runtime shows it.
  // amount "min" / "double" = the minimum legal bet or twice it.
  // preflight: simulate first, so an illegal action fails fast (throws).
  async function act(s, code, amount = 0n, conn = tee, { preflight = false } = {}) {
    const d = await readRuntime(conn);
    if (amount === "min" || amount === "double") {
      const stake = d.readBigUInt64LE(GAME.stake);
      const seen = d[GAME.seats + GAME.seat_len * s + 2] === 1;
      amount = (seen ? 2n * stake : stake) * (amount === "double" ? 2n : 1n);
    }
    const seq = d.readBigUInt64LE(RT.action_seq);
    await send(conn, [actIx(d, s, code, amount)], [players[s].session], preflight ? { retries: 0 } : { skipPreflight: true });
    const after = await waitFor(async () => { const e = await readRuntime(conn); return e && e.readBigUInt64LE(RT.action_seq) > seq ? e : null; }, 15_000, 100);
    if (!after.value) throw new Error(`act seat ${s} code ${code} not applied`);
    return after.value;
  }
  // Ends a dealt hand the only way the program allows: through the game.
  // Whoever is to act (or must answer a Side Show) packs / rejects until one
  // player is left (CF-021).
  async function packOut(conn = tee) {
    for (let i = 0; i < 3 * seats; i++) {
      const d = await readRuntime(conn);
      if (d[RT.phase] !== PHASE.DEALT) return d[RT.phase];
      if (d[GAME.phase] === 1) { await act(d[GAME.ss_target], ACTION.SIDE_SHOW_RESPOND, 0n, conn); continue; }
      await act(d[GAME.order + d[GAME.turn]], ACTION.PACK, 0n, conn);
    }
    return (await readRuntime(conn))[RT.phase];
  }
  // CF-024: after reveal_hand, anyone moves the table to the next hand.
  const nextHandIx = (payer) => ix("next_hand", [r(payer.publicKey, true), w(runtime)]);
  // CF-023: anyone may time out the player to act after turn_deadline.
  const timeoutIx = (d, payer) => {
    const n = d[GAME.n];
    const order = [...d.subarray(GAME.order, GAME.order + n)];
    return ix("timeout_turn", [r(payer.publicKey, true), w(runtime), w(handLog), ...order.map((k) => r(hands[k]))],
      u64(d.readBigUInt64LE(RT.action_seq)));
  };
  // CF-022: grant (after an accepted Side Show) or revoke (after the hand)
  // the mutual view of two seat hands. Permissionless.
  const sideShowViewIx = (a, b, grant, payer) => ix("side_show_view", [
    r(payer.publicKey, true), w(runtime), w(hands[a]), w(permissionPdaFromAccount(hands[a])),
    w(hands[b]), w(permissionPdaFromAccount(hands[b])), r(PERMISSION_PROGRAM_ID), w(EPHEMERAL_VAULT_ID), r(MAGIC_PROGRAM_ID),
  ], Buffer.concat([u8(a), u8(b), u8(grant ? 1 : 0)]));

  return { ix, payer, base, tee, authority, players, config, runtime, handLog, vault, ledgers, dealer, hands, saltAccs, perKeys, teardown, seats, readRuntime, actIx, act, packOut, sideShowViewIx, timeoutIx, nextHandIx };
}
