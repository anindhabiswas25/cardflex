// Read-only HTTP API (CF-018). JSON only; amounts are lamport strings.
import { createServer, type Server } from "node:http";
import type { Store } from "./store.ts";

type Json = Record<string, unknown> | unknown[];

export function apiHandler(store: Store) {
  const tableView = (t: NonNullable<ReturnType<Store["table"]>>) => ({
    config: t.config, authority: t.authority, tableId: t.table_id, maxSeats: t.max_seats,
    status: t.status === 1 ? "active" : t.status === 2 ? "refunded" : "unknown", live: t.live === 1,
    boot: t.boot, buyIn: { min: t.min_buy_in, max: t.max_buy_in }, rake: { bps: t.rake_bps, cap: t.rake_cap },
    seated: t.seated, openSeats: Math.max(0, t.max_seats - t.seated), phase: t.phase, handNo: t.hand_no,
    seats: JSON.parse(t.seats_json), lastSyncTime: t.last_sync_time, updatedAt: t.updated_at,
  });
  const handView = (h: NonNullable<ReturnType<Store["hand"]>>) => ({
    table: h.config, handNo: h.hand_no, endReason: h.end_reason, winners: JSON.parse(h.winners_json), pot: h.pot, rake: h.rake,
    verified: h.verified === 1, seats: store.handSeats(h.config, h.hand_no).map((x) => ({
      seat: x.seat, wallet: x.wallet, startStack: x.start_stack, bet: x.contributed, payout: x.payout, net: x.net, cards: JSON.parse(x.cards_json), won: x.won === 1,
    })), indexedAt: h.indexed_at,
  });

  return (method: string, url: URL): { status: number; body: Json } => {
    if (method !== "GET") return { status: 405, body: { error: "read-only API" } };
    const p = url.pathname.split("/").filter(Boolean);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
    if (p.length === 1 && p[0] === "health") return { status: 200, body: { ok: true } };
    if (p[0] === "tables" && p.length === 1) return { status: 200, body: store.tables().map(tableView) };
    if (p[0] === "tables" && p.length === 2) {
      const t = store.table(p[1]);
      return t ? { status: 200, body: tableView(t) } : { status: 404, body: { error: "unknown table" } };
    }
    if (p[0] === "tables" && p.length === 3 && p[2] === "hands") return { status: 200, body: store.hands(p[1], limit).map(handView) };
    if (p[0] === "hands" && p.length === 3) {
      const h = store.hand(p[1], p[2]);
      if (!h) return { status: 404, body: { error: "unknown hand" } };
      return { status: 200, body: { ...handView(h), record: JSON.parse(h.record_json), checks: JSON.parse(h.verify_json) } };
    }
    if (p[0] === "players" && p.length === 2) {
      const totals = store.playerTotals(p[1]);
      return {
        status: 200,
        body: {
          wallet: p[1], handsPlayed: totals.hands, handsWon: totals.won, net: store.playerNet(p[1]).toString(),
          recent: store.playerHands(p[1], limit).map((x) => ({ table: x.config, handNo: x.hand_no, seat: x.seat, net: x.net, won: x.won === 1, endReason: x.end_reason, verified: x.verified === 1, cards: JSON.parse(x.cards_json) })),
        },
      };
    }
    return { status: 404, body: { error: "not found" } };
  };
}

export function startServer(store: Store, port: number, host = "127.0.0.1"): Promise<Server> {
  const handle = apiHandler(store);
  const server = createServer((req, res) => {
    // Never let one request crash the process (security review of CF-018):
    // a malformed URL is a 400, any handler error a 500.
    let status = 500, body: Json = { error: "internal error" };
    let url: URL | null = null;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      status = 400;
      body = { error: "bad request" };
    }
    if (url) {
      try {
        ({ status, body } = handle(req.method ?? "GET", url));
      } catch (e) {
        console.error("request failed:", req.method, req.url, String((e as Error).message ?? e));
      }
    }
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}
