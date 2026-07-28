#!/usr/bin/env bash
#
# lease-integration — race the REAL worker/lease under a local workerd.
#
# Runs the DEPLOYED Worker CODE (worker/lease/src/index.mjs: the real LeaseObject,
# real Durable Object SQLite storage, real input-gate serialization) under
# `wrangler dev`, then points the production-a2 racer (scripts/claim-race.ts) at
# it over real HTTP by setting FDS_CLAIM_ENDPOINT — i.e. the `lease` plane.
#
# WHAT THIS ESTABLISHES — and, as carefully, WHAT IT DOES NOT
# ----------------------------------------------------------
# Establishes A1' + the real shell: the code that will run in production grants
# exactly one claim among N concurrent HTTP claimants, with the RUNTIME — not a
# fake single-threaded storage (worker/lease/src/index.test.mjs states plainly it
# does not test this) — applying one transition at a time. That closes the gap
# between "the pure core is proven" (lease-core.test.mjs) and "the deployed
# Worker actually excludes".
#
# Does NOT establish A2. Like harness-a1, and UNLIKE production-a2, this
# provisions the single serialization point it then relies on: one local workerd
# is one instance by construction. A2 — that every claimant in the real
# deployment reaches ONE GLOBAL instance — is discharged only by production-a2
# against the deployed endpoint. This rung is strictly stronger than the
# in-process stub and strictly weaker than production-a2, and it is labelled as
# neither.
#
# Usage:  bash scripts/lease-integration.sh
#   LEASE_DEV_PORT (default 8787), WRANGLER_VERSION (default wrangler@4.114.0),
#   RACE_ITEM (default race#1) override behaviour; requires node (>=22.18, for
#   native TS) and network access to fetch wrangler via npx.
set -euo pipefail

PORT="${LEASE_DEV_PORT:-8787}"
WRANGLER="${WRANGLER_VERSION:-wrangler@4.114.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp)"

cleanup() {
  # Kill the dev server and any workerd it spawned. The runner is ephemeral, but
  # a lingering workerd is a SECOND serialization point — the exact failure this
  # Worker exists to remove — so never leave one behind mid-suite.
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null || true
  pkill -f workerd 2>/dev/null || true
}
trap cleanup EXIT

echo "-> starting worker/lease under $WRANGLER on 127.0.0.1:$PORT (local workerd)"
(
  cd "$ROOT/worker/lease"
  WRANGLER_SEND_METRICS=false npx --yes "$WRANGLER" dev --ip 127.0.0.1 --port "$PORT"
) >"$LOG" 2>&1 &
DEV_PID=$!

echo "-> waiting for /health"
ready=""
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "   ready after ${i}s"; ready=1; break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "::error::wrangler dev exited before becoming ready"; echo "--- wrangler dev log ---"; cat "$LOG"; exit 1
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "::error::worker/lease did not become healthy in 60s"; echo "--- wrangler dev log ---"; cat "$LOG"; exit 1
fi

export FDS_CLAIM_ENDPOINT="http://127.0.0.1:$PORT"
export RACE_ITEM="${RACE_ITEM:-race#1}"

echo "-> racing the real Worker over HTTP: 16 agents, then 32"
node "$ROOT/scripts/claim-race.ts"
RACE_AGENTS=32 node "$ROOT/scripts/claim-race.ts"

echo "-> lease-integration: the real Worker granted exactly one claim under HTTP concurrency"
