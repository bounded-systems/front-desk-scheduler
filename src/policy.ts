/**
 * @module policy
 * The PURE, SEQUENTIAL scheduling policy — "which item, for how much, allowed?".
 *
 * PROVENANCE: vendored verbatim (signatures + logic) from
 *   bounded-systems/gh-project-room · prioritization.ts
 * It is pure (no I/O), so it lifts cleanly into this model. We copy rather than
 * depend so the model is self-contained AND so we can hold the policy fixed
 * while we deliberately break the *mechanism* (ops.ts) around it.
 *
 * This file models POLICY only. It has NO notion of concurrent agents, claiming,
 * or atomic spend — that mechanism (and its races) lives in ops.ts / sim.ts.
 * That gap is the entire point of the model.
 */

// --- kinds / states (mirrors gh-project-room/contract.ts) ---
export type BeadKind = "epic" | "room" | "door" | "task";
export type BeadState = "open" | "in_progress" | "blocked" | "closed";
export type BeadEdgeType = "parent-child" | "blocks" | "related" | "discovered-from";

export interface BeadEdge {
  readonly type: BeadEdgeType;
  readonly targetNumber: number;
}

// --- effort / budget ---
export type EffortPoints = number;

export type MeteredUnit = "tokens" | "agent-hours" | "usage-window-fraction" | "usd";

export interface ConversionMapping {
  readonly unit: MeteredUnit;
  readonly unitPerPoint: number;
}

export function toUnits(points: EffortPoints, mapping: ConversionMapping): number {
  return points * mapping.unitPerPoint;
}

export interface UsageWindow {
  readonly kind: "rolling" | "calendar";
  readonly durationHours: number;
  readonly label: string;
}

export interface Budget {
  readonly id: string;
  readonly window: UsageWindow;
  readonly capacityPoints: EffortPoints;
  readonly conversion: ConversionMapping;
}

// --- work items ---
export interface PriorityInput {
  readonly number: number;
  readonly title: string;
  readonly kind: BeadKind;
  readonly state: BeadState;
  readonly effort: EffortPoints;
  readonly value: number; // 0-100
  readonly openBlockers: number;
  readonly unblocks: number;
  readonly budgetId?: string;
  readonly ageDays?: number;
}

export interface RankedItem extends PriorityInput {
  readonly eligible: boolean;
  readonly score: number;
  readonly fitsRemaining: boolean;
}

