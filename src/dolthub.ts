/**
 * @module dolthub
 * The read plane, over HTTP. Queries the public DoltHub SQL API — no GitHub API,
 * no local dolt clone, no credential, so reads NEVER touch the rate-limit budget
 * and are always at the latest synced commit. This is the source every consumer
 * (whats-next, agents, CI) should use; the GitHub API is only ever touched by the
 * budget-gated syncer.
 */

import type { BoardItem } from "./board.ts";

const DB = "bounded-systems/front-desk-mirror";
const API = `https://www.dolthub.com/api/v1alpha1/${DB}`;

export interface DoltHubResult<T> {
  readonly query_execution_status: string;
  readonly query_execution_message?: string;
  readonly rows: T[];
}

/** Run read-only SQL against the DoltHub read plane. Zero GitHub, zero creds. */
export async function query<T = Record<string, unknown>>(sql: string, ref = "main"): Promise<T[]> {
  const res = await fetch(`${API}/${ref}?q=${encodeURIComponent(sql)}`);
  if (!res.ok) throw new Error(`DoltHub HTTP ${res.status}`);
  const body = (await res.json()) as DoltHubResult<T>;
  if (body.query_execution_status === "RowLimit") {
    throw new Error("DoltHub query exceeded the 1000-row API cap — narrow it (e.g. filter status).");
  }
  if (body.query_execution_status !== "Success") {
    throw new Error(`DoltHub query failed: ${body.query_execution_message || "unknown"}`);
  }
  return body.rows;
}

/** The mirror's freshness pin: the latest sync commit + time. */
export async function meta(): Promise<{ syncedAt: string; commit: string } | null> {
  const rows = await query<{ synced_at: string }>(
    "SELECT synced_at FROM sync_log ORDER BY id DESC LIMIT 1",
  );
  if (rows.length === 0) return null;
  const head = await query<{ commit_hash: string }>(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
  ).catch(() => []);
  return { syncedAt: rows[0].synced_at, commit: head[0]?.commit_hash?.slice(0, 12) ?? "?" };
}

export type SchedulingItem = BoardItem & {
  openBlockers: number;
  unblocks: number;
  ageDays: number;
  leased: boolean;
};

/**
 * The `bd ready` computation over the FULL edge graph (text + mined sub-issue/
 * closing-PR relations), done in SQL on the read plane — identical to
 * readMirrorScheduling but against DoltHub over HTTP, so it costs zero budget and
 * needs no local clone.
 */
export async function readScheduling(ref = "main"): Promise<SchedulingItem[]> {
  // Only NON-Done items are schedulable — and there are ~208 of them, well under
  // the 1000-row API cap (Done items would blow it). A dep pointing OUTSIDE this
  // set is a Done item → satisfied, so `openBlockers` = deps that ARE in the set.
  const [items, edges, leasedRows] = await Promise.all([
    query<{
      item_id: string; number: number | null; title: string; repository: string;
      status: string; kind: string; effort: number; value: number; depends_on: string; age_days: number | null;
    }>(
      "SELECT item_id, number, title, repository, status, kind, effort, value, depends_on, " +
        "DATEDIFF(UTC_TIMESTAMP(), created_at) AS age_days FROM items WHERE status <> 'Done'",
      ref,
    ),
    query<{ item_id: string; dep_item_id: string }>("SELECT item_id, dep_item_id FROM item_deps", ref),
    query<{ item_id: string }>(
      "SELECT DISTINCT item_id FROM claims WHERE status='active' AND TIMESTAMPADD(SECOND,ttl_sec,claimed_at)>UTC_TIMESTAMP()",
      ref,
    ),
  ]);

  const open = new Set(items.map((i) => i.item_id)); // non-Done ⇒ "open"
  const leased = new Set(leasedRows.map((r) => r.item_id));
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
