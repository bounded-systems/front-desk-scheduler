#!/bin/bash
# SessionStart — provision the toolchain this repo validates itself with.
#
# Without this, a fresh web session starts degraded in ways that are easy to
# misread as real failures:
#   - no node_modules  ⇒ graph/list/whats-next tests die on ERR_MODULE_NOT_FOUND,
#                        looking like broken tests rather than a missing install
#   - no dolt          ⇒ every mirror WRITE path (sync, push, claim, migrations)
#                        is unavailable; reads still work over the public API
#   - no deno          ⇒ `deno check` (this repo's type gate; deno.json is the
#                        primary manifest) cannot run, AND deps cannot be
#                        installed at all — see the deps block below
#   - no lean          ⇒ specs/lean cannot be re-verified
#
# Order matters: deno is installed BEFORE deps, because `deno install --frozen`
# is what materialises node_modules from the tracked lockfile.
#
# Every toolchain fetch is best-effort and non-fatal: a network hiccup should
# start a slightly degraded session, never fail to start one. Each block is
# idempotent, and the container image is cached after the hook completes, so the
# slow first run is paid once.
set -uo pipefail

# Local runs already have whatever the developer chose to install.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "session-start: local session, skipping remote provisioning."
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

# --- dolt: the mirror's WRITE plane (reads go over the public HTTP API) -------
# Needed for scripts/sync.ts, push.ts, claim.ts and for applying
# schema/migrations/*.sql. Reads never require it.
if ! command -v dolt >/dev/null 2>&1; then
  echo "session-start: installing dolt ..."
  if [ "$(id -u)" = "0" ]; then
    curl -fsSL https://github.com/dolthub/dolt/releases/latest/download/install.sh | bash >/dev/null 2>&1 \
      || echo "session-start: WARN dolt install failed; mirror writes unavailable"
  else
    curl -fsSL https://github.com/dolthub/dolt/releases/latest/download/install.sh | sudo bash >/dev/null 2>&1 \
      || echo "session-start: WARN dolt install failed; mirror writes unavailable"
  fi
fi

# --- deno: `deno check` is this repo's type gate (deno.json is the manifest) --
if ! command -v deno >/dev/null 2>&1 && [ ! -x "$HOME/.deno/bin/deno" ]; then
  echo "session-start: installing deno ..."
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="$HOME/.deno" sh -s -- -y >/dev/null 2>&1 \
    || echo "session-start: WARN deno install failed; type checking unavailable"
fi
if [ -x "$HOME/.deno/bin/deno" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.deno/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
  # Fail rather than silently rewrite deno.lock. If a deno command wants to
  # change the lockfile, that is a real dependency-resolution change and should
  # be an explicit `deno install` + commit — not working-tree noise that every
  # session rediscovers and hand-curates. (deno.lock shipped incomplete until
  # 2026-07-27; that is exactly how the gap stayed invisible.)
  echo "export DENO_FROZEN_LOCKFILE=1" >> "$CLAUDE_ENV_FILE"
fi

# --- deps: install FROM THE LOCK, never re-resolve ---------------------------
# `deno install --frozen` materialises node_modules (deno.json sets
# nodeModulesDir: auto) from the tracked deno.lock, and FAILS if resolution
# would differ from it. That is the whole point: deno.lock is the single
# tracked lockfile, package-lock.json is gitignored, so `npm install` would
# resolve fresh and unpinned on every session — different bytes in CI, in a
# cloud session, and on a laptop, with nothing recording the difference.
#
# Node's test runner only needs node_modules to exist, so this covers it.
# If it fails, do NOT fall back to `npm install`: a lock mismatch is a real
# dependency change and wants an explicit `deno install` + commit.
if [ -f deno.json ] && [ -x "$HOME/.deno/bin/deno" ]; then
  echo "session-start: deno install --frozen ..."
  "$HOME/.deno/bin/deno" install --frozen || {
    echo "session-start: WARN deno install --frozen failed."
    echo "  If resolution differs from deno.lock: run \`deno install\` and COMMIT"
    echo "  the lockfile — do not paper over it with npm install."
    echo "  If the registry is unreachable: the cloud environment's network policy"
    echo "  likely blocks npm.jsr.io / jsr.io. See .claude/cloud-environment.json"
    echo "  for the domain list this repo needs."
  }
fi

# --- lean: re-verify specs/lean (Leases.lean = S1, FrontDesk.lean = S2) -------
# Heaviest of the four (downloads a toolchain on first use). Best-effort.
if [ ! -x "$HOME/.elan/bin/lake" ]; then
  echo "session-start: installing elan (Lean) ..."
  curl -fsSL https://elan.lean-lang.org/elan-init.sh \
    | sh -s -- -y --default-toolchain leanprover/lean4:stable >/dev/null 2>&1 \
    || echo "session-start: WARN elan install failed; specs/lean cannot be re-verified"
fi
if [ -x "$HOME/.elan/bin/lake" ] && [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"\$HOME/.elan/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

echo "session-start: ready — $(command -v dolt >/dev/null 2>&1 && echo dolt || echo 'no dolt')," \
     "$([ -x "$HOME/.deno/bin/deno" ] && echo deno || echo 'no deno')," \
     "$([ -x "$HOME/.elan/bin/lake" ] && echo lean || echo 'no lean')"
exit 0
