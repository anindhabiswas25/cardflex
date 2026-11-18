#!/usr/bin/env bash
# Fails if any installed tool differs from the pins in toolchain.env.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../toolchain.env
source "$root/toolchain.env"

fail=0
check() { # name, expected, actual
  if [[ "$3" == "$2" ]]; then
    printf '  ok    %-16s %s\n' "$1" "$3"
  else
    printf '  FAIL  %-16s expected %s, found %s\n' "$1" "$2" "${3:-missing}"
    fail=1
  fi
}
ver() { "$@" 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true; }

echo "Checking toolchain against toolchain.env"
cd "$root"
check rustc          "$RUST_VERSION"   "$(ver rustc --version)"
check solana         "$SOLANA_VERSION" "$(ver solana --version)"
check anchor         "$ANCHOR_VERSION" "$(ver anchor --version)"
check node           "$NODE_VERSION"   "$(ver node --version)"
check pnpm           "$PNPM_VERSION"   "$(ver pnpm --version)"
check platform-tools "$PLATFORM_TOOLS_VERSION" \
  "$(cargo-build-sbf --version 2>/dev/null | grep -oE 'platform-tools v[0-9.]+' | awk '{print $2}' || true)"

# Pins inside manifests must agree with toolchain.env too.
grep -q "channel = \"$RUST_VERSION\"" rust-toolchain.toml || { echo "  FAIL  rust-toolchain.toml channel != $RUST_VERSION"; fail=1; }
grep -q "anchor-lang = \"=$ANCHOR_VERSION\"" Cargo.toml || { echo "  FAIL  Cargo.toml anchor-lang != =$ANCHOR_VERSION"; fail=1; }
grep -q "ephemeral-rollups-sdk = \"=$MB_ER_SDK_RS_VERSION\"" Cargo.toml || { echo "  FAIL  Cargo.toml ephemeral-rollups-sdk != =$MB_ER_SDK_RS_VERSION"; fail=1; }
grep -q "anchor_version = \"$ANCHOR_VERSION\"" Anchor.toml || { echo "  FAIL  Anchor.toml anchor_version != $ANCHOR_VERSION"; fail=1; }
grep -q "solana_version = \"$SOLANA_VERSION\"" Anchor.toml || { echo "  FAIL  Anchor.toml solana_version != $SOLANA_VERSION"; fail=1; }
grep -q "\"@magicblock-labs/ephemeral-validator\": \"$MB_VALIDATOR_VERSION\"" package.json || { echo "  FAIL  package.json ephemeral-validator != $MB_VALIDATOR_VERSION"; fail=1; }
grep -qx "$NODE_VERSION" .nvmrc || { echo "  FAIL  .nvmrc != $NODE_VERSION"; fail=1; }

if [[ $fail -ne 0 ]]; then
  echo "Toolchain mismatch. Install the pinned versions (see README.md)."
  exit 1
fi
echo "All pins match."
