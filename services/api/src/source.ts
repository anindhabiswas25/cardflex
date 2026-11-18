// Where the indexer reads chain state. Real implementation: base layer for
// tables (committed state), PER for the public HandLog (fresh, no token).
import { Connection, PublicKey } from "@solana/web3.js";
import { ENDPOINTS, PROGRAM_ID, handLogPda, runtimePda, sizeOf } from "@card-flex/client-sdk";

export type RawTable = { config: PublicKey; configData: Uint8Array; runtimeData: Uint8Array | null; runtimeOwner: PublicKey | null };

export interface ChainSource {
  listTables(): Promise<RawTable[]>;
  /** Latest HandLog bytes of a table (PER if live, else base). */
  handLog(config: PublicKey, live: boolean): Promise<Uint8Array | null>;
}

const TABLE_CONFIG_LEN = 8 + sizeOf({ defined: { name: "TableConfig" } });

export class RpcSource implements ChainSource {
  readonly base: Connection;
  readonly per: Connection;
  constructor(baseUrl: string = ENDPOINTS.devnet.base, perUrl: string = ENDPOINTS.devnet.per) {
    this.base = new Connection(baseUrl, "confirmed");
    this.per = new Connection(perUrl, "confirmed");
  }

  async listTables(): Promise<RawTable[]> {
    // Every TableConfig of the current layout (older Devnet test layouts differ in size).
    const configs = await this.base.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: TABLE_CONFIG_LEN }] });
    const runtimes = await this.base.getMultipleAccountsInfo(configs.map((c) => runtimePda(c.pubkey)));
    return configs.map((c, i) => ({
      config: c.pubkey,
      configData: Uint8Array.from(c.account.data),
      runtimeData: runtimes[i] ? Uint8Array.from(runtimes[i]!.data) : null,
      runtimeOwner: runtimes[i]?.owner ?? null,
    }));
  }

  async handLog(config: PublicKey, live: boolean): Promise<Uint8Array | null> {
    const addr = handLogPda(runtimePda(config));
    if (live) {
      try {
        const a = await this.per.getAccountInfo(addr);
        if (a) return Uint8Array.from(a.data);
      } catch {
        /* fall back to the committed copy */
      }
    }
    const a = await this.base.getAccountInfo(addr);
    return a ? Uint8Array.from(a.data) : null;
  }
}
