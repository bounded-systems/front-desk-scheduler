/**
 * @module writeback
 * Render the derived Status onto the live board (#148).
 *
 * WHAT CHANGED, AND WHY THE NARROW RULE WENT AWAY
 * -----------------------------------------------
 * This module first shipped as a repair for ONE transition (closed→Done),
 * because that was the only disagreement between the card and GitHub that could
 * be resolved without guessing. That framing presumed two authorities and a
 * merge rule — and every candidate merge rule is wrong in a different way. A
 * join/max over a status lattice is monotone and cannot express a REOPEN
 * (`closed_at` going NULL is a decrease). "Most recent transition wins" needs a
 * per-field timestamp neither the mirror nor ProjectV2 carries.
 *
 * Under `deriveStatus` (src/status.ts) there is exactly one authority per
 * component and nothing to merge: the card is output. So this module no longer
 * repairs a disagreement, it renders a projection, and "drift" becomes the gap
 * between a derived value and what the board currently shows.
 *
 * The rule itself is NOT stated here (#59) — `deriveStatus` owns it. This module
 * owns only: which rows to feed it, how to compute `openBlockers`, and which of
 * its answers are safe to write.
 *
 * WHAT IT STILL REFUSES TO WRITE
 * ------------------------------
 *  - anything `deriveStatus` returns null for (dolt-origin rows; an unreadable
 *    lease plane that would otherwise downgrade "In Progress" — #84);
 *  - a row with no card on the live board, since there is no project-item id to
 *    target and inventing one is not an option;
 *  - a row whose LIVE card already reads the derived value, which is what makes
 *    the pass idempotent and what stops a hand-drag from being rewritten while
 *    the mirror is still catching up.
 */

import type { BoardItem } from "./board.ts";
import { BLOCKER_KINDS } from "./scheduling.ts";
import { deriveStatus, isStatus } from "./status.ts";
import type { Status } from "./status.ts";

/** One row of SQL.derivationItems. */
export interface DerivationRow {
  readonly item_id: string;
  /**
   * `number | string` for the #101 reason: the DoltHub HTTP plane returns every
   * column as a JSON string while `dolt sql -r json` returns a real number.
   */
  readonly number: number | string | null;
  readonly repository: string;
  readonly status: string;
  readonly origin: string;
  readonly closed_at: string | null;
}

/**
 * One row of SQL.typedEdges — a dependency arrow, WITH its kind.
 *
 * Typed, not `SQL.edges`, because the kind decides whether the edge gates.
 * `closes` is mined PR→issue provenance and never blocks anything; it is also
 * the MAJORITY of the graph (68 of 91 edges on 2026-08-05), so treating the
 * flattened edge list as blockers does not fail quietly at the margin.
 */
export interface DepEdge {
  readonly item_id: string;
  readonly dep_item_id: string;
  readonly edge_type: string;
}

export interface PlannedWrite {
  readonly ref: string;
  /** The project-item id (PVTI_…) the mutation targets. */
  readonly itemId: string;
  readonly from: string;
  readonly to: Status;
  /** Which authority produced `to` — printed, so a surprising write is explicable. */
  readonly because: string;
}

export interface SkippedWrite {
  readonly ref: string;
  readonly reason: string;
}

export interface WritebackPlan {
  readonly writes: readonly PlannedWrite[];
  readonly skipped: readonly SkippedWrite[];
}

/** `repository#number`, the key both planes agree on. */
export function refOf(repository: string, number: number | string | null): string {
  return `${repository}#${Number(number)}`;
}

/**
 * The open set, as SCHEDULABLE defines it: not card-Done AND not GitHub-closed.
 *
 * Deliberately the SAME predicate the ranking uses rather than a derived-only
 * one, so a blocker count here means what it means in `next`. It reads the card
 * as well as `closed_at`, which is mildly self-referential while a stale card
 * exists — a row wrongly reading Done counts as complete for one pass, then the
 * write lands and the next pass sees the corrected value. It converges rather
 * than oscillating, because `closed_at` is never itself derived.
 */
