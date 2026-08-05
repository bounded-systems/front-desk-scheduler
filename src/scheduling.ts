/**
 * @module scheduling
 * The pure ready-rule computation shared by every read adapter (DoltHub HTTP,
 * local dolt-server, local file): given the raw item/edge/lease rows, derive
 * openBlockers / unblocks / leased. Adapters only fetch; this assembles.
 */

import type { BoardItem } from "./board.ts";

export type SchedulingItem = BoardItem & {
  openBlockers: number;
  unblocks: number;
  ageDays: number;
  leased: boolean;
};

/**
 * A queue read plus the state it was derived from.
 *
 * `at` is the Dolt commit every query in this read was pinned to — the answer to
 * "which board did this ranking come from". It is NOT a separate lookup: a
 * second resolution of the head can differ from the one the read used (a sync
 * landing in between), so a stamp resolved independently could describe a board
 * the ranking never saw. Returning it with the data is what makes the stamp
 * trustworthy.
 *
 * `null` when the adapter cannot pin (local clone, or an unresolvable head) —
 * the read still works, it just cannot say precisely what it read.
 */
export interface ScheduleRead {
  readonly items: SchedulingItem[];
  readonly at: string | null;
}

/**
 * A row as it arrives from a read plane — NOT as the rest of the code wants it.
 *
 * The numeric fields are declared `number` because that is what they mean, and
 * every one of them must still be run through `Number()` in `assembleScheduling`.
 * The DoltHub HTTP plane returns every column as a JSON **string** (`"931"`,
 * `"2"`), while `dolt sql -r json` on a local clone returns real numbers, so the
 * declared type is honest about intent and a lie about runtime on the default
 * path. Coercion is the seam that makes both planes agree.
 *
 * `number` was the field that got missed (#101). It reached the MCP output
 * schema, which does validate, as a string — so `next` and `graph` failed
 * outright over MCP while the CLI, which validates nothing, printed a correct
 * queue. Do not remove a `Number()` here on the grounds that the type already
 * says `number`; the type is the thing that is wrong.
 */
export interface RawItem {
  item_id: string;
  number: number | null;
  title: string;
  repository: string;
  status: string;
  kind: string;
  effort: number;
  value: number;
  depends_on: string;
  /**
   * Comma-separated capability tokens. OPTIONAL because a read pinned to a
   * commit from before the 2026-07-31 migration has no such column — the same
   * permanent-historical-read case as `leasesLegacy`, not a transitional one.
   * Absent ⇒ undeclared ⇒ executable by anyone (the predicate fails open).
   */
  needs?: string | null;
  age_days: number | null;
}

export interface RawEdge {
  item_id: string;
  dep_item_id: string;
}

/**
 * A read pinned to a commit from the pre-`edge_type` window (2026-07-26,
 * before `0horcogstrsi…`) has untyped `item_deps` rows. Every edge of that era
 * was a declared dependency — `closes`/`parent-child` mining arrived WITH the
 * column — so the historically faithful reading is "blocks". Permanent
 * historical-read shim, same case as `itemsLegacy`/`leasesLegacy`.
 */
export function asBlockingEdges(edges: readonly RawEdge[]): RawTypedEdge[] {
  return edges.map((e) => ({ ...e, edge_type: "blocks" }));
}

/**
 * Assemble scheduling items from raw rows. `items` is the SCHEDULABLE set —
 * not card-Done AND not GitHub-closed (see SCHEDULABLE below); a dep pointing
 * OUTSIDE it is complete → satisfied, so openBlockers counts only deps that
 * ARE in the set.
 *
 * Edges are TYPED, and only `BLOCKER_KINDS` gate — a `closes` edge is mined
 * PR→issue provenance and must count toward neither `openBlockers` (it would
 * manufacture a blocker for exactly the items in active delivery, the #155
 * inversion) nor `unblocks` (merging a PR "unblocks" nothing; crediting it
 * inflates the score of anything with an open closing PR).
 */
