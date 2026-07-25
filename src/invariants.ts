/**
 * @module invariants
 * The scheduler's safety + liveness invariants — the spec itself.
 *
 * Mirrors machine-schema/state.ts: a human-readable string catalog
 * (`invariantSpecs`) plus an imperative `assertInvariants(world) → InvariantReport`
 * whose findings are `{ id, severity, message }`. These five lines ARE the thing
 * every projection (DST sim, TLA+, later Lean/Rust) checks.
 */

import { depsSatisfied, itemById, readySet, type World } from "./contract.ts";

export const invariantSpecs = [
  "S1: mutual-exclusion — at most one agent InProgress on any item",
  "S2: no-overspend — budget.consumed <= budget.capacityPoints, always",
  "S3: conservation — no item is both InProgress and Done; a claimed item has exactly one owner",
  "L1: deadlock-free — if a Ready item and an Idle agent both exist, progress is possible",
  "L2: starvation-free — under aging, every Ready item eventually reaches Done",
] as const;

export type InvariantSeverity = "hard" | "warn";

export interface InvariantFinding {
  readonly id: string;
  readonly severity: InvariantSeverity;
  readonly message: string;
}

export interface InvariantReport {
  readonly valid: boolean;
  readonly findings: InvariantFinding[];
}

/**
 * Safety invariants (S*) are checkable on any single snapshot. L1 is a snapshot
 * *liveness-hazard* check (deadlock detection); true L2 (starvation) needs a
 * trace, so the sim asserts it over a run, not here.
 */
export function assertInvariants(w: World): InvariantReport {
  const findings: InvariantFinding[] = [];
  const hard = (id: string, ok: boolean, message: string) => {
    if (!ok) findings.push({ id, severity: "hard", message });
  };

  // S1 — mutual exclusion: no two agents point at the same InProgress item.
  const owners = new Map<number, string[]>();
  for (const a of w.agents) {
    if (a.currentItem !== null) {
      const list = owners.get(a.currentItem) ?? [];
      list.push(a.id);
      owners.set(a.currentItem, list);
    }
  }
  for (const [itemId, holders] of owners) {
    hard(
      "S1",
      holders.length <= 1,
      `item #${itemId} claimed by ${holders.length} agents at once: ${holders.join(", ")}`,
    );
  }

  // S2 — no overspend.
  hard(
    "S2",
    w.budget.consumed <= w.budget.capacityPoints,
    `budget "${w.budget.id}" overspent: consumed ${w.budget.consumed} > cap ${w.budget.capacityPoints}`,
  );

  // S3 — conservation: item.ownerId agrees with agent.currentItem, and phase is consistent.
  for (const item of w.items) {
    const holders = owners.get(item.number) ?? [];
    if (item.phase === "InProgress") {
      hard("S3", item.ownerId !== null, `item #${item.number} InProgress but ownerId is null`);
      hard(
        "S3",
        holders.length === 1 && holders[0] === item.ownerId,
        `item #${item.number} owner mismatch: ownerId=${item.ownerId}, agents=[${holders.join(",")}]`,
      );
    } else {
      hard(
        "S3",
        item.ownerId === null && holders.length === 0,
        `item #${item.number} is ${item.phase} but still owned (ownerId=${item.ownerId}, agents=[${holders.join(",")}])`,
      );
    }
    hard(
      "S3",
      !(item.phase === "InProgress" && (item.phase as string) === "Done"),
      `item #${item.number} in two phases`,
    );
  }

  // L1 — deadlock hazard: an Idle agent + at least one item that is open-but-
  // never-Ready because of a "blocks" CYCLE (its deps can never all be Done).
  const idle = w.agents.some((a) => a.phase === "Idle");
  const anythingRunnable = readySet(w).length > 0;
  const anyOpenPending = w.items.some((i) => i.phase === "Ready" || i.phase === "Blocked");
  if (idle && anyOpenPending && !anythingRunnable) {
    const stuck = w.items.filter((i) => i.phase !== "Done" && inBlocksCycle(w, i.number));
    if (stuck.length > 0) {
      hard(
        "L1",
        false,
        `deadlock: idle agent but items [${stuck.map((s) => "#" + s.number).join(", ")}] are in a blocks-cycle and can never become Ready`,
      );
    }
  }

  return { valid: findings.length === 0, findings };
}

/** Is `id` part of a directed cycle following "blocks" edges? (deadlock detection) */
export function inBlocksCycle(w: World, id: number): boolean {
  const seen = new Set<number>();
  const stack = new Set<number>();
  const visit = (n: number): boolean => {
    if (stack.has(n)) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    stack.add(n);
    const item = itemById(w, n);
    for (const e of item?.edges ?? []) {
      if (e.type === "blocks" && visit(e.targetNumber)) return true;
    }
    stack.delete(n);
    return false;
  };
  return visit(id);
}

/** Helper for the sim's L2 check: is every item Done? */
export function allDone(w: World): boolean {
  return w.items.every((i) => i.phase === "Done");
}

/** Is any progress still possible (some item claimable now, or already running)? */
export function canProgress(w: World): boolean {
  if (readySet(w).length > 0) return true;
  return w.items.some((i) => i.phase === "InProgress");
}

/** Re-usable: an item that ought to be Ready (deps satisfied) but is still Blocked. */
export function shouldBeReady(w: World, item: { number: number; phase: string }): boolean {
  const full = itemById(w, item.number);
  return !!full && full.phase === "Blocked" && depsSatisfied(w, full);
}
