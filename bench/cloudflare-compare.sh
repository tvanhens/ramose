#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "error: $*" >&2; exit 1; }

BASE="${BASE_REF:-master}"
LANES="${1:-32}"
PARALLEL="${2:-4}"
SECONDS_PER_PHASE="${3:-15}"
SRC="packages/ramose/src"

[ -z "$(git status --porcelain -- "$SRC")" ] || fail "$SRC has uncommitted changes; commit or stash them first."
git rev-parse --verify --quiet "$BASE" >/dev/null || fail "unknown base ref '$BASE' (set BASE_REF)."

restore() { git checkout --quiet HEAD -- "$SRC"; }
trap restore EXIT

echo ">> Benchmarking $BASE package source with this branch's harness ..."
git checkout --quiet "$BASE" -- "$SRC"
BENCH_LABEL="$BASE" bash bench/cloudflare.sh "$LANES" "$PARALLEL" "$SECONDS_PER_PHASE"
restore

echo ">> Benchmarking $(git rev-parse --abbrev-ref HEAD) ..."
BENCH_LABEL="$(git rev-parse --abbrev-ref HEAD)" bash bench/cloudflare.sh "$LANES" "$PARALLEL" "$SECONDS_PER_PHASE"
