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
  readonly shapeFindings: ShapeFinding[];
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
  // Chunked: one giant multi-row statement blows Linux's argv limit (E2BIG) —
  // macOS's ARG_MAX is larger, which hid this locally.
  const CHUNK = 150;
  for (let at = 0; at < items.length; at += CHUNK) {
    const values = items
      .slice(at, at + CHUNK)
      .map((i) =>
        `('${sqlEscape(i.id)}',${i.number},'${sqlEscape(i.title)}','${sqlEscape(i.repository)}','${sqlEscape(i.status)}','${i.kind}',${i.effort},${i.value},'${sqlEscape(i.dependsOn.join(","))}')`,
      )
      .join(",");
    await dsql(`REPLACE INTO items (item_id,number,title,repository,status,kind,effort,value,depends_on) VALUES ${values}`);
  }
  await dsql(`DELETE FROM items WHERE item_id NOT IN (${items.map((i) => `'${sqlEscape(i.id)}'`).join(",")})`);

  // Resolve depends_on numbers → same-repo item ids into the item_deps edge
  // table (FK-enforced, so a dep can only point at a real board item). Numbers
  // are ambiguous cross-repo; same-repo is the resolution convention, and
  // unresolvable refs surface in shapeChecks() rather than silently dropping.
  await dsql("DELETE FROM item_deps");
  const byRepoNumber = new Map(items.map((i) => [`${i.repository}#${i.number}`, i.id]));
  const edges: string[] = [];
  for (const i of items) {
    for (const dep of i.dependsOn) {
      const target = byRepoNumber.get(`${i.repository}#${dep}`);
      if (target && target !== i.id) edges.push(`('${sqlEscape(i.id)}','${sqlEscape(target)}')`);
    }
  }
  if (edges.length > 0) {
    await dsql(`INSERT IGNORE INTO item_deps (item_id, dep_item_id) VALUES ${edges.join(",")}`);
  }
}

// --- native-relations mining (the bd-dep replacement) ---

interface RelationEdge {
  readonly src: string; // item_id that is blocked
  readonly dst: string; // item_id it waits on
  readonly type: "parent-child" | "closes";
}

/**
 * Mine GitHub's OWN relationship data into the dep graph — no human data entry:
 *   - sub-issues: a parent cannot complete while children are open
 *     → edge (parent → child, 'parent-child')
 *   - closing PR references: an issue with an open PR that closes it is
 *     in-delivery → edge (issue → PR, 'closes') — keeps agents off items
 *     whose fix is already in flight.
 * Paginated over the project's items; cost metered by the caller.
 */
export async function fetchRelationEdges(
  idByRepoNumber: ReadonlyMap<string, string>,
  org = "bounded-systems",
  project = 2,
): Promise<RelationEdge[]> {
  const edges: RelationEdge[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const args = [
      "api", "graphql",
      "-f", `query=query($org:String!,$num:Int!,$cursor:String){organization(login:$org){projectV2(number:$num){items(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id content{__typename ... on Issue{number repository{name}parent{number repository{name}}} ... on PullRequest{number repository{name}closingIssuesReferences(first:10){nodes{number repository{name}}}}}}}}}}`,
      "-F", `org=${org}`, "-F", `num=${project}`,
      ...(cursor ? ["-F", `cursor=${cursor}`] : []),
    ];
    const { stdout } = await pexecFile("gh", args, { maxBuffer: 16 * 1024 * 1024 });
    const data = JSON.parse(stdout) as {
      data?: { organization?: { projectV2?: { items?: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: {
          id: string;
          content?: {
            __typename: string;
            number?: number;
            repository?: { name: string };
            parent?: { number: number; repository: { name: string } } | null;
            closingIssuesReferences?: { nodes: { number: number; repository: { name: string } }[] };
          } | null;
        }[];
      } } } };
    };
    const items = data.data?.organization?.projectV2?.items;
    if (!items) break;
    for (const n of items.nodes) {
      const c = n.content;
      if (!c?.repository || c.number === undefined) continue;
      if (c.parent) {
        const parentId = idByRepoNumber.get(`${c.parent.repository.name}#${c.parent.number}`);
        if (parentId && parentId !== n.id) edges.push({ src: parentId, dst: n.id, type: "parent-child" });
      }
      for (const ref of c.closingIssuesReferences?.nodes ?? []) {
        const issueId = idByRepoNumber.get(`${ref.repository.name}#${ref.number}`);
        if (issueId && issueId !== n.id) edges.push({ src: issueId, dst: n.id, type: "closes" });
      }
    }
    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }
  return edges;
}

/** Replace mined edges (keeps text-parsed 'blocks' edges intact). */
export async function upsertRelationEdges(edges: readonly RelationEdge[]): Promise<void> {
  await dsql("DELETE FROM item_deps WHERE edge_type IN ('parent-child','closes')");
  if (edges.length === 0) return;
  const CHUNK = 300;
  for (let at = 0; at < edges.length; at += CHUNK) {
    const values = edges
      .slice(at, at + CHUNK)
      .map((e) => `('${sqlEscape(e.src)}','${sqlEscape(e.dst)}','${e.type}')`)
      .join(",");
    await dsql(`INSERT IGNORE INTO item_deps (item_id, dep_item_id, edge_type) VALUES ${values}`);
  }
}

