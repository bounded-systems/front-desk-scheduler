/**
 * @module status
 * Front Desk `Status` → bead state. A pure mapping, in its own module for the
 * same dependency reason as `mirror-dir.ts`.
 *
 * It lived in `board.ts`, which statically imports `node:child_process` and
 * `node:fs` for the live-board `gh` path. `verbs.ts` needs this function and
 * nothing else from that module, so importing it there pulled the whole GitHub
 * CLI seam into the verb surface — including for the DoltHub read plane, which
 * never shells out to anything.
 *
 * `board.ts` re-exports it, so every existing caller is unchanged.
 */

import type { BeadState } from "./policy.ts";

/** Front Desk Status → bead state (see gh-project-room/contract.ts). */
export function statusToState(status: string | undefined): BeadState {
  switch (status) {
    case "Todo":
      return "open";
    case "In Progress":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "closed";
    default:
      return "open";
  }
}

/** The four values of the board's Status field, as the `items.status` enum spells them. */
export type Status = "Todo" | "In Progress" | "Blocked" | "Done";

export const STATUSES: readonly Status[] = ["Todo", "In Progress", "Blocked", "Done"];

export function isStatus(s: string): s is Status {
  return (STATUSES as readonly string[]).includes(s);
}

/**
 * What the card WOULD say if it were a projection of the state it is linked to,
 * rather than an independent field someone drags (#148).
 *
 * WHY DERIVE RATHER THAN RECONCILE
 * --------------------------------
 * `status-drift` and the writeback window both presume two authorities that can
 * disagree, and then need a rule for merging them. That framing is what makes
 * the merge rule feel arbitrary — a join breaks on reopen (`closed_at` going
 * NULL is a DECREASE, and a monotone lattice cannot walk back), and "most recent
 * transition wins" needs a per-field timestamp the schema does not carry.
 *
 * There is only ever one authority per component, and each already exists:
 *
 *   Done         ⟸ closed_at IS NOT NULL      SCHEDULABLE, the #89 Lean invariant
 *   Blocked      ⟸ openBlockers > 0           assembleScheduling; D2/D3 in the shapes
 *   In Progress  ⟸ a held lease               the DO (#135/#115)
 *   Todo         ⟸ none of the above
 *
 * So disagreement is not resolved, it is made unrepresentable. The shapes said
 * this already and only lacked a direction: D2 ("a Blocked item must have at
 * least one non-Done dependency") and D3 ("a Todo item with an open dependency
 * should be Blocked") are together the biconditional Blocked ⟺ openBlockers > 0.
 * This function is those two rules pointed at the card instead of at a validator.
 *
 * PRECEDENCE, AND WHY Blocked OUTRANKS In Progress
 * ------------------------------------------------
 * Done > Blocked > In Progress > Todo. The first is ground truth from GitHub.
 * The second is structural — a fact about the dependency graph — while a lease is
 * a fact about a *person*, and D2/D3's biconditional admits no exception for "but
 * someone is holding it". A held item that acquires a blocker should read Blocked;
 * who holds it is reported by `next`/`graph` from the lease plane, which is where
 * that question is actually answered. Overloading one enum with both would lose
 * information rather than add it.
 *
 * TWO THINGS IT DELIBERATELY REFUSES TO DERIVE
 * --------------------------------------------
 * 1. **dolt-origin rows.** `closed_at` is GitHub's field; a hidden/planning row
 *    has no issue for it to disagree with, which is why SQL.statusDrift is scoped
 *    to origin='github' too. Their status stays human-set.
 * 2. **In Progress, when the lease plane was not consulted.** There is no batch
 *    route to the DO — a DurableObjectNamespace cannot be enumerated (#84) — so a
 *    whole-board pass genuinely does not know who holds what. Deriving anyway
 *    would flip every held card to Todo, destroying the signal it cannot read.
 *    `leaseHeld: undefined` therefore PRESERVES an existing "In Progress" rather
 *    than overwriting it, and returns null to say "not derivable, leave alone".
 *
 * Returns null when the card must not be touched. Callers write only on a
 * non-null value that differs from `current`.
 */
export interface DerivationInput {
  /** GitHub-backed rows only; 'dolt' rows are never derived. */
  readonly origin: string;
  /** GitHub's open/close — the completion ground truth. */
  readonly closedAt: string | null;
  /** Count of dependencies that are themselves not complete. */
  readonly openBlockers: number;
  /** Whether a live lease holds it. `undefined` = the lease plane was not consulted (#84). */
  readonly leaseHeld?: boolean;
  /** What the card reads now — needed only to preserve an unreadable In Progress. */
  readonly current: Status;
}

export function deriveStatus(i: DerivationInput): Status | null {
  // A planning row has no second authority; its card IS the record.
  if (i.origin !== "github") return null;

  if (i.closedAt) return "Done";
  if (i.openBlockers > 0) return "Blocked";
  if (i.leaseHeld === true) return "In Progress";

  // Open, unblocked, and the lease plane could not be read: "In Progress" may be
  // true and unreadable, so it is preserved rather than downgraded to Todo.
  if (i.leaseHeld === undefined && i.current === "In Progress") return null;

  return "Todo";
}
