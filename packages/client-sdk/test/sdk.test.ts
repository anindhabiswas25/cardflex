import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  abortLostHand, act, buyIn, buildIx, cashOut, decodeAccount, discriminatorOf, handLogActions, idl, instructionNames, joinSeat, sizeOf,
  ledgerPda, runtimePda, seatHandPda, sessionCommits, tableAddresses, globalPda, PROGRAM_ID,
} from "../src/index.ts";

const root = new URL("../../../", import.meta.url);

test("IDL copy matches the program build", () => {
  const built = JSON.parse(readFileSync(new URL("target/idl/card_flex.json", root), "utf8"));
  assert.deepEqual(idl, built, "run `pnpm --filter @card-flex/client-sdk sync-idl` after changing the program");
});

test("discriminators follow Anchor's sha256 rule", () => {
  for (const name of ["TableRuntime", "TableConfig", "SeatLedger", "GlobalConfig", "HandLog"] as const) {
    const want = createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
    assert.deepEqual(Buffer.from(discriminatorOf(name)), want, name);
  }
  for (const name of instructionNames()) {
    const ix = idl.instructions.find((i) => i.name === name)!;
    const want = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
    assert.deepEqual(Buffer.from(ix.discriminator), want, name);
  }
});

test("account sizes equal the program's (8-byte discriminator + struct)", () => {
  // From the Rust layout pins (tests/test_game.rs, test_recovery.rs).
  assert.equal(8 + sizeOf({ defined: { name: "TableRuntime" } }), 1340); // bump at 1211, CF-064 commit fields, CF-065 keeper, CF-076 credited, CF-084 session_base_seq
  assert.equal(8 + sizeOf({ defined: { name: "HandLog" } }), 953); // ACTION_LOG_OFFSET
});

/** Writes `value` little-endian at `off`. */
function put(buf: Uint8Array, off: number, value: bigint, bytes: number) {
  for (let i = 0; i < bytes; i++) buf[off + i] = Number((value >> BigInt(8 * i)) & 0xffn);
}

test("TableRuntime decoder agrees with the byte offsets the Rust tests pin", () => {
  const d = new Uint8Array(1340);
  d.set(discriminatorOf("TableRuntime"), 0);
  put(d, 858, 140n, 8); // commit_seq
  put(d, 1332, 120n, 8); // CF-084 session_base_seq
  put(d, 458, 77n, 8); // hand_no
  d[469] = 5; // phase DEALT
  put(d, 810 + 8 * 2, 123_456n, 8); // stacks[2]
  put(d, 866, 25_000n, 8); // boot
  put(d, 892, 9n, 8); // action_seq
  put(d, 900, 25_000n, 8); // game.boot
  d[935 + 20 * 1 + 2] = 1; // game.seats[1].seen
  put(d, 1063, 50_000n, 8); // game.stake
  put(d, 1071, 150_000n, 8); // game.pot
  d[1061] = 3; // game.n
  d[1162] = 4; // button
  put(d, 1163 + 4 * 5, 2n, 4); // seat_epoch[5]
  d[1188] = 0b10; // departed
  const rt = decodeAccount<any>("TableRuntime", d);
  assert.equal(rt.hand_no, 77n);
  assert.equal(rt.phase, 5);
  assert.equal(rt.stacks[2], 123_456n);
  assert.equal(rt.boot, 25_000n);
  assert.equal(rt.action_seq, 9n);
  assert.equal(rt.game.boot, 25_000n);
  assert.equal(rt.game.seats[1].seen, true);
  assert.equal(rt.game.stake, 50_000n);
  assert.equal(rt.game.pot, 150_000n);
  assert.equal(rt.game.n, 3);
  assert.equal(rt.button, 4);
  assert.equal(rt.seat_epoch[5], 2);
  assert.equal(rt.departed, 0b10);
  assert.equal(rt.session_base_seq, 120n);
  assert.equal(sessionCommits(rt), 20, "CF-084: commits this session");
  assert.throws(() => decodeAccount("SeatLedger", d), /not a SeatLedger/);
});

