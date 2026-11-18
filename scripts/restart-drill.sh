#!/usr/bin/env bash
# CF-013 step 4: kill and restart the LOCAL ephemeral validator mid-hand and
# check the hand survives (ADR 0004 rule 8: resume the same hand, never
# redeal). Starts the three local MagicBlock services itself, separately (as
# `mb-stack` does internally), so the validator can be restarted alone.
# `pnpm mb-stack` must NOT be running.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
work="$(mktemp -d)"
bin="$root/node_modules/.bin"
pids=()
cleanup() { for p in "${pids[@]}"; do kill -- -"$p" 2>/dev/null || true; done; if [[ -n "${KEEP_LOGS:-}" ]]; then mkdir -p "$KEEP_LOGS"; cp "$work"/*.log "$work"/*.err "$KEEP_LOGS"/ 2>/dev/null || true; fi; rm -rf "$work"; }
trap cleanup EXIT

health() { curl -s --retry 90 --retry-connrefused --retry-delay 1 -m 3 -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$1" >/dev/null; }
start() { # name, args...
  local name=$1; shift
  setsid "$@" > "$work/$name.log" 2>&1 &
  pids+=("$!")
}

echo "== start local services separately (fresh storage)"
rm -rf magicblock-test-storage test-ledger
start base "$bin/mb-test-validator" --rpc-port 8899
health http://127.0.0.1:8899
er_cmd=("$bin/ephemeral-validator" --no-tui --listen 127.0.0.1:7799 --remotes http://127.0.0.1:8899 --remotes ws://127.0.0.1:8900)
start er "${er_cmd[@]}"; er_pid=$!
health http://127.0.0.1:7799
start qfs "$bin/query-filtering-service" --listen-addr 127.0.0.1:6699 --listen-addr-ws 127.0.0.1:6700 \
  --ephemeral-url http://127.0.0.1:7799 --ephemeral-url-ws ws://127.0.0.1:7800
health http://127.0.0.1:6699
echo "   base 8899, ER 7799, QFS 6699 up"

export CARDFLEX_BASE_RPC=http://127.0.0.1:8899
export CARDFLEX_TEE_RPC=http://127.0.0.1:6699
export CARDFLEX_TEE_WS=ws://127.0.0.1:6700
export CARDFLEX_VALIDATOR=mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev
export CARDFLEX_DEVNET_KEYPAIR="$work/local-payer.json"

echo "== local payer and program (features poc-test-deck, local-stack)"
solana-keygen new --no-bip39-passphrase --silent -o "$CARDFLEX_DEVNET_KEYPAIR" >/dev/null
solana airdrop 50 "$(solana-keygen pubkey "$CARDFLEX_DEVNET_KEYPAIR")" --url "$CARDFLEX_BASE_RPC" >/dev/null
anchor build -- --features poc-test-deck,local-stack >/dev/null 2>&1
solana program deploy target/deploy/card_flex.so --program-id "${CARDFLEX_KEYS:-$HOME/.config/cardflex}/card_flex-program-keypair.json" \
  --keypair "$CARDFLEX_DEVNET_KEYPAIR" --url "$CARDFLEX_BASE_RPC" >/dev/null
echo "   deployed"

echo "== phase before (mid-hand: 2 of 3 salts in)"
node packages/probes/src/restart.mjs --phase before --state "$work/state.json" > "$work/before.json" 2>"$work/before.err" \
  || { cat "$work/before.json" "$work/before.err"; exit 1; }

if [[ "${NO_KILL:-0}" == "1" ]]; then
  echo "== control run: validator NOT restarted"
else
  echo "== kill the ephemeral validator (process group $er_pid)"
  kill -- -"$er_pid"
  while pgrep -f "ephemeral-validator-linux-x64.*--listen 127.0.0.1:7799" >/dev/null; do :; done
  echo "== restart it with the same command and storage"
  start er2 "${er_cmd[@]}"
  health http://127.0.0.1:7799
  echo "   validator is back"
fi

echo "== phase after"
node packages/probes/src/restart.mjs --phase after --state "$work/state.json" > "$work/after.json" 2>"$work/after.err" || true
out="$root/docs/probes/$(date -u +%Y-%m-%dT%H-%M-%SZ)-cf013-restart-local$([[ "${NO_KILL:-0}" == 1 ]] && echo -control).json"
python3 -I - "$work/before.json" "$work/after.json" "$out" <<'EOF'
import json, sys
before, after, out = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
ok = True
for d in (before, after):
    for c in d["checks"]:
        print(f"  {'ok  ' if c['pass'] else 'FAIL'} {c['name']}")
        ok &= c["pass"]
    if d.get("error"):
        print("  error:", d["error"].splitlines()[0]); ok = False
json.dump({"probe": "CF-013-restart-local", "ok": ok, "before": before, "after": after}, open(out, "w"), indent=2)
print("RESTART DRILL", "PASSED" if ok else "FAILED", "->", out)
sys.exit(0 if ok else 1)
EOF
