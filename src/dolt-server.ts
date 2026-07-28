/**
 * @module dolt-server
 * The local-server read adapter — talks to a running `dolt sql-server` over the
 * MySQL wire protocol (the "dolt image"). Full SQL, no row cap, one persistent
 * connection instead of a process-per-query. The hot-path/containerized source.
 *
 * Auth is MySQL-style (this dolt version removed `--user` from sql-server; users
 * are `CREATE USER`/`GRANT`ed). A local-only server runs as `root` with no
 * password; a shared/containerized one takes a real credential — supplied here
 * via env, and brokerable exactly like the DoltHub cred (OIDC vault) later.
 *
 *   DOLT_HOST (default 127.0.0.1)  DOLT_PORT (3307)  DOLT_DB (mirror)
 *   DOLT_USER (root)               DOLT_PASSWORD ("")
 */

import { createConnection } from "mysql2/promise";
import {
  assembleScheduling,
  type RawEdge,
  type RawItem,
  type RawTypedEdge,
  type SchedulingItem,
  SQL,
} from "./scheduling.ts";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function serverConfig(): ServerConfig {
  return {
    host: process.env.DOLT_HOST ?? "127.0.0.1",
    port: Number(process.env.DOLT_PORT ?? 3307),
    user: process.env.DOLT_USER ?? "root",
    password: process.env.DOLT_PASSWORD ?? "",
    database: process.env.DOLT_DB ?? "mirror",
  };
}

async function withConn<T>(fn: (q: (sql: string) => Promise<unknown[]>) => Promise<T>): Promise<T> {
  const c = serverConfig();
  const conn = await createConnection({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
  });
  try {
    return await fn(async (sql) => {
      const [rows] = await conn.query(sql);
      return rows as unknown[];
    });
  } finally {
    await conn.end();
  }
}

export async function readScheduling(): Promise<SchedulingItem[]> {
  return withConn(async (q) => {
    const [items, edges, leased] = await Promise.all([
      q(SQL.items) as Promise<RawItem[]>,
      q(SQL.edges) as Promise<RawEdge[]>,
      // Same fallback as dolthub.ts: a read replica that has not yet pulled the
      // 2026-07-28 migration has no `leases` table. Read-only.
      (q(SQL.leases) as Promise<{ item_id: string }[]>).catch((e: unknown) =>
        /table not found.*leases|leases.*(doesn't|does not) exist/i.test(String(e))
          ? (q(SQL.leasesLegacy) as Promise<{ item_id: string }[]>)
          : Promise.reject(e)
      ),
    ]);
    return assembleScheduling(items, edges, leased.map((r) => r.item_id));
  });
}

/** Typed dep edges (with edge_type) — the GH-canonical dep-graph source. */
export async function readTypedEdges(): Promise<RawTypedEdge[]> {
  return withConn(async (q) => (await q(SQL.typedEdges)) as RawTypedEdge[]);
}

/** ALL items incl Done — the `bd list --all` replacement. */
export async function readAllItems(): Promise<RawItem[]> {
  return withConn(async (q) => (await q(SQL.allItems)) as RawItem[]);
}

export async function meta(): Promise<{ syncedAt: string; commit: string } | null> {
  return withConn(async (q) => {
    const rows = (await q("SELECT synced_at FROM sync_log ORDER BY id DESC LIMIT 1")) as { synced_at: string }[];
    if (rows.length === 0) return null;
    const head = (await q("SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1").catch(() => [])) as {
      commit_hash: string;
    }[];
    return { syncedAt: String(rows[0].synced_at), commit: head[0]?.commit_hash?.slice(0, 12) ?? "?" };
  });
}

// ── write seam (A2: the single serialization point) ──────────────────────────
//
// WHY THIS EXISTS
//
// `leases.item_id` is a PRIMARY KEY, so at most one lease row per item can
// exist — WITHIN ONE DATABASE. src/mirror.ts writes by shelling out to
// `dolt sql -q` against a LOCAL CLONE (MIRROR_DIR), so two agents on two
// machines each latch their own copy, both read back their own name, and both
// believe they hold the item. The conflict surfaces as a Dolt merge long after
// both have started working. That is assumption A2 in specs/lean/Leases.lean,
// stated there precisely because it is not discharged by the schema.
//
// A PRIMARY KEY is necessary and not sufficient: it needs every claimant to be
// writing to the SAME database. This seam is how the claim path reaches one.
//
// SCOPE — deliberately only the claim path. The sync/push writes run solely
// from GitHub Actions under the `mirror-write` concurrency group, so they are
// already single-writer; routing them here would add a dependency for no
// correctness gain. (mirror-sync-delta sits on its own group and can still race
// the other two — a real but separate bug, not this one.)
//
// Unconfigured (no DOLT_HOST), `writesGoToServer()` is false and mirror.ts
// keeps using the local clone. That is correct for single-agent development and
// wrong for concurrent agents, which is exactly what the log line says.

/** True when a server is configured — i.e. when claim writes can be serialized. */
export function writesGoToServer(): boolean {
  return Boolean(process.env.DOLT_HOST);
}

export interface WriteResult {
  readonly affectedRows: number;
}

/**
 * Run write statements against the shared server inside ONE connection, then
 * commit them as a Dolt commit.
 *
 * The commit is not optional bookkeeping. On a `dolt sql-server`, a write lands
 * in the session's working set; without DOLT_ADD + DOLT_COMMIT it never becomes
 * a commit, and the claim stops being attributable — which is the specific
 * property that justified putting the queue in Dolt at all. `author` is carried
 * through so `dolt log` answers "which agent claimed this", not just "something
 * changed".
 *
 * Returns each statement's affectedRows, so a caller can tell a real INSERT from
 * an INSERT IGNORE that collided — the difference between winning and losing a
 * latch.
 */
export async function writeAndCommit(
  statements: readonly string[],
  message: string,
  author: string,
): Promise<WriteResult[]> {
  const c = serverConfig();
  const conn = await createConnection({
    host: c.host, port: c.port, user: c.user, password: c.password, database: c.database,
  });
  try {
    const results: WriteResult[] = [];
    for (const sql of statements) {
      const [r] = await conn.query(sql);
      results.push({ affectedRows: (r as { affectedRows?: number }).affectedRows ?? 0 });
    }
    // Commit only if this session actually changed something; DOLT_COMMIT errors
    // on an empty diff, and a lost latch legitimately changes nothing.
    const [dirty] = await conn.query("SELECT COUNT(*) AS n FROM dolt_status");
    if (Number((dirty as { n: number }[])[0]?.n ?? 0) > 0) {
      await conn.query("CALL DOLT_ADD('-A')");
      await conn.query(
        `CALL DOLT_COMMIT('-m', ${conn.escape(message)}, '--author', ${conn.escape(author)})`,
      );
    }
    return results;
  } finally {
    await conn.end();
  }
}

/** Read rows from the shared server (claim path read-back, inside the same seam). */
export async function serverRows<T>(sql: string): Promise<T[]> {
  return withConn(async (q) => (await q(sql)) as T[]);
}
