// CF-061: the keeper's scheduling loop, shared by the service (main.ts) and
// the load test, so what we measure is what we run.
//
// - One reader loop: every `tickMs` it reads ALL runtimes with batched
//   getMultipleAccountsInfo calls (≤ 100 accounts each) plus ONE getSlot.
//   Per-table reads used to be 2 PER calls per table per tick.
// - One worker per table: it acts on the newest snapshot taken after its own
//   last step finished (so it never repeats a step on stale state). A table
//   that spends seconds in commit + sync delays only itself; before CF-061
//   every table waited for the slowest one each round (CF-054: deal wait
//   18 s p50 at 50 tables).
import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeRuntime, tableAddresses } from "@card-flex/client-sdk";
import type { Keeper, Snapshot } from "./keeper.ts";

export type RunOpts = {
  per: Connection;
  /** Tables to drive; called every `scanMs`. */
  tables: () => Promise<PublicKey[]>;
  tickMs?: number;
  scanMs?: number;
  /** Stop when this returns true (tests); runs forever otherwise. */
  stop?: () => boolean;
  log?: (m: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHUNK = 100; // getMultipleAccountsInfo limit

export async function runKeeper(keeper: Keeper, o: RunOpts): Promise<void> {
  const tickMs = o.tickMs ?? 500;
  const scanMs = o.scanMs ?? 30_000;
  const stop = o.stop ?? (() => false);
  const log = o.log ?? ((m: string) => console.log(m));
  const snaps = new Map<string, Snapshot & { at: number }>();
  const workers = new Map<string, Promise<void>>();
  let list: PublicKey[] = [];
  let lastScan = 0;

  const worker = async (config: PublicKey) => {
    const id = config.toBase58();
    let doneAt = 0;
    while (!stop() && list.some((c) => c.equals(config))) {
      const s = snaps.get(id);
      if (!s || s.at <= doneAt) { await sleep(Math.min(50, tickMs)); continue; }
      await keeper.tick(config, s).catch((e) => log(`${id.slice(0, 8)} tick: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
      doneAt = Date.now();
    }
    workers.delete(id);
  };

  while (!stop()) {
    if (Date.now() - lastScan > scanMs) {
      try {
        list = await o.tables();
        lastScan = Date.now();
        log(`driving ${list.length} table(s)`);
      } catch (e) {
        log(`table scan failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      }
    }
    if (list.length) {
      try {
        // Stamp with the START of the read: a read that began before a
        // worker's step finished must not count as newer than that step.
        const at = Date.now();
        const runtimes = list.map((c) => tableAddresses(c).runtime);
        const [slot, ...chunks] = await Promise.all([
          o.per.getSlot(),
          ...Array.from({ length: Math.ceil(runtimes.length / CHUNK) }, (_, i) => o.per.getMultipleAccountsInfo(runtimes.slice(i * CHUNK, (i + 1) * CHUNK))),
        ]);
        const infos = chunks.flat();
        list.forEach((c, i) => {
          const a = infos[i];
          snaps.set(c.toBase58(), { rt: a ? decodeRuntime(a.data) : null, slot: BigInt(slot as number), at });
        });
      } catch (e) {
        log(`read failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      }
      for (const c of list) if (!workers.has(c.toBase58())) workers.set(c.toBase58(), worker(c));
    }
    await sleep(tickMs);
  }
  await Promise.all(workers.values());
}
