/**
 * @module ops
 * The concurrent transitions — the MECHANISM around the pure policy.
 *
 * Each effect has a `racy` and a `safe` variant. The whole model turns on this
 * contrast: run the sim with `racy` and a seed reproduces an invariant violation;
 * swap to `safe` and the same interleavings hold the invariants.
 *
 * The races are check-then-act splits. The "check" happens elsewhere (the sim
 * reads the world / calls the gate), producing a decision against a snapshot;
 * these functions are the "act". A racy act trusts the (possibly stale) decision;
 * a safe act re-validates atomically at commit time (compare-and-swap).
 */

import { depsSatisfied, itemById, type World } from "./contract.ts";

export type OpMode = "racy" | "safe";

export interface ClaimResult {
  readonly won: boolean;
  readonly reason: string;
}

/**
 * Commit a claim of `itemId` by `agentId`. The sim decided `itemId` was the top
 * ready pick against an EARLIER snapshot; between then and now another agent may
 * have taken it.
 *
 * racy: assign unconditionally → two agents that both decided on the same item
 *       both become owners → S1 (double-claim) violation.
 * safe: CAS — assign only if still unowned, Ready, and deps satisfied.
 */
export function commitClaim(w: World, agentId: string, itemId: number, mode: OpMode): ClaimResult {
  const item = itemById(w, itemId);
  const agent = w.agents.find((a) => a.id === agentId);
  if (!item || !agent) return { won: false, reason: "missing item/agent" };

  const claimable = item.ownerId === null && item.phase === "Ready" && depsSatisfied(w, item);

  if (mode === "safe" && !claimable) {
    agent.phase = "Idle";
    agent.currentItem = null;
    return { won: false, reason: `lost race for #${itemId} (owner=${item.ownerId}, phase=${item.phase})` };
  }

  // racy: no re-check. safe: passed the CAS above.
  item.ownerId = agentId;
  item.phase = "InProgress";
  agent.currentItem = itemId;
  agent.phase = "Working";
  return { won: true, reason: claimable ? "claimed" : "claimed (racy, over a taken item)" };
}

export interface SpendResult {
  readonly applied: boolean;
  readonly reason: string;
}

/**
 * Apply a spend of `points` to the shared budget. The sim called the budget gate
 * earlier and got `gateAllowedStale` against the consumed value AT THAT TIME.
 *
 * racy: trust the stale decision → two agents that both passed the gate against
 *       the same `consumed` both add → consumed can exceed cap → S2 violation.
 * safe: atomic reserve — re-read consumed NOW and add only if it still fits.
 */
export function applySpend(
  w: World,
  points: number,
  gateAllowedStale: boolean,
  mode: OpMode,
): SpendResult {
  if (mode === "racy") {
    if (!gateAllowedStale) return { applied: false, reason: "gate denied (stale)" };
    w.budget.consumed += points; // no re-check → the TOCTOU window
    return { applied: true, reason: "spent (racy)" };
  }
  // safe: compare-and-add against the live counter.
  if (w.budget.consumed + points <= w.budget.capacityPoints) {
    w.budget.consumed += points;
    return { applied: true, reason: "spent (safe reserve)" };
  }
  return { applied: false, reason: "denied — would exceed cap (safe)" };
}

export interface CompleteResult {
  readonly woken: number[];
}

/**
 * Finish the agent's current item: mark Done, release ownership, free the agent,
 * then re-scan blocked items whose deps are now satisfied.
 *
 * racy: SKIP the re-scan → dependents whose last blocker just completed never
 *       re-enter Ready → lost wakeup (a liveness bug; surfaces as starvation).
 * safe: signal — promote every now-unblocked item to Ready.
 */
export function complete(w: World, agentId: string, mode: OpMode): CompleteResult {
  const agent = w.agents.find((a) => a.id === agentId);
  if (!agent || agent.currentItem === null) return { woken: [] };
  const item = itemById(w, agent.currentItem);
  if (item) {
    item.phase = "Done";
    item.ownerId = null;
  }
  agent.currentItem = null;
  agent.phase = "Idle";

  if (mode === "racy") return { woken: [] };

  const woken: number[] = [];
  for (const candidate of w.items) {
    if (candidate.phase === "Blocked" && depsSatisfied(w, candidate)) {
      candidate.phase = "Ready";
      woken.push(candidate.number);
    }
  }
  return { woken };
}
