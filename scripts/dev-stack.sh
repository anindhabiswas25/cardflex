#!/usr/bin/env bash
# Starts the local Devnet stack: keeper + indexer API + web app.
# Settings (key paths, tables, ports) come from ~/.config/cardflex/devnet.env
# (or $CARDFLEX_ENV); keys never live in the repo. Ctrl-C stops everything.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${CARDFLEX_ENV:-$HOME/.config/cardflex/devnet.env}"
[[ -f "$env_file" ]] || { echo "missing $env_file (see docs/runbooks/keeper.md)"; exit 2; }
set -a; # shellcheck disable=SC1090
source "$env_file"; set +a
mkdir -p "$(dirname "$CARDFLEX_DB")"
for p in "$HEALTH_PORT" "$PORT" "$WEB_PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":$p "; then echo "port $p is in use (stop the old process first)"; exit 1; fi
done
cd "$root"
pids=()
# Each service runs in its own process group, so stopping kills pnpm, node
# and the log filter together (killing only the wrapper left them running).
stop() {
  trap - INT TERM EXIT
  for p in "${pids[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop INT TERM EXIT
run() {
  local name=$1; shift
  setsid bash -c '"$@" 2>&1 | sed -u "s/^/['"$name"'] /"' _ "$@" &
  pids+=($!)
}

run keeper env CARDFLEX_KEEPER_KEY="$CARDFLEX_KEEPER_KEY" CARDFLEX_TABLES="$CARDFLEX_TABLES" CARDFLEX_DB="$CARDFLEX_DB" \
  HEALTH_PORT="$HEALTH_PORT" HAND_GAP_SECS="$HAND_GAP_SECS" pnpm -s keeper
run api env CARDFLEX_DB="$CARDFLEX_DB" PORT="$PORT" pnpm -s api
run web pnpm -s --filter @card-flex/web dev --port "$WEB_PORT"
echo "keeper health http://127.0.0.1:$HEALTH_PORT/health · api http://127.0.0.1:$PORT · app http://localhost:$WEB_PORT"
wait
