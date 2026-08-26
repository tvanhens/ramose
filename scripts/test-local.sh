#!/usr/bin/env bash
#
# Alchemy local integration (`test/local`). One sidecar, serial files.
#
# Starting many workerd peers at once can hit SQLITE_BUSY
# (`WorkerdStartFailed`); the proxy still binds a port and /health never
# answers. Retry the whole process once — leftovers die with the first
# bun test process.
set -euo pipefail
cd "$(dirname "$0")/.."

export CI="${CI:-1}"
export ALCHEMY_STATE="${ALCHEMY_STATE:-local}"
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-0123456789abcdef0123456789abcdef}"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-x}"

run() {
  bun test --parallel=1 test/local
}

log="$(mktemp "${TMPDIR:-/tmp}/ramose-test-local.XXXXXX.log")"
cleanup() { rm -f "$log"; }
trap cleanup EXIT

if run 2>&1 | tee "$log"; then
  exit 0
fi
if grep -qE 'WorkerdStartFailed|SQLITE_BUSY|database is locked|did not answer GET /health within' "$log"; then
  echo ">> transient workerd start failure; retrying test:local once" >&2
  run
  exit $?
fi
exit 1