function openIdsOf(rows: readonly DerivationRow[]): Set<string> {
  return new Set(
    rows.filter((r) => r.status !== "Done" && !r.closed_at).map((r) => r.item_id),
  );
}

/**
 * Count, per item, how many of its BLOCKING dependencies are still open.
 *
 * Two filters, and both are load-bearing:
 *
 *  - the edge must be a blocking KIND. `BLOCKER_KINDS` is exported from
 *    scheduling.ts precisely so nothing keeps a second list, and `closes` is
 *    excluded there as "mined PR→issue provenance. Never gates anything" —
 *    D3 says the same in the shapes ("an open closing-PR means the item is in
 *    delivery, not mis-statused").
 *  - the target must still be OPEN. Same rule as `assembleScheduling`: a dep
 *    pointing outside the open set is complete and therefore satisfied.
 *
 * The kind filter was missing until prx#972 was written to "Blocked" off a
 * single `closes` edge (run 31020918592). `closes` is the majority of this
 * graph, so omitting the filter is not a marginal error — it manufactures
 * blockers for anything with an open closing PR, which is precisely the set of
 * items actively being delivered.
 */
function openBlockersOf(
  edges: readonly DepEdge[],
  openIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of edges) {
    if (!BLOCKER_KINDS.has(e.edge_type)) continue;
    if (openIds.has(e.dep_item_id)) counts.set(e.item_id, (counts.get(e.item_id) ?? 0) + 1);
  }
  return counts;
}

/** Why a derived value came out the way it did, for the plan's printed output. */
function because(row: DerivationRow, openBlockers: number, to: Status): string {
  if (to === "Done") return `issue closed ${row.closed_at}`;
  if (to === "Blocked") return `${openBlockers} open dependency(ies)`;
  if (to === "In Progress") return "a live lease holds it";
  return "open, unblocked, unheld";
}

/**
 * Plan the board writes that would make every card equal its derived value.
 *
 * `leaseHeldIds` is nullable on purpose and the two cases are NOT the same:
 * a Set means the lease plane was read and an absent id genuinely means unheld;
 * `null`/`undefined` means it could not be read, which `deriveStatus` turns into
 * a refusal to touch "In Progress" rather than a downgrade (#84, and the #124
 * lesson that zero data is not the same as negative data).
 */
export function planWriteback(
  rows: readonly DerivationRow[],
  edges: readonly DepEdge[],
  board: readonly BoardItem[],
  leaseHeldIds?: ReadonlySet<string> | null,
): WritebackPlan {
  const byRef = new Map(board.map((i) => [refOf(i.repository, i.number), i]));
  const openIds = openIdsOf(rows);
  const blockers = openBlockersOf(edges, openIds);

  const writes: PlannedWrite[] = [];
  const skipped: SkippedWrite[] = [];

  for (const row of rows) {
    const ref = refOf(row.repository, row.number);
    const item = byRef.get(ref);

    // Derive from the LIVE card where we have one: the mirror's `status` lags a
    // hand-drag, and the "In Progress" preservation rule keys on current value.
    const current = item?.status ?? row.status;
    if (!isStatus(current)) {
      skipped.push({ ref, reason: `unrecognised current status "${current}"` });
      continue;
    }

    const openBlockers = blockers.get(row.item_id) ?? 0;
    const to = deriveStatus({
      origin: row.origin,
      closedAt: row.closed_at,
      openBlockers,
      leaseHeld: leaseHeldIds ? leaseHeldIds.has(row.item_id) : undefined,
      current,
    });

    if (to === null) {
      // Only worth reporting for rows that would otherwise have moved; a dolt
      // row that already reads right is noise, not a decision.
      if (row.origin !== "github") continue;
      skipped.push({ ref, reason: "lease plane unreadable — preserving \"In Progress\" (#84)" });
      continue;
    }

    if (!item) {
      skipped.push({ ref, reason: "not found on the live board — no project-item id to target" });
      continue;
    }

    if (current === to) continue; // already correct; silence is the common case

    writes.push({ ref, itemId: item.id, from: current, to, because: because(row, openBlockers, to) });
  }

  return { writes, skipped };
}
