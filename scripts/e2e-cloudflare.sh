#!/usr/bin/env bash
#
# Run the e2e suite (test/e2e) against a REAL Cloudflare deployment.
#
# Deploys the Ramose stack to a throwaway, uniquely-named stage, waits for the
# peer's /health to answer, runs `bun run test:e2e` against the deployed URL,
# then destroys the stage — even if the tests fail.
#
# Required env:
#   CLOUDFLARE_API_TOKEN   API token that can deploy Workers + R2 (+ Durable
#                          Objects, which ride on Workers Scripts). See
#                          CONTRIBUTING.md for the exact permission groups.
#   CLOUDFLARE_ACCOUNT_ID  The account to deploy into.
#
# Optional:
#   ALCHEMY_STAGE / E2E_STAGE  Override the throwaway stage name
#                              (default: e2e-<epoch>-<rand>).
#   RAMOSE_TOKEN               Bearer token if you deploy an authenticated peer.
#                              The default deploy is an open peer.
#   KEEP_STAGE=1               Do not destroy the stage on exit (debug).
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... ./scripts/e2e-cloudflare.sh
#   bun run test:e2e:cf
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is not set (see .cursor/CLOUD.md)."
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "CLOUDFLARE_ACCOUNT_ID is not set (see .cursor/CLOUD.md)."
command -v bun >/dev/null 2>&1 || fail "bun is not on PATH."

# The Worker entry is `packages/worker/src/index.ts`, but it imports its
# siblings as bare specifiers (`@ramose/transactor`), which the bundler
# resolves through each package's `exports` — and those point at `dist`. Build
# first or the deploy succeeds and the Worker dies at runtime with
# `ScriptModuleNotFound: No such module "@ramose/transactor"`.
echo ">> Building packages ..."
bun run scripts/build-packages.ts

# Unique DNS-safe stage so concurrent runs never share Worker/DO/R2 resources.
STAGE="${ALCHEMY_STAGE:-${E2E_STAGE:-e2e-$(date +%s)-${RANDOM}}}"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/ramose-e2e-deploy.XXXXXX.log")"
STATUS=0

# Local state store: this run's state lives in ./.alchemy, so destroy
# reconciles against exactly what we deployed. CI=1 makes Alchemy use
# env-var credentials non-interactively.
export ALCHEMY_STATE=local
export ALCHEMY_STAGE="$STAGE"
export CI=1

cleanup() {
  if [ "${KEEP_STAGE:-0}" = "1" ]; then
    echo ">> KEEP_STAGE=1 set; leaving stage '$STAGE' deployed. Destroy later with:" >&2
    echo "   ALCHEMY_STATE=local CI=1 bun alchemy destroy --stage $STAGE --yes" >&2
  else
    # R2 empty-then-delete can 409 if list/delete races with recent puts; retry.
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

# Stack outputs from alchemy.run.ts: { url, peerUrl }. Prefer peerUrl, then
# url, then the first workers.dev host in the log.
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

# /health only exercises the Worker fetch handler. Fresh DO namespaces often
# answer "Worker not found" for a few seconds after deploy; /info hits both
# the Transactor and a QueryReplica.
echo ">> Waiting for Durable Objects (GET /db/e2e-warmup/info) ..."
ok=""
for _ in $(seq 1 45); do
  body="$(mktemp "${TMPDIR:-/tmp}/ramose-e2e-warmup.XXXXXX")"
  code="$(curl -sS -o "$body" -w '%{http_code}' "$URL/db/e2e-warmup/info" || echo 000)"
  if [ "$code" = "200" ]; then
    ok=1
    rm -f "$body"
    break
  fi
  # Surface the platform error while we wait (truncated).
  head -c 200 "$body" 2>/dev/null | tr '\n' ' ' >&2 || true
  echo " (HTTP $code); retrying..." >&2
  rm -f "$body"
  sleep 2
done
[ -n "$ok" ] || fail "Durable Objects not ready at $URL/db/e2e-warmup/info within ~90s."
echo ">> Durable Objects ready."

echo ">> Running e2e suite against $URL ..."
set +e
RAMOSE_URL="$URL" RAMOSE_TOKEN="${RAMOSE_TOKEN:-}" bun run test:e2e
STATUS=$?
set -e

exit "$STATUS"
