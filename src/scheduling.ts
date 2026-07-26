/**
 * @module scheduling
 * The pure `bd ready` computation shared by every read adapter (DoltHub HTTP,
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
  age_days: number | null;
}

export interface RawEdge {
  item_id: string;
  dep_item_id: string;
}

/**
 * Assemble scheduling items from raw rows. `items` is the NON-Done set (the only
 * schedulable rows); a dep pointing OUTSIDE it is a Done item → satisfied, so
 * openBlockers counts only deps that ARE in the set.
 */
export function assembleScheduling(
  items: readonly RawItem[],
  edges: readonly RawEdge[],
  leasedIds: readonly string[],
): SchedulingItem[] {
  const open = new Set(items.map((i) => i.item_id)); // non-Done ⇒ "open"
  const leased = new Set(leasedIds);
  const openBlockers = new Map<string, number>();
  const unblocks = new Map<string, number>();
  for (const e of edges) {
    if (open.has(e.dep_item_id)) openBlockers.set(e.item_id, (openBlockers.get(e.item_id) ?? 0) + 1);
    if (open.has(e.item_id)) unblocks.set(e.dep_item_id, (unblocks.get(e.dep_item_id) ?? 0) + 1);
  }
  return items.map((r) => ({
    id: r.item_id,
    number: r.number ?? 0,
    title: r.title,
    repository: r.repository,
    status: r.status,
    kind: r.kind as BoardItem["kind"],
    effort: Number(r.effort),
    value: Number(r.value),
    dependsOn: r.depends_on ? r.depends_on.split(",").map(Number) : [],
    openBlockers: openBlockers.get(r.item_id) ?? 0,
    unblocks: unblocks.get(r.item_id) ?? 0,
    ageDays: r.age_days == null ? 0 : Number(r.age_days),
    leased: leased.has(r.item_id),
  }));
}

/** The three read-plane queries every adapter runs (non-Done items, edges, live leases). */
export const SQL = {
  items:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, " +
    "DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items WHERE status <> 'Done'",
  edges: "SELECT item_id, dep_item_id FROM item_deps",
  // Typed edges — carries edge_type (blocks / parent-child / closes) that the
  // flattened `edges` query drops. The GH-canonical dep-graph surface
  // (`readTypedEdges` → the `graph` verb) needs the kind to distinguish
  // parent-child (epic children) from blockers.
  typedEdges: "SELECT item_id, dep_item_id, edge_type FROM item_deps",
  // ALL items incl Done — the `bd list --all` replacement (the `list` verb).
  // The scheduling/graph queries drop Done (not schedulable); list must include
  // it so consumers see closed work (e.g. epic children reporting `state`).
  allItems:
    "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, " +
    "DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items",
  leases:
    "SELECT DISTINCT item_id FROM claims WHERE status='active' AND TIMESTAMPADD(SECOND,ttl_sec,claimed_at)>UTC_TIMESTAMP()",
} as const;

// ── typed dep-graph surface (GH-canonical) — the bd-dep/bd-ready replacement ──

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

/** Edge kinds that gate readiness (an open one blocks). `closes` is NOT a blocker. */
const BLOCKER_KINDS = new Set(["blocks", "parent-child"]);

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
