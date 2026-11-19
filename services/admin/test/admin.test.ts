import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, globalPda, idl, permissionPda, programDataPda, tableAddresses, tablePda } from "@card-flex/client-sdk";
import { checkVault, closeTablePer, createTable, delegateTable, openTablePer, sweepRake, updateGlobal, syncGlobalAuthority } from "../src/admin.ts";

const disc = (n: string) => Buffer.from(idl.instructions.find((i) => i.name === n)!.discriminator);
const admin = Keypair.generate().publicKey;

test("create + configure: the right PDAs, signer and arguments", () => {
  const { config, ixs } = createTable(admin, { tableId: 7n, seats: 6, boot: 25_000n, rakeBps: 250, rakeCap: 10_000n, refundTimeoutSecs: 3600 });
  assert.equal(config.toBase58(), tablePda(admin, 7n).toBase58());
  const [create, configure] = ixs;
  assert.deepEqual(Buffer.from(create.data), Buffer.concat([disc("create_table"), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0, 6])]));
  assert.ok(create.keys.find((k) => k.pubkey.equals(admin))!.isSigner);
  assert.ok(create.keys.some((k) => k.pubkey.equals(globalPda())));
  const d = Buffer.from(configure.data);
  assert.equal(d.readBigUInt64LE(8), 25_000n);
  assert.equal(d.readUInt16LE(16), 250);
  assert.equal(d.readBigUInt64LE(18), 10_000n);
  assert.equal(d.readUInt32LE(26), 3600);
});

test("open/close cover every seat (empty seats too) and the dealer", () => {
  const config = tablePda(admin, 1n);
  const t = tableAddresses(config);
  const open = openTablePer(admin, config, 6);
  assert.equal(open.length, 3 + 12);
  const targets = open.map((ix) => ix.keys[2].pubkey.toBase58());
  for (let s = 0; s < 6; s++) {
    assert.ok(targets.includes(t.seatHand(s).toBase58()) && targets.includes(t.salt(s).toBase58()), `seat ${s}`);
  }
  for (const ix of open) assert.equal(ix.keys[3].pubkey.toBase58(), permissionPda(ix.keys[2].pubkey).toBase58(), "permission PDA of the target");
  const close = closeTablePer(admin, config, 6);
  assert.deepEqual(Buffer.from(close.at(-3)!.data), Buffer.concat([disc("close_ephemeral"), Buffer.from([0])]), "dealer: seat = None");
  assert.deepEqual(Buffer.from(close.at(-2)!.data), disc("commit_hand"), "commit before undelegating (so the final state syncs)");
  assert.deepEqual(Buffer.from(close[0].data), Buffer.concat([disc("close_ephemeral"), Buffer.from([1, 0])]), "seat hand 0: Some(0)");
  assert.equal(close.at(-1)!.keys[0].pubkey.toBase58(), admin.toBase58());
});

test("delegate, sweep, check and global update are well-formed", () => {
  const config = tablePda(admin, 2n);
  assert.equal(delegateTable(admin, config).keys.length, 14);
  const treasury = Keypair.generate().publicKey;
  assert.ok(sweepRake(admin, config, treasury).keys.some((k) => k.pubkey.equals(treasury) && k.isWritable));
  const cv = checkVault(config, 0b101, true);
  assert.equal(cv.keys.length, 2 + 2, "two seated ledgers");
  assert.deepEqual(Buffer.from(cv.data), Buffer.concat([disc("check_vault"), Buffer.from([1])]));
  const ug = updateGlobal(admin, { treasury, maxRakeBps: 300, paused: true });
  assert.deepEqual(Buffer.from(ug.data), Buffer.concat([disc("update_global"), treasury.toBuffer(), Buffer.from([0x2c, 0x01, 1])]));
  // CF-055: settings handover to the upgrade authority (multisig, CF-056)
  const sa = syncGlobalAuthority(admin);
  assert.deepEqual(Buffer.from(sa.data), disc("sync_global_authority"));
  assert.deepEqual(sa.keys.map((k) => k.pubkey.toBase58()), [admin, globalPda(), PROGRAM_ID, programDataPda()].map((k) => k.toBase58()));
  assert.ok(sa.keys[0].isSigner && sa.keys[1].isWritable);
  void PublicKey;
});
