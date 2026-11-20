#!/usr/bin/env bash
# Runs a web browser test against the running stack with the saved test
# wallets: bash scripts/e2e.sh 2p|3p|wallet|refund
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; # shellcheck disable=SC1090
source "${CARDFLEX_ENV:-$HOME/.config/cardflex/devnet.env}"; set +a
suite="${1:?usage: scripts/e2e.sh 2p|3p|wallet|refund}"
cd "$root"
E2E_KEYS="$CARDFLEX_E2E_KEYS" E2E_OUT="${E2E_OUT:-${TMPDIR:-/tmp}}" TABLE="${TABLE:-$CARDFLEX_E2E_TABLE}" \
  APP_URL="http://localhost:${WEB_PORT}" pnpm -s --filter @card-flex/web "e2e:$suite"
