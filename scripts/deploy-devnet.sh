#!/usr/bin/env bash
# Resumable devnet deploy for the Card Flex program.
#
# Writes the program into a buffer whose keypair is SAVED, so a failed or
# interrupted upload can simply be re-run: the CLI resends only the chunks
# that are missing or differ. Then upgrades the program from that buffer and
# checks the on-chain bytes match the local build.
#
# Usage: scripts/deploy-devnet.sh            (builds the devnet POC variant)
# Env:   CARDFLEX_KEYS (default ~/.config/cardflex), CARDFLEX_RPC (default MagicBlock devnet)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
keys="${CARDFLEX_KEYS:-$HOME/.config/cardflex}"
rpc="${CARDFLEX_RPC:-https://rpc.magicblock.app/devnet}"
fallback_rpc="https://api.devnet.solana.com"
deployer="$keys/devnet-deployer.json"
program_kp="$keys/card_flex-program-keypair.json"
buffer_kp="$keys/upgrade-buffer.json"
so="$root/target/deploy/card_flex.so"
program_id="$(solana-keygen pubkey "$program_kp")"

cd "$root"
echo "== build (devnet POC variant)"
anchor build -- --features poc-test-deck >/dev/null
size=$(stat -c %s "$so")
echo "   program size: $size bytes"

# Program space must hold the new binary.
slot=$(solana program show "$program_id" --url "$rpc" | awk '/Data Length/{print $3}')
if (( size > slot )); then
  extra=$(( (size - slot + 65535) / 65536 * 65536 ))
  echo "== extend program space by $extra bytes (slot $slot < $size)"
  solana program extend "$program_id" "$extra" --keypair "$deployer" --url "$rpc"
fi

[[ -f "$buffer_kp" ]] || solana-keygen new --no-bip39-passphrase --silent -o "$buffer_kp" >/dev/null
chmod 600 "$buffer_kp"
buffer="$(solana-keygen pubkey "$buffer_kp")"
echo "== write buffer $buffer (resumable)"
for attempt in 1 2 3 4 5 6; do
  url=$rpc; (( attempt % 2 == 0 )) && url=$fallback_rpc
  if solana program write-buffer "$so" --buffer "$buffer_kp" --keypair "$deployer" \
       --url "$url" --use-rpc --with-compute-unit-price 20000 --max-sign-attempts 50 >/dev/null 2>&1; then
    echo "   buffer complete (attempt $attempt via $url)"; break
  fi
  echo "   attempt $attempt via $url incomplete; resuming"
  (( attempt == 6 )) && { echo "buffer upload failed; re-run this script to resume"; exit 1; }
done

echo "== upgrade program from buffer"
solana program upgrade "$buffer" "$program_id" --upgrade-authority "$deployer" \
  --keypair "$deployer" --url "$rpc" || solana program upgrade "$buffer" "$program_id" \
  --upgrade-authority "$deployer" --keypair "$deployer" --url "$fallback_rpc"
# The upgrade consumes the buffer; use a fresh one next time.
rm -f "$buffer_kp"

echo "== verify on-chain bytes"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
solana program dump "$program_id" "$tmp/onchain.so" --url "$rpc" >/dev/null
python3 -I - "$tmp/onchain.so" "$so" <<'EOF'
import sys
a, b = open(sys.argv[1], "rb").read(), open(sys.argv[2], "rb").read()
ok = a[:len(b)] == b and set(a[len(b):]) <= {0}
print("   on-chain program matches local build" if ok else "   MISMATCH between on-chain and local build")
sys.exit(0 if ok else 1)
EOF
