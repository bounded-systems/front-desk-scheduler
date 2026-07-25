/**
 * @module scheduler
 * dispatch = prioritize ∘ budgetGate over the current ready set.
 *
 * This is the thin adapter from the World snapshot to the pure policy. It picks
 * WHICH item an agent should claim next; it does NOT perform the claim (that is
 * ops.claim) — keeping decision and effect separate is exactly what exposes the
 * check-then-act races.
 */

import { readySet, unblocksCount, type World, type WorkItem } from "./contract.ts";
import {
  budgetGate,
  planCapacity,
  prioritize,
  type PriorityInput,
  type GateDecision,
} from "./policy.ts";

/** Project a live WorkItem to the policy's PriorityInput. */
export function toPriorityInput(w: World, item: WorkItem): PriorityInput {
  return {
    number: item.number,
    title: item.title,
    kind: item.kind,
    state: item.phase === "InProgress" ? "in_progress" : "open",
    effort: item.effort,
    value: item.value,
    openBlockers: 0, // readySet already enforces deps satisfied
    unblocks: unblocksCount(w, item.number),
    ageDays: item.ageDays,
  };
}

/** The ranked ready queue an agent consults. Top of list is the pick. */
export function rankedQueue(w: World): PriorityInput[] {
  const ready = readySet(w).map((i) => toPriorityInput(w, i));
  const remaining = Math.max(w.budget.capacityPoints - w.budget.consumed, 0);
  return prioritize(ready, remaining).map((r) => ({
    number: r.number,
    title: r.title,
    kind: r.kind,
    state: r.state,
    effort: r.effort,
    value: r.value,
    openBlockers: r.openBlockers,
    unblocks: r.unblocks,
    ageDays: r.ageDays,
  }));
}

/** The item this agent should pick up next, or null if nothing is eligible. */
export function nextPick(w: World): number | null {
  const q = rankedQueue(w);
  return q.length > 0 ? q[0].number : null;
}

/** Admission check for spending `points` against the live budget snapshot. */
export function gateFor(w: World, points: number): GateDecision {
  const report = planCapacity(
    { id: w.budget.id, window: { kind: "rolling", durationHours: 5, label: "5h" }, capacityPoints: w.budget.capacityPoints, conversion: { unit: "tokens", unitPerPoint: 50_000 } },
    [],
    w.budget.consumed,
  );
  return budgetGate(report, points);
}