test("TableConfig, SeatLedger and HandLog decoders agree with the pinned offsets", () => {
  const c = new Uint8Array(578);
  c.set(discriminatorOf("TableConfig"), 0);
  c[135] = 0b1011; // seated
  put(c, 144, 12n, 8); // last_synced_seq
  put(c, 153, 3n, 4); // seat_epochs[0]
  c[561] = 1; // ever_delegated
  put(c, 562, 17_500n, 8); // synced_rake
  put(c, 570, 5_000n, 8); // rake_swept
  const cfg = decodeAccount<any>("TableConfig", c);
  assert.deepEqual([cfg.seated, cfg.last_synced_seq, cfg.seat_epochs[0], cfg.ever_delegated, cfg.synced_rake, cfg.rake_swept], [0b1011, 12n, 3, true, 17_500n, 5_000n]);

  const l = new Uint8Array(127);
  l.set(discriminatorOf("SeatLedger"), 0);
  put(l, 81, 1_300_000n, 8); // synced_stack
  put(l, 90, 2n, 4); // epoch
  l[126] = 1; // left
  const led = decodeAccount<any>("SeatLedger", l);
  assert.deepEqual([led.synced_stack, led.epoch, led.left], [1_300_000n, 2, true]);

  const h = new Uint8Array(2563);
  h.set(discriminatorOf("HandLog"), 0);
  put(h, 953, 41n, 8);
  put(h, 961, 3n, 2);
  h.set([0x02, 0x13, 0x24], 963);
  assert.deepEqual(handLogActions(h), { handNo: 41n, actions: Uint8Array.from([0x02, 0x13, 0x24]) });
});

test("instruction bytes match what the Devnet-proven probes send", () => {
  const disc = (n: string) => Buffer.from(idl.instructions.find((i) => i.name === n)!.discriminator);
  const config = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey, session = Keypair.generate().publicKey;
  const t = tableAddresses(config);
  // buy_in: seat u8, amount u64, session_key pubkey
  const b = buyIn({ wallet, config, seat: 3, amount: 1_000_000n, sessionKey: session });
  const amt = Buffer.alloc(8); amt.writeBigUInt64LE(1_000_000n);
  assert.deepEqual(Buffer.from(b.data), Buffer.concat([disc("buy_in"), Buffer.from([3]), amt, session.toBuffer()]));
  assert.deepEqual(b.keys.map((k) => k.pubkey.toBase58()), [wallet, config, t.vault, ledgerPda(config, 3), globalPda(), new PublicKey("11111111111111111111111111111111")].map((k) => k.toBase58()));
  assert.equal(b.keys[0].isSigner && b.keys[0].isWritable, true);
  // act: action u8, amount u64, expected_seq u64 + seat hands in dealing order
  const a = act({ session, config, action: 1, amount: 50_000n, expectedSeq: 7n, dealingOrder: [2, 0, 1] });
  const x = Buffer.alloc(16); x.writeBigUInt64LE(50_000n, 0); x.writeBigUInt64LE(7n, 8);
  assert.deepEqual(Buffer.from(a.data), Buffer.concat([disc("act"), Buffer.from([1]), x]));
  assert.deepEqual(a.keys.slice(3).map((k) => k.pubkey.toBase58()), [2, 0, 1].map((s) => seatHandPda(runtimePda(config), s).toBase58()));
  // join_seat on base: absent optional accounts are the program id
  const j = joinSeat({ payer: wallet, config, seat: 1, live: false });
  assert.equal(j.keys.length, 9);
  assert.ok(j.keys.slice(3).every((k) => k.pubkey.equals(PROGRAM_ID) && !k.isWritable));
  assert.equal(joinSeat({ payer: wallet, config, seat: 1, live: true }).keys[3].pubkey.toBase58(), t.seatHand(1).toBase58());
  // cash_out
  assert.deepEqual(Buffer.from(cashOut({ payer: wallet, config, seat: 4, wallet }).data), Buffer.concat([disc("cash_out"), Buffer.from([4])]));
  // abort_lost_hand (CF-053): no args; dealer, then seat hands, then salts, dealing order, read-only
  const ab = abortLostHand({ payer: wallet, config, dealingOrder: [2, 0] });
  assert.deepEqual(Buffer.from(ab.data), disc("abort_lost_hand"));
  assert.deepEqual(ab.keys.map((k) => k.pubkey.toBase58()), [wallet, t.runtime, t.dealer, t.seatHand(2), t.seatHand(0), t.salt(2), t.salt(0)].map((k) => k.toBase58()));
  assert.ok(ab.keys.slice(2).every((k) => !k.isWritable && !k.isSigner));
  // a missing account is an error, not a silent wrong transaction
  assert.throws(() => buildIx("act", { session }, { action: 0, amount: 0n, expected_seq: 0n }), /missing account runtime/);
});

