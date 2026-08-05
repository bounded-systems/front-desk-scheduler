/**
 * @module dolthub
 * The read plane, over HTTP. Queries the public DoltHub SQL API — no GitHub API,
 * no local dolt clone, no credential, so reads NEVER touch the rate-limit budget
 * and are always at the latest synced commit. This is the source every consumer
 * (next, agents, CI) should use; the GitHub API is only ever touched by the
 * budget-gated syncer.
 */

import {
  asBlockingEdges,
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

/** DoltHub's hard per-query row cap. Crossing it is a `RowLimit` status, not rows. */
const ROW_CAP = 1000;

/**
 * Where an UNPAGINATED read starts failing, deliberately below `ROW_CAP`.
 *
 * #88: `list` died the moment the board's lifetime item count crossed 1000, and
 * nothing reported the transition — the error surfaced only when a caller
 * happened to run the verb. A cap you discover by hitting it gives no headroom.
 * This one fires with ~100 rows to spare and names the remedy, so the next read
 * to approach the wall fails in whatever lane runs it first.
 */
const CAP_GUARD = 900;

/** Rows per page for paginated reads. Well under `CAP_GUARD`, so a page can
 *  never trip the guard it is exempt from anyway. */
const PAGE_ROWS = 600;

export interface DoltHubResult<T> {
  readonly query_execution_status: string;
  readonly query_execution_message?: string;
  readonly rows: T[];
}

/** Single-quote a value for interpolation into Dolt SQL. Everything this module
 *  interpolates comes from the mirror itself (a commit hash, an `item_id`) or
 *  from a CLI/MCP `--repo` argument, but quote defensively rather than trusting
 *  provenance — same reasoning as `resolveHead`'s shape pin. */
function sqlQuote(v: string): string {
  return `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/**
 * Run read-only SQL against the DoltHub read plane. Zero GitHub, zero creds.
 *
 * `paginated` exempts a call from the `CAP_GUARD` — set it only when the CALLER
 * pages, because the guard's whole job is to catch a read that assumed it would
 * always fit and stopped being right.
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
  ref = "main",
  opts: { paginated?: boolean } = {},
): Promise<T[]> {
  const res = await fetch(`${API}/${ref}?q=${encodeURIComponent(sql)}`);
  if (!res.ok) throw new Error(`DoltHub HTTP ${res.status}`);
  const body = (await res.json()) as DoltHubResult<T>;
  if (body.query_execution_status === "RowLimit") {
    throw new Error(`DoltHub query exceeded the ${ROW_CAP}-row API cap — paginate it (see readAllItems) or narrow it.`);
  }
  if (body.query_execution_status !== "Success") {
    throw new Error(`DoltHub query failed: ${body.query_execution_message || "unknown"}`);
  }
  if (!opts.paginated && body.rows.length >= CAP_GUARD) {
    throw new Error(
      `DoltHub query returned ${body.rows.length} rows, within ${ROW_CAP - body.rows.length} of the ${ROW_CAP}-row API ` +
        `cap — this read is unpaginated and is about to break. Paginate it the way readAllItems does ` +
        `(keyset on the primary key, pinned with AS OF), or narrow it. Failing now, with headroom, is the point.`,
    );
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
    // Typed, because only BLOCKER_KINDS gate (a `closes` edge is provenance —
    // #155). The fallback is the pre-2026-07-26 window where `item_deps` has
    // no `edge_type`: those rows were all declared dependencies, so they
    // rehydrate as blocking. Same permanent historical-read case as `needs`.
    query<RawTypedEdge>(at(SQL.typedEdges), ref).catch((e: unknown) =>
      /column .*edge_type.* not found|edge_type.*could not be found/i.test(String(e))
        ? query<RawEdge>(at(SQL.edges), ref).then(asBlockingEdges)
        : Promise.reject(e)
    ),
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

/**
 * Typed dep edges (with edge_type) over DoltHub HTTP — the dep-graph source.
 *
 * `at` pins the read to a commit. `list` passes the pin its ITEM read resolved,
 * so both halves come from one board state: assembleGraph drops any edge whose
 * endpoints are not in the item set, so a sync landing between the two reads
 * would silently delete edges from the answer rather than fail. Same torn-read
 * argument as `readScheduling`, which has pinned its three queries all along.
 */
export async function readTypedEdges(ref = "main", at?: string | null): Promise<RawTypedEdge[]> {
  return query<RawTypedEdge>(at ? pinTables(SQL.typedEdges, at) : SQL.typedEdges, ref);
}

/** The all-items read and the commit its pages were read at — `at: null` when
 *  the head could not be resolved and the read fell back to unpinned. */
export interface AllItemsRead {
  readonly items: RawItem[];
  readonly at: string | null;
}

/**
 * ALL items incl Done over DoltHub HTTP (the `list` verb), paginated.
 *
 * #88: this verb read the whole table in one query and died when the board's
 * LIFETIME item count crossed the 1000-row cap — 1531 rows on 2026-07-31. It was
 * correct only while the board stayed small, and `--repo` could not rescue it
 * because the scope was applied client-side, AFTER the query it would have had
 * to narrow.
 *
 * KEYSET, NOT OFFSET. `item_id` is the table's primary key, so `WHERE item_id >
 * <last> ORDER BY item_id` is a total order with no cursor state on the server.
 * `OFFSET` would be wrong here: each page is an independent HTTP request, so a
 * sync landing mid-walk shifts the window and rows are silently dropped or
 * repeated — the worst failure for a verb that promises "every item".
 *
 * PINNED, for the same reason. `AS OF` the resolved head makes every page read
 * the same immutable snapshot, which is what turns "3 requests" back into one
 * consistent answer. Note the pin has to live in the SQL: the API's ref segment
 * accepts branch names only — a commit hash there is HTTP 400 (full-length) or
 * "branch not found" (truncated). Verified 2026-07-31.
 */
export async function readAllItems(
  ref = "main",
  scope: { repo?: string } = {},
): Promise<AllItemsRead> {
  const head = await resolveHead(ref);
  // `needs` landed 2026-07-31; a pin to an earlier commit has no such column.
  // Resolved once on the first page and reused — the schema cannot change
  // mid-walk, because every page reads the same commit.
  let base = SQL.allItems;
  let legacyTried = false;

  const page = (cursor: string): string => {
    const sql = head ? pinTables(base, head) : base;
    const where = [`item_id > ${sqlQuote(cursor)}`];
    // The scope narrows the QUERY, not the result set (#88). Client-side, it
    // could not lower the row count that broke the read in the first place.
    if (scope.repo) where.push(`repository = ${sqlQuote(scope.repo)}`);
    return `${sql} WHERE ${where.join(" AND ")} ORDER BY item_id LIMIT ${PAGE_ROWS}`;
  };

  const items: RawItem[] = [];
  let cursor = "";
  for (;;) {
    const rows = await query<RawItem>(page(cursor), ref, { paginated: true }).catch((e: unknown) => {
      if (!legacyTried && /column .*needs.* not found|needs.*could not be found/i.test(String(e))) {
        legacyTried = true;
        base = SQL.allItemsLegacy;
        return query<RawItem>(page(cursor), ref, { paginated: true });
      }
      return Promise.reject(e);
    });
    items.push(...rows);
    // A short page is the end of the table. A full page means there may be more,
    // so the walk costs one extra request when the count is an exact multiple.
    if (rows.length < PAGE_ROWS) break;
    cursor = rows[rows.length - 1]!.item_id;
  }
  return { items, at: head };
}

/**
 * A keyset walk over any mirror table, pinned with `AS OF` (#88, #148).
 *
 * `readAllItems` above is the hand-rolled instance of this for the `list` verb.
 * This is the same walk generalised, so that a NEW whole-table read — the
 * derivation pass needs two of them — cannot reintroduce the unpaginated shape
 * that CAP_GUARD now refuses at 900 rows. The rule from CLAUDE.md is that any
 * read of a table which grows without bound has to page; this is how.
 *
 * COMPOSITE CURSORS ARE NOT OPTIONAL. `items` has a single-column primary key,
 * but `item_deps` is keyed on (item_id, dep_item_id) — a keyset on `item_id`
 * alone is NOT a total order, so every edge that shared an item_id with the last
 * row of a page would be skipped. The predicate below is the lexicographic
 * comparison over however many columns the key actually has:
 *
 *   (a > a0) OR (a = a0 AND b > b0) OR (a = a0 AND b = b0 AND c > c0) …
 *
 * `LIMIT` is per page and `ORDER BY` names the same columns in the same order,
 * so the walk is a total order with no server-side cursor state — the property
 * that makes each page an independent HTTP request without dropping rows.
 */
// NOTE the unconstrained T. `T extends Record<string, unknown>` would be the
// obvious bound, but row types are declared as `readonly` interfaces and an
// interface without an index signature does not satisfy that constraint — so
// every caller would have to widen its row type purely to call this. The cursor
// read below is the only place a dynamic key is needed, so it casts there
// instead, and call sites keep their precise types.
export async function readPaged<T>(
  baseSql: string,
  keyColumns: readonly string[],
  ref = "main",
  extraWhere: readonly string[] = [],
): Promise<{ rows: T[]; at: string | null }> {
  if (keyColumns.length === 0) throw new Error("readPaged needs at least one key column");
  const head = await resolveHead(ref);
  const rows: T[] = [];
  let cursor: string[] | null = null;

  for (;;) {
    const sql = head ? pinTables(baseSql, head) : baseSql;
    const where = [...extraWhere];
    if (cursor) {
      // Lexicographic "strictly after the last row seen".
      const clauses: string[] = [];
      for (let i = 0; i < keyColumns.length; i++) {
        const eq = keyColumns.slice(0, i).map((c, j) => `${c} = ${sqlQuote(cursor![j]!)}`);
        clauses.push([...eq, `${keyColumns[i]} > ${sqlQuote(cursor[i]!)}`].join(" AND "));
      }
      where.push(`(${clauses.map((c) => `(${c})`).join(" OR ")})`);
    }
    const page = `${sql}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}` +
      ` ORDER BY ${keyColumns.join(", ")} LIMIT ${PAGE_ROWS}`;

    const got = await query<T>(page, ref, { paginated: true });
    rows.push(...got);
    // A short page is the end of the table. A full page costs one extra request
    // when the row count is an exact multiple — the same trade readAllItems makes.
    if (got.length < PAGE_ROWS) break;
    const last = got[got.length - 1] as Record<string, unknown>;
    cursor = keyColumns.map((c) => String(last[c]));
  }
  return { rows, at: head };
}