// --- shape checks (the SHACL-style overlay, executed as SQL) ---

export interface ShapeFinding {
  readonly id: string;
  readonly severity: "hard" | "warn";
  readonly count: number;
  readonly message: string;
}

/**
 * Cross-row invariants the column constraints can't express. Same catalog idea
 * as machine-schema's invariantSpecs / the scheduler's S*-L*: each check is a
 * query whose result set must be empty. Declared once more, declaratively, in
 * specs/shapes.ttl (SHACL) for the org conformance story.
 */
export async function shapeChecks(): Promise<ShapeFinding[]> {
  const findings: ShapeFinding[] = [];
  const check = async (id: string, severity: "hard" | "warn", sql: string, message: string) => {
    const rows = await dsqlRows<{ n: number | string }>(sql);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) findings.push({ id, severity, count: n, message: `${n} ${message}` });
  };

  // D1 — dep graph is acyclic (deadlock-freedom's data precondition; scheduler L1).
  await check(
    "D1",
    "hard",
    `WITH RECURSIVE walk (src, dst, depth) AS (
       SELECT item_id, dep_item_id, 1 FROM item_deps
       UNION ALL
       SELECT w.src, d.dep_item_id, w.depth + 1
       FROM walk w JOIN item_deps d ON d.item_id = w.dst
       WHERE w.depth < 50
     ) SELECT COUNT(*) AS n FROM walk WHERE src = dst`,
    "dependency cycle path(s) — items that can never become Ready",
  );

  // D2 — Blocked status must be justified: a Blocked item should have ≥1 non-Done dep.
  await check(
    "D2",
    "warn",
    `SELECT COUNT(*) AS n FROM items i
     WHERE i.status = 'Blocked' AND NOT EXISTS (
       SELECT 1 FROM item_deps d JOIN items t ON t.item_id = d.dep_item_id
       WHERE d.item_id = i.item_id AND t.status <> 'Done')`,
    "Blocked item(s) with no open dependency recorded",
  );

  // D3 — the inverse: a Todo item with an open BLOCKING dep should be Blocked
  // (bd-ready agreement). 'closes' edges excluded: an open closing-PR means the
  // item is in delivery, not mis-statused.
  await check(
    "D3",
    "warn",
    `SELECT COUNT(*) AS n FROM items i
     WHERE i.status = 'Todo' AND EXISTS (
       SELECT 1 FROM item_deps d JOIN items t ON t.item_id = d.dep_item_id
       WHERE d.item_id = i.item_id AND d.edge_type <> 'closes' AND t.status <> 'Done')`,
    "Todo item(s) whose recorded deps are still open (should be Blocked)",
  );

  // D4 — unresolvable depends_on text (typo'd or cross-repo refs that resolved to nothing).
  await check(
    "D4",
    "warn",
    `SELECT COUNT(*) AS n FROM items i
     WHERE i.depends_on <> '' AND NOT EXISTS (SELECT 1 FROM item_deps d WHERE d.item_id = i.item_id)`,
    "item(s) with depends_on text that resolved to no edge (typo or cross-repo ref)",
  );

  return findings;
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

  // Mine native relations (sub-issues, closing PRs) into the dep graph — metered separately.
  const idByRepoNumber = new Map(items.map((i) => [`${i.repository}#${i.number}`, i.id]));
  const relEdges = await fetchRelationEdges(idByRepoNumber);
  await upsertRelationEdges(relEdges);
  const afterRel = await fetchGraphqlLimit();
  const relCost = Math.max(after.remaining - afterRel.remaining, 0);
  await dsql(`INSERT INTO api_spend (at, verb, points) VALUES (UTC_TIMESTAMP(), 'relations-pull', ${relCost})`);

  const shapeFindings = await shapeChecks();
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

  return {
    items: items.length,
    costPoints: cost,
    remaining: after.remaining,
    commit: head.replace(/\x1b\[[0-9;]*m/g, "").trim(),
    gated: false,
    shapeFindings,
  };
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

/**
 * Scheduling read: items with openBlockers/unblocks computed from the FULL edge
 * graph (text 'blocks' + mined 'parent-child' + 'closes') in SQL — so an issue
 * whose fix is already in an open PR ranks as blocked, and closing a hot
 * dependency scores high on flow. This is the `bd ready` computation, in the mirror.
 */
export async function readMirrorScheduling(): Promise<
  (BoardItem & { openBlockers: number; unblocks: number })[]
> {
  const rows = await dsqlRows<{
    number: number; item_id: string; title: string; repository: string;
    status: string; kind: string; effort: number; value: number; depends_on: string;
    open_blockers: number | string; unblocks: number | string;
  }>(`SELECT i.*,
      (SELECT COUNT(*) FROM item_deps d JOIN items t ON t.item_id = d.dep_item_id
        WHERE d.item_id = i.item_id AND t.status <> 'Done') AS open_blockers,
      (SELECT COUNT(*) FROM item_deps d2 JOIN items s ON s.item_id = d2.item_id
        WHERE d2.dep_item_id = i.item_id AND s.status <> 'Done') AS unblocks
      FROM items i`);
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
    openBlockers: Number(r.open_blockers),
    unblocks: Number(r.unblocks),
  }));
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
