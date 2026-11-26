// Card Flex high-level architecture as an Excalidraw skeleton.
const F = 1; // Virgil
const T = (x, y, text, fontSize = 20, extra = {}) => ({ type: "text", x, y, text, fontSize, fontFamily: F, ...extra });
const box = (id, x, y, w, h, text, fontSize = 20, extra = {}) => ({ id, type: "rectangle", x, y, width: w, height: h, strokeWidth: 2, roughness: 1, label: { text, fontSize, fontFamily: F }, ...extra });
const frame = (id, x, y, w, h, title, tw) => [
  { id, type: "rectangle", x, y, width: w, height: h, strokeStyle: "dashed", strokeWidth: 2, roughness: 1 },
  box(id + "-t", x + 20, y - 20, tw, 40, title, 21, { backgroundColor: "#ffffff", fillStyle: "solid", strokeWidth: 1 }),
];
const arrow = (x, y, points, label, start, end, extra = {}) => ({
  type: "arrow", x, y, points, strokeWidth: 2, roughness: 1, endArrowhead: "arrow",
  ...(label ? { label: { text: label, fontSize: 17, fontFamily: F } } : {}),
  ...(start ? { start: { id: start } } : {}), ...(end ? { end: { id: end } } : {}), ...extra,
});

const Y = 70, P = 90, R = 180; // vertical shift; x shift of the rollup column and of the Solana column
export const skeleton = [
  T(40, 10, "Card Flex: every hand is dealt and played inside a MagicBlock TEE rollup", 34),

  ...frame("players", 40, 110 + Y, 560, 610, "Players (browser)", 230),
  box("wallet", 70, 150 + Y, 500, 105, "Wallet (Phantom · Solflare · Backpack)\nbuy-in · top-up · cash-out · refund"),
  box("app", 70, 280 + Y, 500, 105, "Player app (Next.js)\nlobby · live table · verify · dashboard"),
  box("session", 70, 410 + Y, 500, 105, "Session key per seat\nsigns salts + moves, no pop-ups"),
  box("attest", 70, 540 + Y, 500, 130, "Checks the TEE attestation\nbefore you buy in\n+ WASM verifier for every hand"),

  ...frame("per", 700 + P, 110 + Y, 640, 610, "MagicBlock Private Ephemeral Rollup (Intel TDX)", 560),
  box("prog", 740 + P, 160 + Y, 560, 240, "card_flex program (Anchor)\n\nrules v1: blind / seen · chaal · pack\nshow · side show · 25 s turn timer\nsalts + VRF → shuffle → deal\nsettle pot + rake", 21, { strokeWidth: 3 }),
  box("hands", 740 + P, 425 + Y, 270, 110, "SeatHand × 6\nonly your session key\ncan read your cards", 18),
  box("salts", 1030 + P, 425 + Y, 270, 110, "Salts + Dealer\nno human reader,\nnever committed", 18),
  box("rt", 740 + P, 555 + Y, 270, 80, "TableRuntime\nlive table state", 18),
  box("vrf", 1030 + P, 555 + Y, 270, 80, "MagicBlock VRF\nverifiable randomness", 18),
  T(880 + P, 662 + Y, "private · fast · no fee per move", 19),

  { id: "sol", type: "ellipse", x: 1440 + R, y: 150 + Y, width: 340, height: 70, strokeWidth: 2, roughness: 1 },
  box("solana", 1440 + R, 185 + Y, 340, 375, "Solana devnet\n\nTableVault: buy-ins\nnever leave the base layer\n\nSeatLedger per seat\n(synced stack)\n\npublic HandLog\nfor every hand", 20),

  ...frame("ours", 40, 900 + Y, 1060, 220, "Our servers (untrusted helpers)", 330),
  box("keeper", 70, 950 + Y, 310, 135, "Keeper\nmoves every table forward,\npermissionless steps only", 18),
  box("admin", 410, 950 + Y, 310, 135, "cf-admin\noperator CLI:\nopen · close · rake sweep", 18),
  box("api", 750, 950 + Y, 310, 135, "Indexer + API\nstores and re-verifies\nevery hand", 18),

  box("anyone", 1440 + R, 950 + Y, 340, 135, "Anyone: cf-verify\nrebuild the deck · replay\ncheck winner, payouts, rake", 18),

  arrow(570, 200 + Y, [[0, 0], [520, -175], [1050, -20]], "buy-in · cash-out (wallet signs)", "wallet", "solana", { roundness: { type: 2 } }),
  arrow(740 + P, 300 + Y, [[0, 0], [-260, 30]], "your cards\nonly", "prog", "app"),
  arrow(570, 465 + Y, [[0, 0], [260, -95]], "salts + moves\n(session key)", "session", "prog"),
  arrow(1300 + P, 280 + Y, [[0, 0], [230, 20]], "commit +\nsync per hand", "prog", "solana"),
  arrow(375, 950 + Y, [[0, 0], [475, -230]], "start · deal · timeout\nreveal · sync", "keeper", "per"),
  arrow(1700 + R, 560 + Y, [[0, 0], [0, 390]], "public\nhand records", "solana", "anyone"),
  arrow(1500 + R, 560 + Y, [[0, 0], [0, 290], [-770, 290], [-770, 390]], "reads hands", "solana", "api", { elbowed: false }),
];
