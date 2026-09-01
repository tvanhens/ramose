#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set."
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set."
command -v bun >/dev/null 2>&1 || fail "bun is not on PATH."

CONCURRENCY="${1:-32}"
SECONDS_PER_PHASE="${2:-10}"
STACK="bench/cloudflare/alchemy.run.ts"

echo ">> Building the package ..."
bun run scripts/build-packages.ts

STAGE="${ALCHEMY_STAGE:-bench-$(date +%s)-${RANDOM}}"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/ramose-bench-deploy.XXXXXX.log")"

export ALCHEMY_STATE=local
export ALCHEMY_STAGE="$STAGE"
export CI=1
export RAMOSE_BENCH_CAPABILITY="${RAMOSE_BENCH_CAPABILITY:-$(bun -e 'console.log(crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""))')}"

cleanup() {
  local cleanup_status=0
  if [ "${KEEP_STAGE:-0}" = "1" ]; then
    echo ">> KEEP_STAGE=1 set; leaving stage '$STAGE' deployed. Destroy later with:" >&2
    echo "   ALCHEMY_STATE=local CI=1 RAMOSE_BENCH_CAPABILITY=$RAMOSE_BENCH_CAPABILITY bun alchemy destroy $STACK --stage $STAGE --yes" >&2
  else
    echo ">> Destroying stage '$STAGE' ..." >&2
    local ok=""
    for attempt in $(seq 1 5); do
      if bun alchemy destroy "$STACK" --stage "$STAGE" --yes; then ok=1; break; fi
      echo ">> destroy attempt ${attempt} failed; retrying..." >&2
      sleep 5
    done
    if [ -z "$ok" ]; then
      echo "error: destroy failed for stage '$STAGE'; check the Cloudflare dashboard." >&2
      cleanup_status=1
    fi
  fi
  rm -f "$DEPLOY_LOG"
  return "$cleanup_status"
}

on_exit() {
  local status="$1"
  trap - EXIT
  if cleanup; then
    exit "$status"
  fi
  [ "$status" -ne 0 ] && exit "$status"
  exit 1
}
trap 'on_exit "$?"' EXIT

echo ">> Deploying bench stage '$STAGE' to Cloudflare ..."
bun alchemy deploy "$STACK" --stage "$STAGE" --yes 2>&1 | tee "$DEPLOY_LOG"

extract_url() {
  local key="$1"
  grep -oE "${key}: \"https://[^\"]+\"" "$DEPLOY_LOG" | head -1 \
    | sed -E "s/^${key}: \"//; s/\"$//"
}

URL="$(extract_url peerUrl)"
if [ -z "$URL" ]; then
  URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
fi
[ -n "$URL" ] || fail "could not find a Worker URL in the deploy output."

echo ">> Deployed bench peer: $URL"

echo ">> Waiting for $URL/health ..."
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "$URL/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || fail "peer did not become healthy at $URL/health within ~60s."
echo ">> Peer is healthy."

echo ">> Running write benchmark against $URL ..."
RAMOSE_URL="$URL" bun run bench/cloudflare/bench.ts "$CONCURRENCY" "$SECONDS_PER_PHASE"