export function assembleScheduling(
  items: readonly RawItem[],
  edges: readonly RawTypedEdge[],
  leasedIds: readonly string[],
): SchedulingItem[] {
  const open = new Set(items.map((i) => i.item_id)); // non-Done ⇒ "open"
  const leased = new Set(leasedIds);
  const openBlockers = new Map<string, number>();
  const unblocks = new Map<string, number>();
  for (const e of edges) {
    if (!BLOCKER_KINDS.has(e.edge_type)) continue; // provenance, not a gate
    if (open.has(e.dep_item_id)) openBlockers.set(e.item_id, (openBlockers.get(e.item_id) ?? 0) + 1);
    if (open.has(e.item_id)) unblocks.set(e.dep_item_id, (unblocks.get(e.dep_item_id) ?? 0) + 1);
  }
  return items.map((r) => ({
    id: r.item_id,
    number: r.number == null ? 0 : Number(r.number),
    title: r.title,
    repository: r.repository,
    status: r.status,
    kind: r.kind as BoardItem["kind"],
    effort: Number(r.effort),
    value: Number(r.value),
    dependsOn: r.depends_on ? r.depends_on.split(",").map(Number) : [],
    needs: r.needs ? r.needs.split(",").map((c) => c.trim()).filter(Boolean) : [],
    openBlockers: openBlockers.get(r.item_id) ?? 0,
    unblocks: unblocks.get(r.item_id) ?? 0,
    ageDays: r.age_days == null ? 0 : Number(r.age_days),
    leased: leased.has(r.item_id),
  }));
}

/**
 * The schedulable set, as a WHERE clause. Two exclusions, one per authority:
 *
 *   status <> 'Done'      — the board card's completion column (projection).
 *   closed_at IS NULL     — GitHub's open/close, which authority.ts names
 *                           "realized completion (calibration ground truth)".
 *
 * The second clause is front-desk-scheduler#89: `.github#55` was closed on
 * GitHub on 2026-07-08 while its card still read "In Progress", and it ranked
 * 8th for 23 days — the rule consulted the field the authority model does NOT
 * own liveness with, while the field it calls ground truth sat unread in the
 * same row. A card can refine a live item (Todo / In Progress / Blocked); it
 * cannot resurrect a closed one.
 *
 * This is deliberately the SET definition, not a restatement of the ready rule
 * (#59 forbids that): isEligible stays the one imported definition of ready.
 * Membership must be decided here and not post-hoc in TS because the set also
 * drives dependency satisfaction in assembleScheduling — a dep pointing outside
 * the set is complete and blocks nothing, and a GitHub-closed dep must satisfy
 * its dependents exactly as a Done one does.
 *
 * `closed_at` is in the base schema (mirror.sql), older than `needs`, so every
 * ref either query can reach has the column — the clause is safe on both.
 */
const SCHEDULABLE = "WHERE status <> 'Done' AND closed_at IS NULL";

/** The three read-plane queries every adapter runs (schedulable items, edges, live leases). */
export const SQL = {
  items:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, needs, " +
    `DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items ${SCHEDULABLE}`,
  // Pre-2026-07-31 shape, without `needs`. Same role as `leasesLegacy` below and
  // the same justification: `ref` can name any historical Dolt commit, and
  // reading the board as it stood before a migration is a permanent capability
  // of a versioned database, not transitional scaffolding. Items then read as
  // undeclared, so the capability predicate is inert — which is the truth about
  // a board that never carried the field.
  itemsLegacy:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, " +
    `DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items ${SCHEDULABLE}`,
  // The reconciliation read (scripts/status-drift.ts): rows where the two
  // completion authorities DISAGREE, in either direction. Not consumed by the
  // queue — the schedulable set already resolves the disagreement toward
  // closed_at — but a resolved disagreement is still a lying card on the live
  // board, and nothing else would ever surface it.
  statusDrift:
    "SELECT repository, number, status, closed_at FROM items " +
    "WHERE origin = 'github' AND ((closed_at IS NOT NULL AND status <> 'Done') " +
    "OR (closed_at IS NULL AND status = 'Done'))",
  // LEGACY fallback only — a read pinned before the 2026-07-26 `edge_type`
  // migration has no such column. Live paths read `typedEdges`; untyped rows
  // are rehydrated through `asBlockingEdges` (every pre-typed edge was a
  // declared dependency). Don't add new readers of this: an untyped edge read
  // cannot tell provenance from a gate, which is exactly the #155 bug.
  edges: "SELECT item_id, dep_item_id FROM item_deps",
  // Typed edges — carries edge_type (blocks / parent-child / closes). Every
  // live edge consumer needs the kind: `graph` to distinguish parent-child
  // from blockers, scheduling and the writeback to keep `closes` (provenance)
  // from gating.
  typedEdges: "SELECT item_id, dep_item_id, edge_type FROM item_deps",
  // ALL items incl Done (the `list` verb).
  // The scheduling/graph queries drop Done (not schedulable); list must include
  // it so consumers see closed work (e.g. epic children reporting `state`).
  allItems:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, needs, " +
    "DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items",
  allItemsLegacy:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, " +
    "DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items",
  // The derivation read (#148). Status is a projection, so computing it needs the
  // two columns the scheduling read drops: `origin` (dolt rows have no second
  // authority and are never derived) and `closed_at` (the completion ground
  // truth). Whole-table and therefore walked by `readPaged`, never issued bare —
  // items crossed the 1000-row cap in July (#88).
  derivationItems: "SELECT item_id, number, repository, status, origin, closed_at FROM items",
  // Live leases — the held set, excluded from the ready queue. Reads `leases`
  // (one row per held item, PK-enforced), NOT the append-only `claims` history.
  leases:
    "SELECT item_id FROM leases WHERE TIMESTAMPADD(SECOND,ttl_sec,claimed_at)>UTC_TIMESTAMP()",
  // The pre-`leases` held set, derived from the claims log. Used when reading at
  // a historical ref (before 2026-07-28) or from a replica that has not yet
  // pulled the migration. READ-ONLY compatibility — the claim WRITE path has no
  // fallback, deliberately: writing through the old shape would resurrect the
  // unenforced-S1 bug.
  leasesLegacy:
    "SELECT DISTINCT item_id FROM claims WHERE status='active' AND TIMESTAMPADD(SECOND,ttl_sec,claimed_at)>UTC_TIMESTAMP()",
} as const;

