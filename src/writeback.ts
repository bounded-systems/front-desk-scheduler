/**
 * @module writeback
 * The ONE direction of status drift a machine is allowed to resolve.
 *
 * WHY ONLY ONE DIRECTION (front-desk-scheduler#148)
 * -------------------------------------------------
 * `status-drift` (SQL.statusDrift) reports both disagreements between the two
 * completion authorities. They are not symmetric, and only one of them is
 * mechanically derivable:
 *
 *   closed_at set, card ≠ Done   → DERIVABLE. GitHub closed the issue; "Done"
 *                                  is the only card value consistent with that.
 *                                  Nobody decided the card should stay Todo —
 *                                  nothing was there to move it.
 *   card = Done, closed_at NULL  → NOT derivable. Someone marked the card Done
 *                                  while the issue is open. That is a human
 *                                  claim about the work, and the resolution
 *                                  (close the issue? move the card back?) is a
 *                                  judgement this module must never make.
 *
 * The delta syncer already draws this exact line in the mirror: `syncPullDelta`
 * is "deliberately conservative: only sets closed→Done (the transition that goes
 * stale); open items keep their board status (Todo/In Progress/Blocked)". This
 * module is that same rule applied to the second surface — the live board — and
 * it is deliberately the same rule rather than a new one.
 *
 * WHAT THIS DOES NOT COVER
 * ------------------------
 * A card that should be *Blocked* is not drift and never appears here: both of
 * SQL.statusDrift's clauses key on `closed_at`, and an open item with the wrong
 * open-status disagrees with nothing. Deciding an item is blocked is a human
 * judgement with no second authority to derive it from, so that card stays
 * hand-dragged permanently. Front Desk #5 is the standing example.
 *
 * Pure: no network, no `gh`, no clock. The runner (scripts/status-writeback.ts)
 * supplies both inputs and performs the mutation, so the decision of WHICH
 * cards move is testable without a board.
 */

import type { BoardItem } from "./board.ts";

/** The card value that a closed issue implies. Matches the `items.status` enum. */
export const DONE = "Done";

/**
 * One row of SQL.statusDrift. `number` is `number | string` for the #101 reason:
 * the DoltHub HTTP plane returns every column as a JSON string while `dolt sql
 * -r json` returns a real number, and this type describes the intent rather than
 * the runtime. `planWriteback` coerces rather than trusting either.
 */
export interface DriftRow {
  readonly repository: string;
  readonly number: number | string | null;
  readonly status: string;
  readonly closed_at: string | null;
}

/** A card this run intends to move, with the evidence that justifies moving it. */
export interface PlannedWrite {
  readonly ref: string;
  /** The project-item id (PVTI_…) the mutation targets. */
  readonly itemId: string;
  readonly from: string;
  readonly closedAt: string;
}

/** A drift row deliberately left alone, and why — printed, never silent. */
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
 * Decide which drifting cards to move to Done.
 *
 * `rows` is the mirror's account of the disagreement; `board` is what the live
 * board says RIGHT NOW. Both are needed and neither is sufficient:
 *
 *  - the mirror carries `closed_at`, which the board read has no field for, and
 *    it is the authority on completion (authority.ts: "realized completion");
 *  - the board carries the project-item id the mutation needs, and its status is
 *    fresher than the mirror's — the mirror can lag a webhook, so a card already
 *    dragged by hand still appears in `rows` for a few minutes.
 *
 * Guarding on the LIVE status is what keeps this idempotent: re-running after a
 * successful run plans nothing, because the board now agrees.
 */
export function planWriteback(
  rows: readonly DriftRow[],
  board: readonly BoardItem[],
): WritebackPlan {
  const byRef = new Map(board.map((i) => [refOf(i.repository, i.number), i]));
  const writes: PlannedWrite[] = [];
  const skipped: SkippedWrite[] = [];

  for (const row of rows) {
    const ref = refOf(row.repository, row.number);

    // The non-derivable direction. Reported by status-drift, never written here.
    if (!row.closed_at) {
      skipped.push({
        ref,
        reason: `card="${DONE}" but the issue is OPEN — a human claim, not a derivable fact`,
      });
      continue;
    }

    const item = byRef.get(ref);
    if (!item) {
      // The mirror knows the row but the board read did not return it: either it
      // was removed from the project, or the board read was truncated. Either
      // way there is no project-item id to target, and inventing one is not an
      // option — say so rather than dropping it silently.
      skipped.push({ ref, reason: "not found on the live board — no project-item id to target" });
      continue;
    }

    if (item.status === DONE) {
      skipped.push({ ref, reason: `board already reads "${DONE}" — the mirror row is stale` });
      continue;
    }

    writes.push({ ref, itemId: item.id, from: item.status, closedAt: row.closed_at });
  }

  return { writes, skipped };
}