// --- scoring config ---
export interface ScoreWeights {
  readonly density: number;
  readonly flow: number;
  readonly effortPenalty: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = { density: 1, flow: 2, effortPenalty: 0.05 };

export const FALLBACK_KIND_WEIGHT: Readonly<Record<BeadKind, number>> = {
  epic: 3,
  room: 2,
  door: 2,
  task: 1,
};

export const FALLBACK_AGE_WEIGHT_PER_DAY = 0.02;
export const FALLBACK_AGE_CAP_DAYS = 180;
export const AT_RISK_THRESHOLD = 0.8;

/** The `bd ready` rule: live AND zero open blockers. */
export function isEligible(item: PriorityInput): boolean {
  const live = item.state === "open" || item.state === "in_progress";
  return live && item.openBlockers === 0;
}

export function score(item: PriorityInput, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
  if (!isEligible(item)) return 0;

  // The degenerate fallback: with empty effort+value, this is what the LIVE board
  // runs, so dependency-bumps (kind=task, some age) float over substantive work.
  if (item.effort === 0 && item.value === 0) {
    const ageDays = Math.min(item.ageDays ?? 0, FALLBACK_AGE_CAP_DAYS);
    return (
      FALLBACK_KIND_WEIGHT[item.kind] +
      weights.flow * item.unblocks +
      FALLBACK_AGE_WEIGHT_PER_DAY * ageDays
    );
  }

  const effort = Math.max(item.effort, 1);
  const density = item.value / effort;
  return weights.density * density + weights.flow * item.unblocks - weights.effortPenalty * effort;
}

export function prioritize(
  items: readonly PriorityInput[],
  remainingPoints: number,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): RankedItem[] {
  const scored = items.map((item) => ({ item, s: score(item, weights) }));
  scored.sort((a, b) => b.s - a.s || a.item.effort - b.item.effort);

  let budgetLeft = remainingPoints;
  const ranked: RankedItem[] = [];
  for (const { item, s } of scored) {
    const eligible = isEligible(item);
    const fitsRemaining = eligible && item.effort <= budgetLeft;
    if (fitsRemaining) budgetLeft -= item.effort;
    ranked.push({ ...item, eligible, score: s, fitsRemaining });
  }
  return ranked;
}

// --- capacity / gate ---
export type CapacityStatus = "ok" | "at-risk" | "over";

export interface CapacityReport {
  readonly budget: Budget;
  readonly plannedPoints: EffortPoints;
  readonly plannedFits: boolean;
  readonly consumedPoints: EffortPoints;
  readonly remainingPoints: EffortPoints;
  readonly burnRatio: number;
  readonly status: CapacityStatus;
  readonly plannedUnits: number;
}

export function planCapacity(
  budget: Budget,
  plannedItems: readonly PriorityInput[],
  consumedPoints: EffortPoints,
): CapacityReport {
  const plannedPoints = plannedItems.reduce((sum, i) => sum + i.effort, 0);
  const plannedFits = plannedPoints <= budget.capacityPoints;
  const remainingPoints = Math.max(budget.capacityPoints - consumedPoints, 0);
  const burnRatio = budget.capacityPoints > 0 ? consumedPoints / budget.capacityPoints : Infinity;
  const overBurn = burnRatio >= 1;
  const status: CapacityStatus = overBurn || !plannedFits
    ? "over"
    : burnRatio >= AT_RISK_THRESHOLD
      ? "at-risk"
      : "ok";
  return {
    budget,
    plannedPoints,
    plannedFits,
    consumedPoints,
    remainingPoints,
    burnRatio,
    status,
    plannedUnits: toUnits(plannedPoints, budget.conversion),
  };
}

export interface GateDecision {
  readonly allow: boolean;
  readonly reason: string;
}

/**
 * The admission-control check. NOTE: this is a PURE decision over a snapshot.
 * It is the "check" half of a check-then-act. When two agents call it against the
 * same `report` and then each spends, they can BOTH be allowed and overspend —
 * that TOCTOU race is modeled in ops.ts (spendRacy), not here.
 */
export function budgetGate(report: CapacityReport, additionalPoints: EffortPoints = 0): GateDecision {
  if (report.budget.capacityPoints <= 0) {
    return { allow: true, reason: "no budget set — fail-open" };
  }
  const projected = report.consumedPoints + additionalPoints;
  if (projected >= report.budget.capacityPoints) {
    return { allow: false, reason: "exhausted — blocking new agent work until reset" };
  }
  if (report.status === "at-risk") {
    return { allow: true, reason: "at-risk — proceed but triage soon" };
  }
  return { allow: true, reason: "healthy" };
}

// --- org standard budgets ---
export const ROLLING_5H_BUDGET: Budget = {
  id: "rolling-5h",
  window: { kind: "rolling", durationHours: 5, label: "5h" },
  capacityPoints: 10,
  conversion: { unit: "tokens", unitPerPoint: 50_000 },
};

export const WEEKLY_BUDGET: Budget = {
  id: "weekly",
  window: { kind: "calendar", durationHours: 168, label: "weekly" },
  capacityPoints: 40,
  conversion: { unit: "tokens", unitPerPoint: 50_000 },
};

export const ORG_BUDGETS: ReadonlyMap<string, Budget> = new Map([
  [ROLLING_5H_BUDGET.id, ROLLING_5H_BUDGET],
  [WEEKLY_BUDGET.id, WEEKLY_BUDGET],
]);
