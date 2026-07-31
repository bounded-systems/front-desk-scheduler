/**
 * @module authority
 * Field ownership across the two write surfaces — the mutability scope.
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
 *
 * The ONE sanctioned way to set a dolt-owned field from the GitHub side is
 * FRONTMATTER in the issue body (structured, part of github-owned `body`) — not
 * the project-field UI. Frontmatter is intake; the project field is projection.
 */

export type WriteSurface = "github" | "dolt";

export interface FieldAuthority {
  readonly field: string;
  readonly owner: WriteSurface;
  readonly note: string;
}

export const FIELD_AUTHORITY: readonly FieldAuthority[] = [
  // github-owned — identity + state; Dolt mirrors, never pushes back.
  { field: "title", owner: "github", note: "content; edited in GitHub" },
  { field: "body", owner: "github", note: "content; carries frontmatter (the dolt-field intake channel)" },
  // Two completion surfaces exist, and the precedence between them is decided
  // (#89): the board CARD (the mirror's `status` column — Todo / In Progress /
  // Blocked / Done, a human-draggable ProjectV2 field) may refine a live item,
  // but `closed_at` — GitHub's open/close, the field this table calls ground
  // truth — WINS. An item with `closed_at` set is never schedulable, whatever
  // its card says (SCHEDULABLE in scheduling.ts; `schedulable` in
  // specs/lean/FrontDesk.lean). A card that disagrees with `closed_at` in
  // either direction is drift — surfaced by scripts/status-drift.ts, reconciled
  // by fixing the card, never by the queue silently believing it.
  { field: "status", owner: "github", note: "open/close is a GitHub action (webhook/PR merge)" },
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
