/**
 * @module dolthub
 * The read plane, over HTTP. Queries the public DoltHub SQL API — no GitHub API,
 * no local dolt clone, no credential, so reads NEVER touch the rate-limit budget
 * and are always at the latest synced commit. This is the source every consumer
 * (whats-next, agents, CI) should use; the GitHub API is only ever touched by the
 * budget-gated syncer.
 */

import { assembleScheduling, type RawEdge, type RawItem, type SchedulingItem, SQL } from "./scheduling.ts";

export type { SchedulingItem };

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

/**
 * The `bd ready` read over DoltHub's public HTTP API — zero budget, no clone.
 * Reads NON-Done items only (stays under the 1000-row API cap); shared assembly.
 */
export async function readScheduling(ref = "main"): Promise<SchedulingItem[]> {
  const [items, edges, leasedRows] = await Promise.all([
    query<RawItem>(SQL.items, ref),
    query<RawEdge>(SQL.edges, ref),
    query<{ item_id: string }>(SQL.leases, ref),
  ]);
  return assembleScheduling(items, edges, leasedRows.map((r) => r.item_id));
}
