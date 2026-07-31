/**
 * @module dolthub
 * The read plane, over HTTP. Queries the public DoltHub SQL API — no GitHub API,
 * no local dolt clone, no credential, so reads NEVER touch the rate-limit budget
 * and are always at the latest synced commit. This is the source every consumer
 * (next, agents, CI) should use; the GitHub API is only ever touched by the
 * budget-gated syncer.
 */

import {
  assembleScheduling,
  type ScheduleRead,
  type RawEdge,
  type RawItem,
  type RawTypedEdge,
  type SchedulingItem,
  SQL,
} from "./scheduling.ts";

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

/** Latest commit on `branch` — the snapshot identity a pinned read is made against. */
export async function resolveHead(branch = "main"): Promise<string | null> {
  const rows = await query<{ commit_hash: string }>(
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1",
    branch,
  ).catch(() => []);
  const h = rows[0]?.commit_hash;
  // Defensive: the hash is interpolated into SQL below. It comes from our own
  // dolt_log, but pin the shape anyway so a surprise can't become an injection.
  return h && /^[a-z0-9]{32}$/.test(h) ? h : null;
}

/** Pin every mirror-table FROM in `sql` to one commit. Dolt's `AS OF` is
 *  per-table-reference, so each FROM gets the same snapshot. */
export function pinTables(sql: string, head: string): string {
  return sql.replace(/FROM (items|item_deps|leases|claims)\b/g, `FROM $1 AS OF '${head}'`);
}

/**
 * The ready-rule read over DoltHub's public HTTP API — zero budget, no clone.
 * Reads NON-Done items only (stays under the 1000-row API cap); shared assembly.
 *
 * SNAPSHOT-CONSISTENT: the three queries are pinned to ONE commit (`AS OF` the
 * resolved head). Unpinned, they race the syncer — a delta sync landing between
 * the item read and the edge read hands assembly two different board states (a
 * torn read). The Dolt head SHA is what makes "one board state" a checkable
 * identity rather than a hope. If the head cannot be resolved, reads fall back
 * to unpinned `main` — availability over strictness for a read plane.
 */
export async function readScheduling(ref = "main"): Promise<ScheduleRead> {
  const head = await resolveHead(ref);
  const at = (sql: string) => (head ? pinTables(sql, head) : sql);
  const [items, edges, leasedRows] = await Promise.all([
    // `needs` landed 2026-07-31. A read pinned to an earlier commit has no such
    // column — the same permanent historical-read case as the leases fallback
    // below, not transitional scaffolding. Items then read as undeclared, which
    // is the truth about a board that never carried the field.
    query<RawItem>(at(SQL.items), ref).catch((e: unknown) =>
      /column .*needs.* not found|needs.*could not be found/i.test(String(e))
        ? query<RawItem>(at(SQL.itemsLegacy), ref)
        : Promise.reject(e)
    ),
    query<RawEdge>(at(SQL.edges), ref),
    // `leases` has existed on main since 2026-07-28, but this is NOT dead code:
    // `ref` can name any historical Dolt commit, and reading the board as it
    // stood before the migration is a permanent capability of a versioned
    // database, not a transitional concern. Falling back to the claims-derived
    // held set keeps historical reads working. READ-ONLY — the claim WRITE path
    // deliberately has no fallback, since writing through the old shape would
    // resurrect the unenforced-S1 bug.
    query<{ item_id: string }>(at(SQL.leases), ref).catch((e: unknown) =>
      /table not found: leases/.test(String(e)) ? query<{ item_id: string }>(at(SQL.leasesLegacy), ref) : Promise.reject(e)
    ),
  ]);
  return { items: assembleScheduling(items, edges, leasedRows.map((r) => r.item_id)), at: head };
}

/** Typed dep edges (with edge_type) over DoltHub HTTP — the dep-graph source. */
export async function readTypedEdges(ref = "main"): Promise<RawTypedEdge[]> {
  return query<RawTypedEdge>(SQL.typedEdges, ref);
}

/** ALL items incl Done over DoltHub HTTP (the `list` verb). */
export async function readAllItems(ref = "main"): Promise<RawItem[]> {
  return query<RawItem>(SQL.allItems, ref).catch((e: unknown) =>
    /column .*needs.* not found|needs.*could not be found/i.test(String(e))
      ? query<RawItem>(SQL.allItemsLegacy, ref)
      : Promise.reject(e)
  );
}
