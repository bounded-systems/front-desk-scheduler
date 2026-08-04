/**
 * @module held
 * Live lease exclusion for the pick and the top N — #135, discharging the scope
 * #43 ratified and then closed without.
 *
 * ## What was wrong
 *
 * On the lease plane the Durable Object is the adjudicator and **no `leases` row
 * is ever written**. `SQL.leases` reads that table, so `assembleScheduling`
 * receives an empty held set and marks every item `leased: false`. Measured
 * against the live mirror on 2026-08-04: `SELECT COUNT(*) FROM leases → 0`.
 *
 * The consequence is not subtle. A session held a lease on #127 from 01:18 to
 * 01:43 that day; at 01:31 `next` ranked **#127 first and ready**. Front Desk
 * exists to answer "what should I work on next?", and it was answering with
 * items someone else was actively holding.
 *
 * ## Why per-item, and why only the top N
 *
 * There is no batch route and there cannot be one: `worker/lease/src/index.mjs`
 * addresses a DO per item (`canonicalItemId` → `idFromName` → stub) and a
 * `DurableObjectNamespace` cannot be enumerated. So it is per-item fan-out or
 * nothing — which is exactly why #43 scoped this to the pick and the top N
 * rather than the whole board, and split the remainder to #84.
 *
 * The bound matters: `top` is 10 by default, so this is ten open GETs, and the
 * read plane keeps its no-credential property because `/status` is open (like
 * `/history`). Nothing here needs a token.
 *
 * ## Two deliberate choices
 *
 * **It fails OPEN.** A probe that errors leaves the item in the queue. Hiding
 * possibly-available work because a monitor hiccuped is worse than the status
 * quo it replaces, and the reaper already limits how long a stale hold lasts.
 * But an unobserved probe is *counted and reported* — silently degrading to the
 * old behaviour is how a caller comes to trust an exclusion that isn't running.
 * This mirrors `verdictFromPrProbe`'s discipline in the reaper, one polarity
 * over: there, collection requires a positive observation; here, exclusion does.
 *
 * **The window is stated, not implied.** Only the top N are probed, so an item
 * promoted into view because a held one was dropped has not itself been checked.
 * That residual is #84's, and #43's fourth box requires it be documented where
 * the queue is surfaced rather than left for someone to discover.
 */

import { fetchLeaseStatus, leaseEndpoint, type LeaseReferent } from "./lease-client.ts";

/** One item's live state, as the adjudicating DO reports it. */
export interface HeldCheck {
  readonly itemId: string;
  readonly holder: string | null;
  /**
   * What the lease is pinned to, when it is bound (#105). A held-and-bound item
   * is someone working; a held-and-referent-less one is on the short claim ttl
   * and about to lapse. Carrying it here is what lets a caller tell those apart
   * without a second round trip — the distinction #115 is about.
   */
  readonly referent: LeaseReferent | null;
}

/** The outcome of probing a bounded window of candidates. */
export interface LiveExclusion {
  /** Item ids the DO says are held RIGHT NOW. Excluded from the queue. */
  readonly held: ReadonlyMap<string, HeldCheck>;
  /** How many candidates were probed. */
  readonly checked: number;
  /** How many probes could not answer — these stay in the queue (fail open). */
  readonly unobserved: number;
  /** False when `FDS_CLAIM_ENDPOINT` is unset: nothing was probed, nothing claimed. */
  readonly configured: boolean;
}

/**
 * How many ranked candidates a verb probes when it has no caller-supplied bound.
 *
 * `next` uses the caller's `top`, because the caller said how much of the queue
 * they intend to look at. `graph` has no such input and shows the whole ready
 * list, so it needs a default — and it must be a *number*, not "all", because
 * probing every ready item is the whole-board case (#84) that #43 deliberately
 * did not take.
 *
 * Ten matches `next`'s default, so both verbs verify the same depth and a
 * caller comparing them does not see one contradict the other.
 */
export const DEFAULT_HELD_WINDOW = 10;

/** Nothing probed — the shape returned when the lease plane is not configured. */
export const NO_EXCLUSION: LiveExclusion = {
  held: new Map(),
  checked: 0,
  unobserved: 0,
  configured: false,
};

/** Injectable so the fan-out is testable without a Worker. */
export type StatusProbe = (itemId: string) => Promise<{
  holder: string | null;
  live: boolean;
  referent: LeaseReferent | null;
}>;

/**
 * Ask the adjudicator which of these items are held.
 *
 * `ids` must already be the bounded window — this does not slice, because the
 * caller is the only thing that knows what "the pick and the top N" means for
 * the request it is serving.
 */
export async function verifyHeld(
  ids: readonly string[],
  probe?: StatusProbe,
): Promise<LiveExclusion> {
  // An INJECTED probe is itself the configuration — a caller that supplies one
  // has said how to ask, and making that also depend on an ambient env var is
  // how a test ends up reaching the real Worker. It did: before this signature,
  // `next`'s tests took 0.70s with FDS_CLAIM_ENDPOINT set and 0.32s without,
  // because they were quietly probing production.
  const configured = probe !== undefined || leaseEndpoint() !== null;
  const ask = probe ?? fetchLeaseStatus;
  if (!configured || ids.length === 0) return { ...NO_EXCLUSION, configured };

  const held = new Map<string, HeldCheck>();
  let unobserved = 0;

  // Concurrent: the fan-out is bounded by the caller's window, and serialising
  // ten round trips would put the latency squarely in the path of every `next`.
  const results = await Promise.allSettled(ids.map((id) => ask(id)));
  for (const [i, r] of results.entries()) {
    const itemId = ids[i];
    if (r.status === "rejected") {
      // Fail open — see the module header. The count is what keeps it honest.
      unobserved++;
      continue;
    }
    // `live` is the DO's own verdict on expiry; a lapsed lease is not a hold,
    // and re-deriving that from `expiresAt` here would be a second definition
    // of "live" that could disagree with the adjudicator's.
    if (r.value.live) {
      held.set(itemId, { itemId, holder: r.value.holder, referent: r.value.referent });
    }
  }

  return { held, checked: ids.length, unobserved, configured: true };
}

/**
 * How the exclusion reads back to a human, or null when there is nothing to say.
 *
 * Returns null in the ordinary healthy case — nothing configured, or everything
 * probed cleanly and nothing held. A line that appears on every call becomes
 * furniture, which is the failure `renderCoverage` already avoids by staying
 * silent when the board covers everything.
 */
export function renderExclusion(x: {
  checked: number;
  unobserved: number;
  configured: boolean;
  heldCount: number;
}): string | null {
  if (!x.configured) return null;
  const lines: string[] = [];
  if (x.heldCount > 0) {
    lines.push(
      `~ ${x.heldCount} of the top ${x.checked} ${x.heldCount === 1 ? "is" : "are"} held and excluded — ` +
        "verified against the lease plane, not the mirror.",
    );
  }
  if (x.unobserved > 0) {
    // The one thing that must never be silent: exclusion partly did not run,
    // so a held item may be sitting in the queue below.
    lines.push(
      `! ${x.unobserved} of the top ${x.checked} could not be checked against the lease plane — ` +
        "those stay listed, so one of them may already be held.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