test("CF-061: confirmByPolling uses HTTP status polls only: confirmed, error, timeout", async () => {
  const { confirmByPolling } = await import("../src/per.ts");
  const fake = (seq: unknown[]) => {
    let i = 0;
    return { getSignatureStatuses: async () => ({ value: [seq[Math.min(i++, seq.length - 1)]] }) } as never;
  };
  assert.equal(await confirmByPolling(fake([null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }]), "s", 5_000, 1), null);
  assert.deepEqual(await confirmByPolling(fake([{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 6052 }] } }]), "s", 5_000, 1), { InstructionError: [0, { Custom: 6052 }] });
  await assert.rejects(confirmByPolling(fake([null]), "s", 20, 1), /not confirmed within 20 ms/);
  // CF-067: a failed poll is not a verdict; keep polling.
  let n = 0;
  const flaky = { getSignatureStatuses: async () => { if (n++ === 0) throw new Error("fetch failed"); return { value: [{ confirmationStatus: "confirmed", err: null }] }; } } as never;
  assert.equal(await confirmByPolling(flaky, "s", 5_000, 1), null);
});

test("CF-067: sendAndConfirm never applies a transaction twice", async () => {
  const { sendAndConfirm, base58 } = await import("../src/per.ts");
  const { SystemProgram } = await import("@solana/web3.js");
  assert.equal(base58(new Uint8Array([0, 0, 1])), "112");
  assert.equal(base58(new Uint8Array([255, 255])), "LUv");
  const payer = Keypair.generate();
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 });
  // A fake cluster: copy 1 lands but every status poll for it fails until
  // the timeout; a second copy would fail (as delegate_table did on Devnet).
  const landed = new Set<string>();
  let sends = 0;
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
    sendRawTransaction: async (raw: Buffer) => {
      sends++;
      const sig = base58(new Uint8Array(raw.subarray(1, 65)));
      if (sends === 1) landed.add(sig);
      return sig;
    },
    getSignatureStatuses: async (sigs: string[], cfg?: { searchTransactionHistory?: boolean }) => {
      if (!cfg?.searchTransactionHistory) throw new Error("fetch failed"); // confirm polls all fail
      return { value: sigs.map((s) => (landed.has(s) ? { confirmationStatus: "confirmed", err: null } : { confirmationStatus: "confirmed", err: { InstructionError: [0, "InvalidAccountData"] } })) };
    },
  } as never;
  const sig = await sendAndConfirm(conn, [ix], [payer], { timeoutMs: 20, backoffMs: 1 });
  assert.ok(landed.has(sig), "returns the copy that landed");
  assert.equal(sends, 1, "no second copy sent");
  // A program error is final: reported with its code, not resent.
  let failSends = 0;
  const failing = { ...(conn as object), sendRawTransaction: async () => { failSends++; return "x"; }, getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 6055 }] } }] }) } as never;
  await assert.rejects(sendAndConfirm(failing, [ix], [payer], { retries: 3, backoffMs: 1 }), /6055/);
  assert.equal(failSends, 1);
});

test("CF-057: fee vault matches MagicBlock's derivation; commit_hand carries it", async () => {
  const mb = await import("@magicblock-labs/ephemeral-rollups-sdk");
  const { magicFeeVault, TEE_VALIDATOR, commitHand } = await import("../src/index.ts");
  assert.ok(magicFeeVault().equals(mb.magicFeeVaultPdaFromValidator(TEE_VALIDATOR)));
  const k = Keypair.generate().publicKey;
  const c = commitHand({ payer: k, config: k, feeVault: magicFeeVault() });
  assert.ok(c.keys.some((x) => x.pubkey.equals(magicFeeVault()) && x.isWritable));
});

test("CF-064/065: TableRuntime decodes the commit fields and the keeper key", async () => {
  const { decodeRuntime, discriminatorOf, sizeOf } = await import("../src/index.ts");
  const d = new Uint8Array(8 + sizeOf({ defined: { name: "TableRuntime" } }));
  d.set(discriminatorOf("TableRuntime"), 0);
  const k = Keypair.generate().publicKey;
  new DataView(d.buffer).setBigInt64(1212, 1_800_000_000n, true);
  d.fill(9, 1220, 1252);
  d.set(k.toBytes(), 1252);
  const rt = decodeRuntime(d);
  assert.equal(rt.last_paid_commit, 1_800_000_000n);
  assert.equal(rt.paid_commit_hash[0], 9);
  assert.ok(rt.keeper.equals(k));
});
