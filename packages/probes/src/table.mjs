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
  waitFor, log, w, r, u8, u64,
} from "./common.mjs";

// buyIn (lamports): use real buy_in (vault + seat ledgers, ADR 0004) instead
// of poc_join; refundTimeout (s) is set with configure_table first.
export async function setupTable({ seats = 6, buyIn = 0, refundTimeout = 3600 } = {}) {
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
  if (buyIn > 0) {
    const cfgData = Buffer.alloc(20);
    // min buy-in must be >= the rent-exempt minimum (program rule)
    cfgData.writeBigUInt64LE(1_000_000n, 0); cfgData.writeBigUInt64LE(BigInt(buyIn) * 10n, 8); cfgData.writeUInt32LE(refundTimeout, 16);
    await send(base, [ix("configure_table", [r(authority.publicKey, true), w(config)], cfgData)], [authority]);
    for (let s = 0; s < seats; s++) {
      // Fund each wallet for its buy-in plus the seat-ledger rent.
      await send(base, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: players[s].wallet.publicKey, lamports: buyIn + 5_000_000 })], [payer]);
      await send(base, [ix("buy_in", [w(players[s].wallet.publicKey, true), w(config), w(runtime), w(vault), w(ledgers[s]), r(SystemProgram.programId)],
        Buffer.concat([u8(s), u64(buyIn), players[s].session.publicKey.toBuffer()]))], [players[s].wallet]);
    }
  } else {
    for (let s = 0; s < seats; s++) {
      await send(base, [ix("poc_join", [r(players[s].wallet.publicKey, true), w(runtime)], Buffer.concat([u8(s), players[s].session.publicKey.toBuffer()]))], [payer, players[s].wallet]);
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

  return { ix, payer, base, tee, authority, players, config, runtime, handLog, vault, ledgers, dealer, hands, saltAccs, perKeys, teardown, seats };
}
