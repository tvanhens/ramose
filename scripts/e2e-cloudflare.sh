#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (see .cursor/CLOUD.md)."
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (see .cursor/CLOUD.md)."
command -v bun >/dev/null 2>&1 || fail "bun is not on PATH."

echo ">> Building the package ..."
bun run scripts/build-packages.ts

STAGE="${ALCHEMY_STAGE:-${E2E_STAGE:-e2e-$(date +%s)-${RANDOM}}}"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/ramose-e2e-deploy.XXXXXX.log")"
STATUS=0

export ALCHEMY_STATE=local
export ALCHEMY_STAGE="$STAGE"
export CI=1

cleanup() {
  if [ "${KEEP_STAGE:-0}" = "1" ]; then
    echo ">> KEEP_STAGE=1 set; leaving stage '$STAGE' deployed. Destroy later with:" >&2
    echo "   ALCHEMY_STATE=local CI=1 bun alchemy destroy --stage $STAGE --yes" >&2
  else

    echo ">> Destroying stage '$STAGE' ..." >&2
    ok=""
    for attempt in $(seq 1 5); do
      if bun alchemy destroy --stage "$STAGE" --yes; then ok=1; break; fi
      echo ">> destroy attempt ${attempt} failed; retrying..." >&2
      sleep 5
    done
    [ -n "$ok" ] || echo "warning: destroy failed for stage '$STAGE'; check the Cloudflare dashboard." >&2
  fi
  rm -f "$DEPLOY_LOG"
}
trap cleanup EXIT

echo ">> Deploying stage '$STAGE' to Cloudflare ..."
bun alchemy deploy --stage "$STAGE" --yes 2>&1 | tee "$DEPLOY_LOG"

extract_url() {
  local key="$1"
  grep -oE "${key}: \"https://[^\"]+\"" "$DEPLOY_LOG" | head -1 \
    | sed -E "s/^${key}: \"//; s/\"$//"
}

URL="$(extract_url peerUrl)"
if [ -z "$URL" ]; then
  URL="$(extract_url url)"
fi
if [ -z "$URL" ]; then
  URL="$(grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' "$DEPLOY_LOG" | head -n1 || true)"
fi
[ -n "$URL" ] || fail "could not find a Worker URL in the deploy output. If you use a custom domain, set RAMOSE_URL and run 'bun run test:e2e' directly."

echo ">> Deployed peer: $URL"

echo ">> Waiting for $URL/health ..."
ok=""
for _ in $(seq 1 30); do
  if curl -fsS "$URL/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || fail "peer did not become healthy at $URL/health within ~60s."
echo ">> Peer is healthy."

echo ">> Waiting for fail-closed /db/* ..."
RAMOSE_URL="$URL" bun scripts/e2e-warmup.ts
echo ">> Data plane is closed."

echo ">> Running e2e suite against $URL ..."
set +e
RAMOSE_URL="$URL" RAMOSE_TOKEN="${RAMOSE_TOKEN:-}" bun run test:e2e
STATUS=$?
set -e

exit "$STATUS"
