# CF-070: whole-codebase audit (2026-11-21)

**Scope:** the program (every instruction and account struct), the rules
and fairness crates, the SDK, keeper, API, admin CLI and the web app; then
a full Devnet regression on the deployed result.

## Program

| Finding | Fix |
| --- | --- |
| **Bug:** `cancel_hand` (VRF never answered) didn't apply pending leaves, unlike every other way a hand ends; a player who asked to leave was dealt into the next hand. | Applies leaves and clears `vrf_caller_seed`. Test extended (`cancel_hand_only_after_vrf_timeout`). |
| **Cost:** every `act`/`timeout_turn` re-derived each dealt seat's hand address with `find_program_address`; `deal_hand`, `vrf_deal`, `reveal_hand`, `submit_salt`, `request_shuffle` did the same for hands, salts and the dealer (Anchor `seeds … bump` without a stored bump). | `stamped()`: owner = program + tag + runtime key + seat, which only the `open_*` instructions write, into the address they checked. New test: hands stamped for another table or seat, unstamped, or owned by someone else are refused. |
| `buy_in` built a `Vec` it didn't need. | Iterator checks. |
| Misplaced doc comment (`create_table` / `init_global`). | Fixed. |

| Measure (LiteSVM) | Before | After |
| --- | --- | --- |
| `act`, worst case over 24 random hands | 71,097 CU | **44,023 CU (−38%)** |
| `deal_hand`, 6 seats | 106,590 CU | **88,436 CU (−17%)** |
| `deal_hand`, 2 seats | 84,950 CU | 72,868 CU |
| program size | 839,608 B | 826,288 B |

Reviewed and found sound: money paths (payouts only to the recorded
wallet, ledgers closed or zeroed after paying, vault rent floor, rake only
from synced hands), refund path, delegation and validator pinning, every
permission write (readers come only from game state), salt/VRF/deal
binding to the hand, reveal only after the game ends, settlement
conservation and the lost-state abort.

## Off-chain

| Finding | Fix |
| --- | --- |
| **Design gap:** a player who left but never pressed Cash out blocked that seat for everyone (`buy_in` can't create a ledger while the old one exists). | The keeper pays departed players itself right after the sync (`cash_out` is permissionless and pays only the recorded wallet). Devnet: payouts 4–5 s after a leave. |
| The web app's "paid" notice relied on seeing the ledger marked `left`; with the keeper paying within seconds it usually missed it. | "Seat was leaving/departed and its ledger is gone" = paid, amount from the final stack. Cash-out buttons treat "the keeper paid first" as success. |
| A player whose stack fell below the boot sat with no explanation. | The table tells them to leave and cash out. |
| The home page polled the lobby twice. | One shared poller. |
| Keeper drill cashed out its departed bot itself. | Now checks the keeper's payout instead. |
| **Keeper race:** synced departures were remembered as a bitmask; a player who joined and left the same seat between two reads looked like the old, already-synced departure, so the payout waited for the 300 s heartbeat (224–295 s in E2E). | Remembers the synced sit-down per seat (`seat_epoch`); unit test for the race. Leave → paid: 6 s. |

## Runtime balance: an unexplained drain (open question for MagicBlock)

A table's runtime pays for its PER accounts, is the commit payer, and can't
be topped up while live (lamports sent to it on the base layer never reach
the PER). On Devnet one table opened with a 0.005 SOL reserve (~5.0M
lamports of headroom) lost ~4M lamports within about an hour of testing
and then every `commit_hand` failed with `InsufficientFundsForRent` on the
runtime (~1.0M left): no syncs, no payouts, no closing; only the refund path.

Isolated measurements could not reproduce a cost:

| Step | Runtime cost |
| --- | --- |
| `join_seat` (reader lists rewritten) | ~0 (it gained 2,112) |
| `commit_hand`, idle heartbeat, 8× | 0 |
| A new table, 4 hands with joins, leaves, a Side Show and payouts | 0 net (the Side Show grant cost 3,168, refunded on revoke) |

So the cause is unknown. Safeguards: `cf-admin table open` funds a 0.05 SOL
reserve by default, the keeper logs the runtime's headroom after every hand,
and `/health` alarms below 2,000,000 lamports, leaving time to close and
reopen. The stuck table's players are paid by the refund path, which the
web app now offers ("Start refund & claim": `emergency_refund` +
`claim_refund` in one transaction). **Before Mainnet:** ask MagicBlock what
can debit a delegated runtime in the ER, and how to top one up.

## Devnet regression (optimized program deployed, bytes verified)

| Suite | Result |
| --- | --- |
| Privacy suite (G1) | 230/230 |
| Hand flow (salts → VRF → deal → Side Show → timeout → reveal → cf-verify) | 67/67 |
| Web E2E, two players | 13/13 |
| Keeper drill (incl. the keeper paying the departed bot) | 13/13 |
| Web E2E: refund from a stalled table via the dashboard | 2/2 |
| Web E2E: three players with Side Show (incl. keeper payouts) | 9/9 |
| Web E2E: Wallet Standard wallet (leave → paid by the keeper) | 6/6 |
| Web E2E: two players | 12/13 → timing check fixed, see STATUS log |
