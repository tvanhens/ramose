#!/usr/bin/env bash
# Measure tsc --extendedDiagnostics for the nav-path typing prototype.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../../../.." && pwd)"
export PATH="${HOME}/.bun/bin:${PATH}"
cd "$ROOT"

echo "=== nav-prototype isolated ==="
bunx tsc --noEmit -p "$DIR/tsconfig.json" --extendedDiagnostics --pretty false

echo
echo "=== full workspace (comparison) ==="
bunx tsc --noEmit -p tsconfig.json --extendedDiagnostics --pretty false | tail -20
