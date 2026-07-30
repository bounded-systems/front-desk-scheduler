/**
 * @module contract
 * The scheduler state machine — the MECHANISM the pure policy runs inside.
 *
 * Follows machine-schema's public pattern: explicit TS types + thin `parse*`
 * seams, no exported schema objects. Phases are precedence-ordered string tuples
 * (mirroring machine-schema's `workflowPhases`).
 *
 * A `World` is the snapshot the invariants (invariants.ts) run against, and the
 * ops (ops.ts) transition. This is where concurrency lives — the policy in
 * policy.ts knows nothing about agents, claiming, or a live `consumed` counter.
 */

import type { BeadEdge, BeadKind, EffortPoints } from "./policy.ts";

// --- work-item lifecycle (the scheduler's view of a bead's status) ---
// Ready ⟺ open ∧ every "blocks"-dep is Done  (the ready rule).
export const itemPhases = ["Blocked", "Ready", "InProgress", "Done"] as const;
export type ItemPhase = (typeof itemPhases)[number];

// --- agent lifecycle (a "thread") ---
export const agentPhases = ["Idle", "Claiming", "Working", "Releasing"] as const;
export type AgentPhase = (typeof agentPhases)[number];

/** A branded-ish id kept as a plain number (issue number) for model legibility. */
export type ItemId = number;
export type AgentId = string;

export interface WorkItem {
  readonly number: ItemId;
  readonly title: string;
  readonly kind: BeadKind;
  phase: ItemPhase;
  /** effort/value drive the policy; empty (0,0) reproduces the live-board degeneracy. */
  readonly effort: EffortPoints;
  readonly value: number;
  readonly ageDays: number;
  /** "blocks" edges → the dependency DAG. targetNumber must be Done before this is Ready. */
  readonly edges: readonly BeadEdge[];
  /** who currently holds it (mutual-exclusion subject). null ⟺ not InProgress. */
  ownerId: AgentId | null;
}

export interface Agent {
  readonly id: AgentId;
  phase: AgentPhase;
  currentItem: ItemId | null;
  /** effort points this agent will spend to finish its current item. */
  readonly capacity: EffortPoints;
}

/** The shared budget resource — a token bucket. `consumed` is mutated by spend(). */
export interface MutBudget {
  readonly id: string;
  readonly capacityPoints: EffortPoints;
  consumed: EffortPoints;
}

export interface World {
  items: WorkItem[];
  agents: Agent[];
  budget: MutBudget;
  clock: number;
}

// --- parse seams (non-empty / shape gates, no exported schema) ---

export function parseAgentId(value: string): AgentId {
  if (value.length === 0) throw new Error("empty AgentId");
  return value;
}

/** Deep-clone a World so each simulation step operates on an isolated snapshot. */
export function cloneWorld(w: World): World {
  return {
    clock: w.clock,
    budget: { ...w.budget },
    agents: w.agents.map((a) => ({ ...a })),
    items: w.items.map((i) => ({ ...i, edges: i.edges.map((e) => ({ ...e })) })),
  };
}

// --- derived predicates ---

export function itemById(w: World, id: ItemId): WorkItem | undefined {
  return w.items.find((i) => i.number === id);
}

/** The ready rule as a snapshot predicate: not started, and all blockers Done. */
export function depsSatisfied(w: World, item: WorkItem): boolean {
  return item.edges
    .filter((e) => e.type === "blocks")
    .every((e) => itemById(w, e.targetNumber)?.phase === "Done");
}

/** Items eligible to be claimed right now. */
export function readySet(w: World): WorkItem[] {
  return w.items.filter((i) => i.phase === "Ready" && i.ownerId === null && depsSatisfied(w, i));
}

/** How many items each item unblocks downstream (the flow / critical-path term). */
export function unblocksCount(w: World, id: ItemId): number {
  return w.items.filter((i) => i.edges.some((e) => e.type === "blocks" && e.targetNumber === id))
    .length;
}
