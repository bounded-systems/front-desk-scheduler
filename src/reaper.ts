/**
 * @module reaper
 * The pure half of the lease reaper (#105) — scripts/reap-leases.ts is the
 * runner, this is every decision it makes, testable without a network.
 *
 * "GC as ref": the holder does not push liveness; the reaper pulls it. A lease
 * bound to a referent is released when the referent is observed merged, closed,
 * or gone — the event-shaped release the TTL was a proxy for. The TTL survives
 * as a BACKSTOP, sized to "the reaper has been broken for a day", so an expiry
 * is a monitorable anomaly rather than normal operation.
 *
 * WHAT THE REAPER CAN AND CANNOT SEE, STATED (the lease-projection posture):
 *
 *   candidates   A `DurableObjectNamespace` cannot be enumerated (#84), so the
 *                candidate set is derived from the mirror: schedulable items,
 *                recently-closed items (THE reap case — a PR merge closes the
 *                item while the lease is still held), and items the projection
 *                says have an active grant. A lease outside that union — e.g.
 *                on an item closed months ago, claimed since, and not yet
 *                projected — is INVISIBLE to the sweep until the projection
 *                catches up (≤ one lease-projection run). The backstop TTL
 *                bounds what invisibility can cost.
 *
 *   liveness     Per candidate the reaper reads /status — DO ground truth, no
 *                lag. The fencing and referent it presents to /reap come from
 *                that one snapshot, and the DO refuses the pair if the world
 *                moved in between. Stale evidence is a SKIP, never a retry.
 *
 *   referents    `pr` is the kind interpreted today. An unrecognised kind is
 *                reported and skipped — NOT treated as immortal; the backstop
 *                still bounds it. Unobservable is not closed: a probe that
 *                cannot distinguish "gone" from "not visible to this token"
 *                must skip, or objection 2 of #105 (the oracle itself is down)
 *                becomes a false release.
 */

import type { LeaseReferent, LeaseStatus } from "./lease-client.ts";

/** Candidate item_ids, from the mirror over the unauthenticated read plane.
 *
 * Three bounded queries, not one whole-table walk (#88): the schedulable set is
 * the same non-Done read `next` accepts unpaginated (~hundreds), the closed
 * window is time-bounded, and projected-active is bounded by concurrent
 * holders. The union deliberately over-approximates — /status on a lease-less
 * item is one cheap open read.
 */
export const CANDIDATE_SQL = {
  schedulable: "SELECT item_id FROM items WHERE status <> 'Done' AND closed_at IS NULL",
  // The marquee case (#93/#103): the merge auto-closed the item while the lease
  // had 52 minutes left. 14 days is comfortably wider than any backstop.
  recentlyClosed:
    "SELECT item_id FROM items WHERE closed_at IS NOT NULL AND closed_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL 14 DAY)",
  projectedActive: "SELECT DISTINCT item_id FROM claims WHERE status = 'active'",
} as const;

/** What one /status snapshot tells the sweep to do next. */
export type ReapPlan =
  | { readonly action: "skip"; readonly reason: "not-live" | "no-referent" }
  | { readonly action: "skip"; readonly reason: "unrecognized-kind"; readonly kind: string }
  | { readonly action: "probe-pr"; readonly pr: PrRef; readonly fencing: number; readonly referent: LeaseReferent }
  | { readonly action: "skip"; readonly reason: "malformed-referent"; readonly id: string };

export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/** `owner/repo#number` — the `pr` kind's id shape. Null when it does not parse. */
export function parsePrReferent(id: string): PrRef | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(id.trim());
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
}

/** Decide, from one /status snapshot, whether there is anything to probe. */
export function planReap(status: LeaseStatus): ReapPlan {
  if (!status.live) return { action: "skip", reason: "not-live" };
  if (status.referent === null) {
    // Never materialized — the backstop's corpse, not the reaper's (#105
    // checklist: "it must not silently mean immortal", and it does not: the
    // short claim TTL is still ticking).
    return { action: "skip", reason: "no-referent" };
  }
  if (status.referent.kind !== "pr") {
    return { action: "skip", reason: "unrecognized-kind", kind: status.referent.kind };
  }
  const pr = parsePrReferent(status.referent.id);
  if (pr === null) return { action: "skip", reason: "malformed-referent", id: status.referent.id };
  return { action: "probe-pr", pr, fencing: status.fencing, referent: status.referent };
}

/** What the runner observed about a PR referent, reduced to what the verdict
 *  needs. `prHttpStatus` 404 is AMBIGUOUS on GitHub — a missing PR and a repo
 *  this token cannot see answer identically — which is why the repo probe
 *  rides along. */
export interface PrProbe {
  readonly prHttpStatus: number;
  /** From the PR body when prHttpStatus is 200. */
  readonly state?: "open" | "closed";
  readonly merged?: boolean;
  /** HTTP status of GET /repos/{owner}/{repo}; only consulted on a PR 404. */
  readonly repoHttpStatus?: number;
}

export type ReapVerdict =
  | { readonly collect: true; readonly why: "merged" | "closed" | "gone" }
  | { readonly collect: false; readonly why: "alive" | "unobservable" };

/**
 * The oracle judgment. The asymmetry is the point: collecting requires a
 * POSITIVE observation of the referent being finished (merged/closed) or
 * provably absent (repo visible, PR not). Anything the probe cannot pin down
 * is `unobservable`, which releases NOTHING — that is objection 2 of #105
 * ("the oracle itself is down"), and the backstop TTL is its answer.
 */
export function verdictFromPrProbe(p: PrProbe): ReapVerdict {
  if (p.prHttpStatus === 200) {
    if (p.state === "closed") return { collect: true, why: p.merged === true ? "merged" : "closed" };
    if (p.state === "open") return { collect: false, why: "alive" };
    return { collect: false, why: "unobservable" };
  }
  if (p.prHttpStatus === 404) {
    // Only a visible repo makes the PR's absence a fact about the PR.
    if (p.repoHttpStatus === 200) return { collect: true, why: "gone" };
    return { collect: false, why: "unobservable" };
  }
  return { collect: false, why: "unobservable" };
}

/** The sweep's honesty ledger — every candidate lands in exactly one bucket,
 *  so "covered everything" is a claim the numbers back or refute. */
export interface SweepReport {
  candidates: number;
  polled: number;
  live: number;
  reaped: number;
  /** DO refused the reap — evidence went stale between /status and /reap. */
  refused: number;
  skipped: {
    notLive: number;
    noReferent: number;
    unrecognizedKind: number;
    malformedReferent: number;
    alive: number;
    unobservable: number;
  };
  /** /status or probe transport failures — the sweep is INCOMPLETE if > 0. */
  failures: number;
}

export function emptyReport(): SweepReport {
  return {
    candidates: 0,
    polled: 0,
    live: 0,
    reaped: 0,
    refused: 0,
    skipped: { notLive: 0, noReferent: 0, unrecognizedKind: 0, malformedReferent: 0, alive: 0, unobservable: 0 },
    failures: 0,
  };
}
