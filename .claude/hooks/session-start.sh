#!/bin/bash
# SessionStart — provision the toolchain this repo validates itself with.
#
# Without this, a fresh web session starts degraded in ways that are easy to
# misread as real failures:
#   - no node_modules  ⇒ test/graph.test.ts and test/list.test.ts die on
#                        ERR_MODULE_NOT_FOUND: zod, looking like broken tests
#   - no dolt          ⇒ every mirror WRITE path (sync, push, claim, migrations)
#                        is unavailable; reads still work over the public API
#   - no deno          ⇒ `deno check` (this repo's type gate; deno.json is the
#                        primary manifest) cannot run
#   - no lean          ⇒ specs/lean cannot be re-verified
#
# Only npm install is treated as important. Every toolchain fetch is best-effort
# and non-fatal: a network hiccup should start a slightly degraded session, never
# fail to start one. Each block is idempotent, and the container image is cached
# after the hook completes, so the slow first run is paid once.
set -uo pipefail

# Local runs already have whatever the developer chose to install.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "session-start: local session, skipping remote provisioning."
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

# --- npm deps (important: three test files + the verbs surface need them) -----
if [ -f package.json ]; then
  echo "session-start: npm install ..."
  npm install --no-audit --no-fund || {
    echo "session-start: WARN npm install failed."
    echo "  Most likely cause in a cloud session: the environment's network policy"
    echo "  blocks npm.jsr.io (the @bounded-systems/* deps live on JSR, not npmjs)."
    echo "  Fix: set network access to Custom and add the domains listed in the"
    echo "  README's cloud-environment note. Until then, graph/list/whats-next"
    echo "  tests and the fds verbs will fail on missing imports."
  }
fi

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
