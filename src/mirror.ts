/**
 * @module mirror
 * The Dolt read-plane. CQRS for the board:
 *
 *   GitHub (write plane) ──budget-gated sync──▶ Dolt mirror ──▶ all reads
 *
 * The syncer is the ONLY reader that touches the GitHub API; every consumer
 * (whats-next, agents, CI) queries the mirror at a pinned Dolt commit and needs
 * no GitHub credential. API spend is METERED (measured by diffing the live
 * rate-limit around the call, not guessed) into `api_spend`, and each sync is
 * gated through the same verified `budgetGate` that gates agent labor —
 * the scheduler's budget model applied to itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoardItem } from "./board.ts";
import { fetchBoardItems } from "./board.ts";
import { budgetGate, type Budget, type CapacityReport } from "./policy.ts";

const pexecFile = promisify(execFile);

export const MIRROR_DIR = new URL("../mirror", import.meta.url).pathname;

/** The GitHub GraphQL rate limit, modeled as a Budget in our own contract. */
export const GITHUB_GRAPHQL_BUDGET: Budget = {
  id: "github-graphql-hourly",
  window: { kind: "rolling", durationHours: 1, label: "1h" },
  capacityPoints: 5000,
  conversion: { unit: "tokens", unitPerPoint: 1 }, // 1 point = 1 GraphQL point
};

async function dsql(query: string): Promise<string> {
  const { stdout } = await pexecFile("dolt", ["sql", "-q", query, "-r", "json"], {
    cwd: MIRROR_DIR,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function dsqlRows<T>(query: string): Promise<T[]> {
  const out = await dsql(query);
  const parsed = JSON.parse(out || "{}") as { rows?: T[] };
  return parsed.rows ?? [];
}

// --- live rate-limit (the rate_limit endpoint itself is free) ---

export interface GraphqlLimit {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: string;
}

export async function fetchGraphqlLimit(): Promise<GraphqlLimit> {
  const { stdout } = await pexecFile("gh", [
    "api", "rate_limit",
    "-q", '{remaining: .resources.graphql.remaining, limit: .resources.graphql.limit, resetAt: (.resources.graphql.reset|todate)}',
  ]);
  return JSON.parse(stdout) as GraphqlLimit;
}

/** Capacity report for the API budget, from the LIVE limit (consumed = limit - remaining). */
export function apiCapacity(live: GraphqlLimit): CapacityReport {
  const consumed = live.limit - live.remaining;
  const cap = GITHUB_GRAPHQL_BUDGET.capacityPoints;
  const burnRatio = cap > 0 ? consumed / cap : Infinity;
  return {
    budget: GITHUB_GRAPHQL_BUDGET,
    plannedPoints: 0,
    plannedFits: true,
    consumedPoints: consumed,
    remainingPoints: Math.max(cap - consumed, 0),
    burnRatio,
    status: burnRatio >= 1 ? "over" : burnRatio >= 0.8 ? "at-risk" : "ok",
    plannedUnits: 0,
  };
}

// --- sync (the one GitHub read) ---

export interface SyncResult {
  readonly items: number;
  readonly costPoints: number;
  readonly remaining: number;
  readonly commit: string;
  readonly gated: false;
}

export interface SyncGated {
  readonly gated: true;
  readonly reason: string;
  readonly resetAt: string;
}

function sqlEscape(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll("'", "''");
}

/**
 * Upsert the full item set, keyed by the globally-unique project-item id —
 * issue NUMBERS collide across repos (#21 exists in several), which a
 * number-keyed REPLACE silently deduplicates. Rows gone from the board are removed.
 */
export async function upsertItems(items: readonly BoardItem[]): Promise<void> {
  const values = items
    .map((i) =>
      `('${sqlEscape(i.id)}',${i.number},'${sqlEscape(i.title)}','${sqlEscape(i.repository)}','${sqlEscape(i.status)}','${i.kind}',${i.effort},${i.value},'${sqlEscape(i.dependsOn.join(","))}')`,
    )
    .join(",");
  await dsql(`REPLACE INTO items (item_id,number,title,repository,status,kind,effort,value,depends_on) VALUES ${values}`);
  await dsql(`DELETE FROM items WHERE item_id NOT IN (${items.map((i) => `'${sqlEscape(i.id)}'`).join(",")})`);
}

/**
 * Pull the live board into the mirror as one Dolt commit. Fail-closed: if the
 * API budget can't afford an estimated sync (~`estimatePoints`), refuse and say
 * when it resets — instead of running into the wall like a blind retry.
 */
export async function syncPull(estimatePoints = 1400): Promise<SyncResult | SyncGated> {
  // 1400 ≈ measured: a full 1,253-item pull cost 1,314 GraphQL points (2026-07-25).
  const before = await fetchGraphqlLimit();
  const gate = budgetGate(apiCapacity(before), estimatePoints);
  if (!gate.allow) {
    return { gated: true, reason: gate.reason, resetAt: before.resetAt };
  }

  const items = await fetchBoardItems(undefined, undefined, undefined, 0); // live, no cache
  const after = await fetchGraphqlLimit();
  const cost = Math.max(before.remaining - after.remaining, 0);
  await upsertItems(items);
  await dsql(
    `INSERT INTO sync_log (synced_at, items_count, graphql_cost_points, graphql_remaining) VALUES (UTC_TIMESTAMP(), ${items.length}, ${cost}, ${after.remaining})`,
  );
  await dsql(`INSERT INTO api_spend (at, verb, points) VALUES (UTC_TIMESTAMP(), 'sync-pull', ${cost})`);

  await pexecFile("dolt", ["add", "-A"], { cwd: MIRROR_DIR });
  await pexecFile(
    "dolt",
    ["commit", "-m", `sync: ${items.length} items, ${cost} GraphQL points (remaining ${after.remaining})`],
    { cwd: MIRROR_DIR },
  );
  const { stdout: head } = await pexecFile("dolt", ["log", "-n", "1", "--oneline"], { cwd: MIRROR_DIR });

  return { items: items.length, costPoints: cost, remaining: after.remaining, commit: head.replace(/\x1b\[[0-9;]*m/g, "").trim(), gated: false };
}

// --- reads (no GitHub credential, pinned to the mirror) ---

export interface MirrorMeta {
  readonly syncedAt: string;
  readonly commit: string;
}

export async function mirrorMeta(): Promise<MirrorMeta | null> {
  const rows = await dsqlRows<{ synced_at: string }>(
    "SELECT synced_at FROM sync_log ORDER BY id DESC LIMIT 1",
  );
  if (rows.length === 0) return null;
  const { stdout } = await pexecFile("dolt", ["log", "-n", "1", "--oneline"], { cwd: MIRROR_DIR });
  // strip ANSI color codes dolt emits even when piped
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return { syncedAt: rows[0].synced_at, commit: clean.split(" ")[0] };
}

export async function readMirrorItems(): Promise<BoardItem[]> {
  const rows = await dsqlRows<{
    number: number; item_id: string; title: string; repository: string;
    status: string; kind: string; effort: number; value: number; depends_on: string;
  }>("SELECT * FROM items");
  return rows.map((r) => ({
    id: r.item_id,
    number: r.number,
    title: r.title,
    repository: r.repository,
    status: r.status,
    kind: r.kind as BoardItem["kind"],
    effort: r.effort,
    value: r.value,
    dependsOn: r.depends_on ? r.depends_on.split(",").map(Number) : [],
  }));
}