// ── typed dep-graph surface (GH-canonical): ready/blocked + typed edges ──

/** One raw edge with its kind, as `SQL.typedEdges` returns it. */
export interface RawTypedEdge {
  item_id: string;
  dep_item_id: string;
  edge_type: string;
}

/** A node in the GH-canonical graph — identity is (repository, number). */
export interface GraphRef {
  number: number;
  repository: string;
}

/** A typed dependency edge, GH-canonical. `from` depends on / is blocked by `to`. */
export interface GraphEdge {
  from: GraphRef;
  to: GraphRef;
  kind: string;
}

/**
 * The dep-graph over the schedulable (non-Done) set, GH-canonical.
 *  - `blockedBy` maps an item's `item_id` to its OPEN blockers (deps still in
 *    the non-Done set via a `blocks`/`parent-child` edge; `closes` excluded —
 *    same readiness rule as the mirror's ready query).
 *  - `edges` lists every typed edge whose BOTH endpoints are in the set.
 */
export interface Graph {
  edges: GraphEdge[];
  blockedBy: Map<string, GraphRef[]>;
}

/**
 * Edge kinds that gate readiness (an open one blocks). `closes` is NOT a blocker
 * — it is mined PR→issue provenance. Exported so anything reporting on the DAG
 * (scripts/triage-coverage.ts) classifies edges the same way the scheduler does,
 * rather than keeping a second list that can drift.
 */
export const BLOCKER_KINDS = new Set(["blocks", "parent-child"]);

/**
 * Assemble the GH-canonical dep-graph from the non-Done items + typed edges.
 * Pure: no I/O. Edges to items outside the set (Done ⇒ satisfied) are dropped,
 * so both `edges` and `blockedBy` describe only the schedulable graph.
 */
export function assembleGraph(items: readonly SchedulingItem[], typedEdges: readonly RawTypedEdge[]): Graph {
  const refById = new Map<string, GraphRef>(
    items.map((i) => [i.id, { number: i.number, repository: i.repository }]),
  );
  const edges: GraphEdge[] = [];
  const blockedBy = new Map<string, GraphRef[]>();
  for (const e of typedEdges) {
    const from = refById.get(e.item_id);
    const to = refById.get(e.dep_item_id);
    if (!from || !to) continue; // an endpoint is Done ⇒ outside the schedulable set
    edges.push({ from, to, kind: e.edge_type });
    if (BLOCKER_KINDS.has(e.edge_type)) {
      const list = blockedBy.get(e.item_id) ?? [];
      list.push(to);
      blockedBy.set(e.item_id, list);
    }
  }
  return { edges, blockedBy };
}
