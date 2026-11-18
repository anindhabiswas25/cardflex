// SQLite storage (node:sqlite, ADR 0006). Plain SQL so a later move to
// PostgreSQL is a swap of this file.
import { DatabaseSync } from "node:sqlite";

export type TableRow = {
  config: string; authority: string; table_id: string; max_seats: number; status: number; live: number;
  boot: string; min_buy_in: string; max_buy_in: string; rake_bps: number; rake_cap: string;
  seated: number; phase: number; hand_no: string; seats_json: string; last_sync_time: number; updated_at: number;
};
export type HandRow = {
  config: string; hand_no: string; end_reason: string; winners_json: string; pot: string; rake: string;
  verified: number; verify_json: string; record_json: string; indexed_at: number;
};
export type HandSeatRow = {
  config: string; hand_no: string; seat: number; wallet: string; start_stack: string; contributed: string;
  payout: string; net: string; cards_json: string; won: number;
};

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tables (
        config TEXT PRIMARY KEY, authority TEXT, table_id TEXT, max_seats INTEGER, status INTEGER, live INTEGER,
        boot TEXT, min_buy_in TEXT, max_buy_in TEXT, rake_bps INTEGER, rake_cap TEXT, seated INTEGER, phase INTEGER,
        hand_no TEXT, seats_json TEXT, last_sync_time INTEGER, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS hands (
        config TEXT, hand_no TEXT, end_reason TEXT, winners_json TEXT, pot TEXT, rake TEXT, verified INTEGER,
        verify_json TEXT, record_json TEXT, indexed_at INTEGER, PRIMARY KEY (config, hand_no));
      CREATE TABLE IF NOT EXISTS hand_seats (
        config TEXT, hand_no TEXT, seat INTEGER, wallet TEXT, start_stack TEXT, contributed TEXT, payout TEXT,
        net TEXT, cards_json TEXT, won INTEGER, PRIMARY KEY (config, hand_no, seat));
      CREATE INDEX IF NOT EXISTS hand_seats_wallet ON hand_seats (wallet);
    `);
  }

  upsertTable(t: TableRow) {
    this.db.prepare(`INSERT INTO tables VALUES (:config,:authority,:table_id,:max_seats,:status,:live,:boot,:min_buy_in,:max_buy_in,
      :rake_bps,:rake_cap,:seated,:phase,:hand_no,:seats_json,:last_sync_time,:updated_at)
      ON CONFLICT(config) DO UPDATE SET authority=excluded.authority, table_id=excluded.table_id, max_seats=excluded.max_seats,
      status=excluded.status, live=excluded.live, boot=excluded.boot, min_buy_in=excluded.min_buy_in, max_buy_in=excluded.max_buy_in,
      rake_bps=excluded.rake_bps, rake_cap=excluded.rake_cap, seated=excluded.seated, phase=excluded.phase, hand_no=excluded.hand_no,
      seats_json=excluded.seats_json, last_sync_time=excluded.last_sync_time, updated_at=excluded.updated_at`).run(t);
  }
  hasHand(config: string, handNo: string) {
    return !!this.db.prepare("SELECT 1 FROM hands WHERE config=? AND hand_no=?").get(config, handNo);
  }
  insertHand(h: HandRow, seats: HandSeatRow[]) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT OR IGNORE INTO hands VALUES (:config,:hand_no,:end_reason,:winners_json,:pot,:rake,:verified,:verify_json,:record_json,:indexed_at)`).run(h);
      const ins = this.db.prepare(`INSERT OR IGNORE INTO hand_seats VALUES (:config,:hand_no,:seat,:wallet,:start_stack,:contributed,:payout,:net,:cards_json,:won)`);
      for (const s of seats) ins.run(s);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  tables(): TableRow[] {
    return this.db.prepare("SELECT * FROM tables ORDER BY live DESC, seated DESC, config").all() as unknown as TableRow[];
  }
  table(config: string): TableRow | undefined {
    return this.db.prepare("SELECT * FROM tables WHERE config=?").get(config) as unknown as TableRow | undefined;
  }
  hands(config: string, limit: number): HandRow[] {
    return this.db.prepare("SELECT * FROM hands WHERE config=? ORDER BY CAST(hand_no AS INTEGER) DESC LIMIT ?").all(config, limit) as unknown as HandRow[];
  }
  hand(config: string, handNo: string): HandRow | undefined {
    return this.db.prepare("SELECT * FROM hands WHERE config=? AND hand_no=?").get(config, handNo) as unknown as HandRow | undefined;
  }
  handSeats(config: string, handNo: string): HandSeatRow[] {
    return this.db.prepare("SELECT * FROM hand_seats WHERE config=? AND hand_no=? ORDER BY seat").all(config, handNo) as unknown as HandSeatRow[];
  }
  playerHands(wallet: string, limit: number) {
    return this.db.prepare(`SELECT s.*, h.end_reason, h.verified, h.indexed_at FROM hand_seats s JOIN hands h USING (config, hand_no)
      WHERE s.wallet=? ORDER BY h.indexed_at DESC LIMIT ?`).all(wallet, limit) as unknown as (HandSeatRow & { end_reason: string; verified: number; indexed_at: number })[];
  }
  playerTotals(wallet: string) {
    return this.db.prepare(`SELECT COUNT(*) AS hands, COALESCE(SUM(won),0) AS won FROM hand_seats WHERE wallet=?`).get(wallet) as { hands: number; won: number };
  }
  playerNet(wallet: string): bigint {
    const rows = this.db.prepare("SELECT net FROM hand_seats WHERE wallet=?").all(wallet) as { net: string }[];
    return rows.reduce((a, r) => a + BigInt(r.net), 0n);
  }
}
