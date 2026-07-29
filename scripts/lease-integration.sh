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
# TWO SERVERS, BECAUSE AUTH_MODE IS A PROPERTY OF A DEPLOYMENT
# ------------------------------------------------------------
# Phase A runs the worker with its SHIPPED config and checks that an
# unauthenticated write is refused — the fail-closed direction, verified against
# the real runtime rather than the stub. Phase B restarts under
# `AUTH_MODE=none`, which is precisely the "scratch deployment where
# unauthenticated claims are an accepted property" this flag was added for, and
# races there. The race measures EXCLUSION; making 48 claims each depend on a
# live api.github.com round-trip would put someone else's rate limit inside our
# concurrency measurement and tell us nothing more about S1.
#
# Usage:  bash scripts/lease-integration.sh
#   LEASE_DEV_PORT (default 8787), WRANGLER_VERSION (default wrangler@4.114.0),
#   RACE_ITEM (default race#1) override behaviour; requires node (>=22.18, for
#   native TS) and network access to fetch wrangler via npx.
set -euo pipefail

PORT="${LEASE_DEV_PORT:-8787}"
WRANGLER="${WRANGLER_VERSION:-wrangler@4.114.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RACE_ITEM="${RACE_ITEM:-race#1}"
export RACE_ITEM
LOG="$(mktemp)"
DEV_PID=""

cleanup() {
  # Kill the dev server and any workerd it spawned. The runner is ephemeral, but
  # a lingering workerd is a SECOND serialization point — the exact failure this
  # Worker exists to remove — so never leave one behind mid-suite.
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null || true
  pkill -f workerd 2>/dev/null || true
}
trap cleanup EXIT

health() { curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true'; }

# start_dev [extra wrangler args...] — launch and block until /health answers.
start_dev() {
  LOG="$(mktemp)"
  (
    cd "$ROOT/worker/lease"
    WRANGLER_SEND_METRICS=false npx --yes "$WRANGLER" dev --ip 127.0.0.1 --port "$PORT" "$@"
  ) >"$LOG" 2>&1 &
  DEV_PID=$!

  for i in $(seq 1 60); do
    if health; then echo "   ready after ${i}s"; return 0; fi
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "::error::wrangler dev exited before becoming ready"
      echo "--- wrangler dev log ---"; cat "$LOG"; exit 1
    fi
    sleep 1
  done
  echo "::error::worker/lease did not become healthy in 60s"
  echo "--- wrangler dev log ---"; cat "$LOG"; exit 1
}

# stop_dev — and wait for the port to actually go quiet. Restarting while the
# old workerd still holds :8787 would race the two servers for the port, and the
# phase that lost would silently test the other one's config.
stop_dev() {
  [ -n "$DEV_PID" ] && kill "$DEV_PID" 2>/dev/null || true
  pkill -f workerd 2>/dev/null || true
  DEV_PID=""
  for _ in $(seq 1 30); do health || return 0; sleep 1; done
  echo "::error::a worker is still answering on :$PORT after stop"; exit 1
}

fail() { echo "::error::$1"; exit 1; }

# ── phase A: the shipped config refuses an unauthenticated write ──────────────
echo "-> phase A: starting worker/lease under $WRANGLER on 127.0.0.1:$PORT (shipped config)"
start_dev

echo "-> asserting the deployed worker fails CLOSED on an unauthenticated write"
body="$(mktemp)"
code="$(curl -s -o "$body" -w '%{http_code}' -X POST \
  -H 'content-type: application/json' --data '{"agent":"nobody","ttl_sec":60}' \
  "http://127.0.0.1:$PORT/claim?item_id=$RACE_ITEM")"
[ "$code" = "401" ] || { echo "--- response ---"; cat "$body"; fail "unauthenticated /claim answered $code, expected 401 — the deployed default is not fail-closed"; }

# The refusal must happen BEFORE the Durable Object: a 401 that still mutated
# state would mean the gate is decoration. /status is the observable.
curl -fsS "http://127.0.0.1:$PORT/status?item_id=$RACE_ITEM" | grep -q '"holder":null' \
  || fail "a refused claim still reached the DO — the item has a holder"
echo "   401, and the item still has no holder"
stop_dev

# ── phase B: race, with unauthenticated claims accepted on purpose ────────────
echo "-> phase B: restarting with AUTH_MODE=none (scratch race deployment)"
start_dev --var AUTH_MODE:none

export FDS_CLAIM_ENDPOINT="http://127.0.0.1:$PORT"

echo "-> racing the real Worker over HTTP: 16 agents, then 32"
node "$ROOT/scripts/claim-race.ts"
RACE_AGENTS=32 node "$ROOT/scripts/claim-race.ts"

echo "-> lease-integration: the real Worker granted exactly one claim under HTTP concurrency"
