/**
 * @module authority
 * Field ownership across the write surfaces — the mutability scope.
 *
 * The rule: GitHub is INTAKE. An item is born there (an issue) or in Dolt
 * (hidden/planning work). After intake, each FIELD has exactly one authoritative
 * write surface. Writing an authoritative field on the wrong surface is invalid
 * and is reconciled toward the owner (drift), not silently accepted.
 *
 *   github-owned : the item's identity + human/state truth. Pull refreshes these
 *                  into Dolt; push never writes them back.
 *   dolt-owned   : scheduling metadata. Push writes these UP to the board's
 *                  project fields; a direct project-field edit in the GitHub UI
 *                  is out-of-band → flagged (D6) and overwritten by Dolt.
 *   derived      : owned by NOBODY, because it is computed from fields that are
 *                  already owned. Not a surface anyone writes to — the name is
 *                  loose for that reason — but it belongs in this table, because
 *                  the question "who may set this?" has an answer, and the
 *                  answer is "no one; it is a function of the rows above".
 *
 * The ONE sanctioned way to set a dolt-owned field from the GitHub side is
 * FRONTMATTER in the issue body (structured, part of github-owned `body`) — not
 * the project-field UI. Frontmatter is intake; the project field is projection.
 */

export type WriteSurface = "github" | "dolt" | "derived";

export interface FieldAuthority {
  readonly field: string;
  readonly owner: WriteSurface;
  readonly note: string;
}

export const FIELD_AUTHORITY: readonly FieldAuthority[] = [
  // github-owned — identity + state; Dolt mirrors, never pushes back.
  { field: "title", owner: "github", note: "content; edited in GitHub" },
  { field: "body", owner: "github", note: "content; carries frontmatter (the dolt-field intake channel)" },
  // DERIVED, not owned (#148). The card is output. `deriveStatus` in status.ts
  // computes it from state that already has an owner in this very table:
  //
  //   Done         <= closed_at IS NOT NULL     github-owned (the row below)
  //   Blocked      <= openBlockers > 0          from depends_on, dolt-owned
  //   In Progress  <= a held lease              the DO; no surface in this table
  //   Todo         <= none of the above
  //
  // so `status` has no independent authority to record. #89 is unchanged and is
  // now the REASON rather than a tie-break: `closed_at` beats the card, which is
  // exactly why Done derives from it (SCHEDULABLE in scheduling.ts; `schedulable`
  // in specs/lean/FrontDesk.lean).
  //
  // This entry read owner:"github", note:"open/close is a GitHub action" until
  // #148. That described a card GitHub set and a human dragged, with drift
  // "reconciled by fixing the card" — which was true only while dragging was the
  // sole way to move one. board-writeback.yml renders the derivation instead, so
  // a disagreement is not reconciled toward an owner; it is unrepresentable.
  // scripts/status-drift.ts survives as the detector that the projection is
  // actually being RENDERED, which is a different claim from who owns it.
  { field: "status", owner: "derived", note: "projection of closed_at + the dep graph + the lease plane (#148)" },
  { field: "created_at", owner: "github", note: "immutable birth time" },
  { field: "closed_at", owner: "github", note: "realized completion (calibration ground truth); overrides the card for scheduling (#89)" },
  { field: "parent-child", owner: "github", note: "native sub-issues; mined" },
  { field: "closes", owner: "github", note: "closing PR references; mined" },

  // dolt-owned — scheduling metadata; push writes these up to the board.
  { field: "kind", owner: "dolt", note: "epic/room/door/task; frontmatter-declarable" },
  { field: "effort", owner: "dolt", note: "points; frontmatter-declarable, else estimated" },
  { field: "value", owner: "dolt", note: "0-100; frontmatter-declarable, else estimated" },
  { field: "depends_on", owner: "dolt", note: "the blocks edges; frontmatter-declarable" },
] as const;

const OWNER = new Map(FIELD_AUTHORITY.map((f) => [f.field, f.owner]));

export function ownerOf(field: string): WriteSurface | undefined {
  return OWNER.get(field);
}

/** Fields Dolt pushes up to the GitHub project on capture. */
export const DOLT_OWNED_FIELDS: readonly string[] = FIELD_AUTHORITY
  .filter((f) => f.owner === "dolt")
  .map((f) => f.field);

/** Fields the pull is allowed to refresh into Dolt from GitHub-native data. */
export const GITHUB_OWNED_FIELDS: readonly string[] = FIELD_AUTHORITY
  .filter((f) => f.owner === "github")
  .map((f) => f.field);
