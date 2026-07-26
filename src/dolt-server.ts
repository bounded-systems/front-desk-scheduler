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
      q(SQL.leases) as Promise<{ item_id: string }[]>,
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
