#!/usr/bin/env bash
# dolt-push — push a mirror clone, converging on a concurrent writer (#129).
#
#     scripts/dolt-push.sh [remote] [branch]     # run from inside the clone
#
# WHY THIS EXISTS
# ---------------
# Four workflows write the Dolt mirror: mirror-sync, mirror-sync-delta,
# mirror-migrate and lease-projection. Three share the `mirror-write`
# concurrency group; mirror-sync-delta does not, and cannot without losing the
# `cancel-in-progress: true` that coalesces webhook bursts into one run. One
# concurrency group cannot hold both cancel semantics, so serialization alone
# was never going to cover every writer.
#
# Measured, not theorised: on 2026-08-03 the delta syncer raced
# lease-projection into a rejected push TWICE in ten minutes (runs 30860614317
# and 30861016360), both times because a PR merge fired `board-changed` while
# the projection held a clone. The trigger correlates with exactly the moment
# the projection has work to do, so the race is concentrated on the writes
# being lost rather than uniformly spread.
#
# So the convergence lives at the push instead of at the scheduler: fetch the
# concurrent writer's commits, merge, push again. Every writer gets it, including
# ones nobody has written yet.
#
# WHY MERGING IS SAFE HERE, AND WHERE IT IS NOT
# ---------------------------------------------
# The writers touch disjoint tables — the syncers write `items`/`item_deps`,
# the projector writes `claims`, a migration writes schema — so the merge is
# ordinarily trivial. That is a property of who writes what TODAY, not an
# invariant, which is why a conflict is a hard failure below rather than
# something this script resolves. Resolving one would mean picking a winner
# between two writers that both believed they were authoritative, and nothing
# here knows enough to pick.
#
# Re-applying after a merge is safe for the projection specifically because its
# upsert is idempotent by (item_id, fencing) — the property docs/queue-vs-log.md
# names. This script does not re-run any producer, though: it merges COMMITTED
# work and pushes. The idempotency matters for the case where a run fails
# anyway and the next one re-projects.
#
# A REJECTION IS A RACE; ANYTHING ELSE IS AN ERROR
# ------------------------------------------------
# Same distinction the claim window draws between a refusal and an error. A
# non-fast-forward means "someone else got there first" and is retried. An auth
# failure, an unreachable remote, a conflict — none of those get better by
# retrying, and retrying them would turn a broken remote into a slow failure
# that reads like contention.
set -uo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-main}"
# Bounded: a writer that cannot land in five attempts is not losing a race, it
# is starving, and that should surface rather than spin.
ATTEMPTS="${DOLT_PUSH_ATTEMPTS:-5}"

conflict_count() {
  dolt sql -r csv -q 'SELECT COUNT(*) AS n FROM dolt_conflicts' 2>/dev/null | tail -1
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  out="$(dolt push "$REMOTE" "$BRANCH" 2>&1)"
  rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -eq 0 ]; then
    [ "$attempt" -gt 1 ] && echo "::notice::dolt-push: landed on attempt ${attempt} after converging with a concurrent writer (#129)"
    exit 0
  fi

  # Not a race — do not retry. Named so a red lane says WHICH failure it was,
  # which is the third done-when on #129.
  if ! printf '%s' "$out" | grep -qiE 'non-fast-forward|behind its remote|fetch first'; then
    echo "::error::dolt-push: push failed for a reason that is not contention — not retrying."
    exit "$rc"
  fi

  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    echo "::error::dolt-push: still rejected after ${ATTEMPTS} attempts. The mirror is being written faster than this job can converge — that is starvation, not a lost race (#129)."
    exit 1
  fi

  echo "::notice::dolt-push: rejected as non-fast-forward (attempt ${attempt}/${ATTEMPTS}) — a concurrent writer landed first; fetching and merging."

  if ! pull_out="$(dolt pull "$REMOTE" "$BRANCH" 2>&1)"; then
    printf '%s\n' "$pull_out"
    echo "::error::dolt-push: could not pull the concurrent writer's commits — cannot converge."
    exit 1
  fi
  printf '%s\n' "$pull_out"

  n="$(conflict_count)"
  if [ "${n:-0}" -gt 0 ] 2>/dev/null; then
    # Two writers changed the same rows. Picking a winner here would silently
    # discard one writer's work; the writers are supposed to own disjoint
    # tables, so this means that assumption broke and a human should see it.
    echo "::error::dolt-push: ${n} conflict(s) after merging ${REMOTE}/${BRANCH}. Two writers changed the same rows, which the disjoint-table assumption says should not happen — refusing to resolve automatically (#129)."
    dolt conflicts cat . 2>&1 | head -40
    exit 1
  fi

  # Linear backoff. The competing writers here are short jobs (~40s for the
  # delta), so this is about letting one finish, not about load-shedding.
  sleep "$((attempt * 3))"
done
