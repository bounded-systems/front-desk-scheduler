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
  leases:
    "SELECT DISTINCT item_id FROM claims WHERE status='active' AND TIMESTAMPADD(SECOND,ttl_sec,claimed_at)>UTC_TIMESTAMP()",
} as const;
