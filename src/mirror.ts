/**
 * @module mirror
 * The Dolt read-plane. CQRS for the board:
 *
 *   GitHub (write plane) ──budget-gated sync──▶ Dolt mirror ──▶ all reads
 *
 * The syncer is the only reader IN THIS REPO that touches the GitHub API; every
 * consumer (next, agents, CI) queries the mirror at a pinned Dolt commit
 * and needs no GitHub credential. It is NOT the only consumer of the rate limit:
 * the App installation token is minted per-workflow from the broker and shared
 * across every workflow using the front-desk App (lease-projection, claim-race,
 * broker-drift, other repos), which all draw on the same hourly bucket. That is
 * why capacity is read live rather than assumed — see `apiCapacity`.
 *
 * API spend is METERED (measured by diffing the live rate-limit around the call,
 * not guessed) into `api_spend`, and each sync is gated through the same verified
 * `budgetGate` that gates agent labor — the scheduler's budget model applied to itself.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BoardItem } from "./board.ts";
import { fetchBoardItems } from "./board.ts";
import { budgetGate, type Budget, type CapacityReport } from "./policy.ts";
import { parseFrontMatter, type FrontMatterResult } from "./frontmatter.ts";
import { type RawItem, type RawTypedEdge, SQL } from "./scheduling.ts";
import { type ClaimPlaneName, resolveClaimPlane, warnIfPlaneCannotExclude } from "./claim-plane.ts";
import { claimLease, releaseLeaseRemote, renewLeaseRemote } from "./lease-client.ts";

const pexecFile = promisify(execFile);

// Imported and re-exported, not defined here: `reads.ts` needs this path without
// needing the rest of this module. See mirror-dir.ts for why that matters.
import { MIRROR_DIR } from "./mirror-dir.ts";
export { MIRROR_DIR };

/**
 * The GitHub GraphQL rate limit, modeled as a Budget in our own contract.
 *
 * `capacityPoints` is a FLOOR, not the limit: 5,000/hr is the documented minimum
 * for an App installation, but the real ceiling scales with org size (up to
 * 12,500) and is only knowable at runtime. `apiCapacity` derives capacity from
 * the live limit and uses this constant solely as a fallback — see the note there.
 */
export const GITHUB_GRAPHQL_BUDGET: Budget = {
  id: "github-graphql-hourly",
  window: { kind: "rolling", durationHours: 1, label: "1h" },
  capacityPoints: 5000,
  conversion: { unit: "tokens", unitPerPoint: 1 }, // 1 point = 1 GraphQL point
};

/**
 * Points the syncer will NOT spend, held for other consumers of the shared App token.
 *
 * The App installation token is minted per-workflow from the broker and shared:
 * `lease-projection`, `claim-race`, `broker-drift` and every other repo using the
 * front-desk App all draw on ONE hourly bucket. Nothing meters them — `api_spend`
 * records this repo's syncer only — so their draw is invisible here by construction.
 *
 * This margin used to exist by accident. Before #55, `apiCapacity` graded a
 * real-scale `consumed` against a hardcoded 5,000, so `budgetGate` refused once
 * consumption passed ~3,600 regardless of the true ceiling — leaving ~70% of the
 * bucket permanently untouched. Fixing that arithmetic removed protection nobody
 * had chosen but everyone was relying on. This makes the same guarantee deliberate,
 * named, and sized by us.
 *
 * CHARGED TO THE GATE, NOT DEDUCTED FROM CAPACITY. The reserve is added to the
 * caller's estimate, so a refusal still reports the REAL `remaining`/`limit` rather
 * than a derived figure an operator has to decode back. `apiCapacity` keeps meaning
 * exactly what GitHub said.
 *
 * Cheap to hold: measured 2026-07-31, a full 1,521-item pull costs 16 points
 * against a bucket sitting at ~8,430 (`api_spend`/`sync_log`, post-#57). Reserving
 * 1,000 costs the syncer nothing in practice. It bites only when the bucket is
 * genuinely nearly gone — exactly when the other consumers need it.
 *
 * 1,000 is a CHOSEN FLOOR, not a measurement: no consumer outside this repo is
 * metered, so their real hourly draw is unknown. If it is ever measured, size this
 * off it instead. See #60.
 */
export const SHARED_TOKEN_RESERVE = 1000;

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

/**
 * Capacity report for the API budget, from the LIVE limit.
 *
 * Both sides of the ratio MUST come from the same scale. `consumed` is measured
 * against GitHub's real ceiling (`limit - remaining`), so capacity has to be that
 * same `limit` — not a hardcoded constant. Grading a real-scale `consumed`
 * against a fixed 5,000 is what made the syncer refuse with "exhausted" while
 * thousands of real points were still available: an App installation token whose
 * ceiling is ~8,350+ reports `remaining` values LARGER than the old constant, so
 * the gate blocked at a phantom wall (measured 2026-07-27: remaining 7,036 with
 * a modeled capacity of 5,000).
 *
 * The constant survives only as a floor for the case where `limit` is missing or
 * nonsensical (a malformed rate_limit payload), so a bad reading fails closed to
 * the documented minimum rather than to Infinity.
 */
export function apiCapacity(live: GraphqlLimit): CapacityReport {
  const cap = Number.isFinite(live.limit) && live.limit > 0
    ? live.limit
    : GITHUB_GRAPHQL_BUDGET.capacityPoints;
  // Clamp: a stale/al-limit reading must never present as negative consumption.
  const consumed = Math.min(Math.max(cap - live.remaining, 0), cap);
  const burnRatio = cap > 0 ? consumed / cap : Infinity;
  return {
    budget: { ...GITHUB_GRAPHQL_BUDGET, capacityPoints: cap },
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
  /** The live numbers behind the refusal — a bare "exhausted" hid a bad model. */
  readonly remaining: number;
  readonly limit: number;
  readonly estimatePoints: number;
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
  // Authority-aware pull. GitHub owns identity+state (title/status/number); Dolt
  // owns scheduling (effort/value/kind/depends_on). So:
  //   - NEW github rows: insert, seeding scheduling fields from the board (0 for
  //     fresh issues; frontmatter/estimator fills later).
  //   - EXISTING rows: refresh github-owned fields ONLY — never overwrite Dolt's
  //     effort/value/kind (that would launder an out-of-band project-field edit;
  //     such edits are surfaced as drift D6 instead).
  //   - GONE-from-board: delete only origin='github' rows (hidden/dolt-born survive).
  const existing = new Set(
    (await dsqlRows<{ item_id: string }>("SELECT item_id FROM items WHERE origin = 'github'"))
      .map((r) => r.item_id),
  );
  const fresh = items.filter((i) => !existing.has(i.id));
  const CHUNK = 150;

  for (let at = 0; at < fresh.length; at += CHUNK) {
    const values = fresh
      .slice(at, at + CHUNK)
      .map((i) =>
        `('${sqlEscape(i.id)}',${i.number},'${sqlEscape(i.title)}','${sqlEscape(i.repository)}','${sqlEscape(i.status)}','${i.kind}',${i.effort},${i.value},'${sqlEscape(i.dependsOn.join(","))}','github','synced')`,
      )
      .join(",");
    if (values) {
      await dsql(`INSERT INTO items (item_id,number,title,repository,status,kind,effort,value,depends_on,origin,sync_state) VALUES ${values}`);
    }
  }
  // Refresh github-owned fields on existing rows (batched UPDATE ... CASE).
  const olds = items.filter((i) => existing.has(i.id));
  for (let at = 0; at < olds.length; at += CHUNK) {
    const chunk = olds.slice(at, at + CHUNK);
    const ids = chunk.map((i) => `'${sqlEscape(i.id)}'`).join(",");
    const caseFor = (expr: (i: BoardItem) => string) =>
      chunk.map((i) => `WHEN '${sqlEscape(i.id)}' THEN ${expr(i)}`).join(" ");
    await dsql(
      `UPDATE items SET
         number = CASE item_id ${caseFor((i) => String(i.number))} END,
         title = CASE item_id ${caseFor((i) => `'${sqlEscape(i.title)}'`)} END,
         repository = CASE item_id ${caseFor((i) => `'${sqlEscape(i.repository)}'`)} END,
         status = CASE item_id ${caseFor((i) => `'${sqlEscape(i.status)}'`)} END
       WHERE item_id IN (${ids})`,
    );
  }
  const keep = items.map((i) => `'${sqlEscape(i.id)}'`).join(",");
  await dsql(`DELETE FROM items WHERE origin = 'github' AND item_id NOT IN (${keep || "''"})`);

  // depends_on 'blocks' edges (Dolt-owned; text field seeds them, frontmatter refines).
  await dsql("DELETE FROM item_deps WHERE edge_type = 'blocks'");
  const byRepoNumber = new Map(items.map((i) => [`${i.repository}#${i.number}`, i.id]));
  const edges: string[] = [];
  for (const i of items) {
    for (const dep of i.dependsOn) {
      const target = byRepoNumber.get(`${i.repository}#${dep}`);
      if (target && target !== i.id) edges.push(`('${sqlEscape(i.id)}','${sqlEscape(target)}','blocks')`);
    }
  }
  if (edges.length > 0) {
    await dsql(`INSERT IGNORE INTO item_deps (item_id, dep_item_id, edge_type) VALUES ${edges.join(",")}`);
  }
}

/** Insert HIDDEN work: a Dolt-born item with no GitHub counterpart. Never pushed
 *  unless captured. Visible to `next` so you can plan against it. */
export async function insertHiddenItem(
  input: { title: string; repository: string; kind?: string; effort?: number; value?: number },
  localId: string,
): Promise<string> {
  const id = `dolt:${localId}`;
  await dsql(
    `INSERT INTO items (item_id,number,title,repository,status,kind,effort,value,depends_on,origin,sync_state)
     VALUES ('${sqlEscape(id)}', NULL, '${sqlEscape(input.title)}', '${sqlEscape(input.repository)}',
             'Todo', '${input.kind ?? "task"}', ${input.effort ?? 0}, ${input.value ?? 0}, '', 'dolt', 'hidden')`,
  );
  return id;
}

/** Set Dolt-owned scheduling fields (the authoritative surface for these) and
 *  mark the row dolt-dirty so the next push propagates them to GitHub. */
export async function setDoltFields(
  itemId: string,
  fields: { effort?: number; value?: number; kind?: string },
): Promise<void> {
  const sets: string[] = [];
  if (fields.effort !== undefined) sets.push(`effort = ${fields.effort}`);
  if (fields.value !== undefined) sets.push(`value = ${fields.value}`);
  if (fields.kind !== undefined) sets.push(`kind = '${fields.kind}'`);
  if (sets.length === 0) return;
  await dsql(
    `UPDATE items SET ${sets.join(", ")}, sync_state = 'dolt-dirty' WHERE item_id = '${sqlEscape(itemId)}'`,
  );
}

// --- leases (SQS-style claiming; the scheduler's S1 mutual-exclusion, in SQL) ---
//
// A2: these three functions are the ONLY writes that multiple agents perform
// concurrently, so they are the only ones that need a single serialization
// point. When DOLT_HOST is set they go through the shared dolt sql-server
// (src/dolt-server.ts `writeAndCommit`), where the leases PRIMARY KEY is
// globally authoritative. Unset, they fall back to the local clone — correct
// for one agent, silently wrong for several, so `claimNext` says so out loud.

/** Route claim writes through the shared server when one is configured. */
async function claimWrite(
  statements: readonly string[],
  message: string,
  author: string,
): Promise<number[]> {
  const srv = await import("./dolt-server.ts");
  if (srv.writesGoToServer()) {
    return (await srv.writeAndCommit(statements, message, author)).map((r) => r.affectedRows);
  }
  warnIfUnserialized(); // warn where the fallback actually engages, not before
  for (const sql of statements) await dsql(sql);
  return statements.map(() => -1); // local clone: affectedRows unavailable via CLI
}

/** Read back through whichever plane the write went to — never a different one. */
async function claimRows<T>(sql: string): Promise<T[]> {
  const srv = await import("./dolt-server.ts");
  return srv.writesGoToServer() ? srv.serverRows<T>(sql) : dsqlRows<T>(sql);
}

/** Warn once when the mirror predates the decided_at_commit column. */
let warnedNoDecidedAt = false;
function warnNoDecidedAtColumn(): void {
  if (warnedNoDecidedAt) return;
  warnedNoDecidedAt = true;
  console.warn(
    "note: this mirror has no `claims.decided_at_commit` column, so claims are\n" +
    "  recorded without the board state they were decided against. Apply\n" +
    "  schema/migrations/2026-07-28-decided-at-commit.sql (mirror-migrate) to\n" +
    "  make claim decisions reconstructible. Claiming itself is unaffected.",
  );
}

/** Warn once per process when concurrent claims are unsafe. */
let warnedUnserialized = false;
function warnIfUnserialized(): void {
  if (warnedUnserialized) return;
  warnedUnserialized = true;
  console.warn(
    "warning: DOLT_HOST is unset, so claims are written to a LOCAL clone.\n" +
    "  The leases PRIMARY KEY excludes a second claimant within one database, not across\n" +
    "  clones — two agents on two machines can each latch their own copy and both believe\n" +
    "  they hold the item (assumption A2 in specs/lean/Leases.lean). Safe for a single\n" +
    "  agent; set DOLT_HOST to a shared dolt sql-server before running several.",
  );
}

export interface ClaimResult {
  readonly won: boolean;
  readonly itemId?: string;
  readonly number?: number;
  readonly title?: string;
  readonly reason: string;
  /**
   * The fencing token, on a plane that supplies one — currently only `lease`.
   *
   * NULL on the Dolt planes, and that null is information rather than an
   * omission: they have nothing to put here. A commit hash is content-addressed,
   * an identity and never an ordering, and AUTO_INCREMENT totally orders only
   * within one server — the assumption the whole design is trying to stop
   * depending on. A holder without a token cannot be fenced out by a sink.
   */
  readonly fencing?: number | null;
  /** Which plane adjudicated this. See src/claim-plane.ts. */
  readonly plane?: ClaimPlaneName;
}

/** Predicate: this lease row has not yet lapsed. `p` qualifies the columns. */
export const LEASE_LIVE = (p = "") =>
  `TIMESTAMPADD(SECOND, ${p}ttl_sec, ${p}claimed_at) > UTC_TIMESTAMP()`;

/**
 * Free every lapsed lease. Idempotent and safe to run concurrently: a lease that
 * is live cannot be reaped, and two reapers deleting the same dead row is a
 * no-op for the second. This is the whole recovery story for a dead worker —
 * no sweeper process, no stuck work.
 */
async function reapExpiredLeases(): Promise<void> {
  await claimWrite(
    [`DELETE FROM leases WHERE NOT (${LEASE_LIVE()})`],
    "reap expired leases",
    "front-desk <scheduler@front-desk>",
  );
}

/**
 * Claim the top-ranked eligible item for `agent` — a lease with a visibility
 * timeout.
 *
 * Mutual exclusion (the scheduler's S1) is carried by the PRIMARY KEY on
 * `leases.item_id`, not by a predicate: the INSERT either creates the single
 * permitted row or collides and is ignored. Two agents racing the same item
 * cannot both win regardless of isolation level, because there is no
 * check-then-act window between them — the engine adjudicates.
 *
 * This replaced an `INSERT ... WHERE NOT EXISTS` over the append-only `claims`
 * table, which enforced nothing (no unique index) and confirmed the win by
 * filtering on `agent`, so a double-insert reported success to BOTH agents. The
 * atomic CAS that specs/tla and specs/rust prove safe has to be supplied by the
 * implementation; only the schema can supply it. See schema/mirror.sql.
 *
 * Re-latching an item you already hold succeeds — a restarted worker reclaiming
 * its own lease is idempotent, not a race.
 *
 * `orderedIds` is the ranked candidate list (from readMirrorScheduling); we walk
 * it and take the first item we can actually latch.
 */
export async function claimNext(
  agent: string,
  orderedIds: readonly string[],
  ttlSec = 3600,
  decidedAtCommit: string | null = null,
): Promise<ClaimResult> {
  const plane = resolveClaimPlane();
  warnIfPlaneCannotExclude(plane);

  // The lease plane adjudicates elsewhere: the DO is ground truth for exclusion
  // and Dolt is a derived projection (docs/queue-vs-log.md). No `leases` row is
  // written here, and `plane.projected` is false so nothing downstream reads the
  // absence as a lost record. Walk the SAME ranked candidate list and take the
  // first grant — the ordering is the scheduler's, only the adjudication moves.
  if (plane.name === "lease") {
    for (const itemId of orderedIds) {
      // decidedAtCommit rides into the DO's grant history, so the projected
      // claims row carries the same provenance the Dolt planes write inline.
      const attempt = await claimLease(itemId, agent, ttlSec, decidedAtCommit);
      if (!attempt.granted) continue; // held by someone else — next candidate
      return {
        won: true,
        itemId,
        fencing: attempt.fencing,
        plane: plane.name,
        // The DO stores exclusion state, not the board, so it cannot supply
        // number/title. Callers that need them read the board they already
        // ranked from rather than being handed a fabricated blank.
        reason: `leased ${ttlSec}s (fencing ${attempt.fencing})`,
      };
    }
    return { won: false, plane: plane.name, reason: "no unleased eligible item" };
  }

  await reapExpiredLeases();
  for (const itemId of orderedIds) {
    const id = sqlEscape(itemId);
    const a = sqlEscape(agent);
    // Latch + audit in ONE session, committed together: on a shared server the
    // claims row and the lease land in a single attributable Dolt commit
    // instead of two, so history cannot show a lease with no claim behind it.
    await claimWrite(
      [
        `INSERT IGNORE INTO leases (item_id, agent, claimed_at, ttl_sec)
         VALUES ('${id}', '${a}', UTC_TIMESTAMP(), ${ttlSec})`,
      ],
      `claim ${itemId} by ${agent}`,
      `${agent} <${agent}@front-desk>`,
    );
    // Read back the one row the PK guarantees exists — through the SAME plane
    // the write went to, or the answer would describe a different database.
    // Race-free BECAUSE the row is unique: it cannot name two winners.
    const held = await claimRows<{ agent: string; number: number; title: string }>(
      `SELECT l.agent AS agent, i.number AS number, i.title AS title
       FROM leases l JOIN items i ON i.item_id = l.item_id
       WHERE l.item_id = '${id}'`,
    );
    if (held[0]?.agent !== agent) continue; // another agent holds it — next candidate
    // Audit only, deliberately after the latch: `claims` records history and is
    // not load-bearing for S1, so losing this row costs forensics, not correctness.
    // decided_at_commit answers "what board was this decided against" — the
    // ranking is a pure function of the board, so without it a claim is not
    // reproducible and a bad pick cannot be told apart from stale data.
    // Shape-checked before interpolation; NULL when the adapter could not pin.
    const dac = decidedAtCommit && /^[a-z0-9]{32}$/.test(decidedAtCommit)
      ? `'${sqlEscape(decidedAtCommit)}'`
      : "NULL";
    // Degrade if the mirror predates 2026-07-28-decided-at-commit.sql. A
    // migration needs a dispatch and a human approval, so there is always a
    // window where merged code runs against an unmigrated mirror — and losing
    // provenance is strictly better than failing every claim in that window.
    //
    // Note this fallback is legitimate where the leases one is NOT: omitting
    // decided_at_commit costs only reconstructibility, whereas writing claims
    // through the pre-leases shape would resurrect the unenforced-S1 bug. A
    // write fallback is fine exactly when it cannot weaken an invariant.
    const auditMsg = `claim ${itemId} by ${agent} (audit)`;
    const auditAuthor = `${agent} <${agent}@front-desk>`;
    try {
      await claimWrite(
        [
          `INSERT INTO claims (item_id, agent, decided_at_commit, claimed_at, ttl_sec, status)
           VALUES ('${id}', '${a}', ${dac}, UTC_TIMESTAMP(), ${ttlSec}, 'active')`,
        ],
        auditMsg,
        auditAuthor,
      );
    } catch (e) {
      if (!/Unknown column 'decided_at_commit'/i.test(String((e as { sqlMessage?: string }).sqlMessage ?? e))) throw e;
      warnNoDecidedAtColumn();
      await claimWrite(
        [
          `INSERT INTO claims (item_id, agent, claimed_at, ttl_sec, status)
           VALUES ('${id}', '${a}', UTC_TIMESTAMP(), ${ttlSec}, 'active')`,
        ],
        auditMsg,
        auditAuthor,
      );
    }
    // fencing: null — the Dolt planes have no total order to offer. That null
    // is the honest answer, not a missing field.
    return {
      won: true, itemId, number: held[0].number, title: held[0].title,
      fencing: null, plane: plane.name, reason: `leased ${ttlSec}s`,
    };
  }
  return { won: false, plane: plane.name, reason: "no unleased eligible item" };
}

/**
 * Heartbeat — push the lease's expiry out without releasing it. Returns false if
 * the lease has already lapsed and been taken by someone else, which is the
 * signal for a long-running agent to stop working on the item rather than race
 * the new holder. Renewing on a shorter TTL than the job's runtime is the point:
 * a worker that dies stops heartbeating and the item returns to the queue fast.
 */
export async function renewLease(
  itemId: string,
  agent: string,
  ttlSec?: number,
  fencing?: number | null,
): Promise<boolean> {
  const plane = resolveClaimPlane();
  if (plane.name === "lease") {
    // The token is not optional here. Renewing without one would ask the DO to
    // take our word that we are still the holder, which is the entire thing
    // fencing exists to stop — and a lapsed holder is exactly the caller most
    // likely to have lost track of it.
    if (typeof fencing !== "number") {
      throw new Error(
        "renewLease on the lease plane requires the fencing token from claimNext — " +
          "renewing without it cannot distinguish the holder from a zombie",
      );
    }
    return renewLeaseRemote(itemId, agent, fencing, ttlSec ?? 3600);
  }
  const id = sqlEscape(itemId);
  const a = sqlEscape(agent);
  await claimWrite(
    [`UPDATE leases SET claimed_at = UTC_TIMESTAMP()${ttlSec ? `, ttl_sec = ${ttlSec}` : ""}
     WHERE item_id = '${id}' AND agent = '${a}' AND ${LEASE_LIVE()}`],
    `heartbeat ${itemId} by ${agent}`,
    `${agent} <${agent}@front-desk>`,
  );
  const rows = await claimRows<{ agent: string }>(
    `SELECT agent FROM leases WHERE item_id = '${id}' AND ${LEASE_LIVE()}`,
  );
  return rows[0]?.agent === agent;
}

/**
 * Release/complete a lease — frees the item and closes the audit interval. The
 * `agent` predicate matters: a straggler whose lease already lapsed and was
 * re-latched by someone else must not free the new holder's lease.
 */
export async function releaseClaim(
  itemId: string,
  agent: string,
  status: "released" | "completed",
  fencing?: number | null,
): Promise<void> {
  const plane = resolveClaimPlane();
  if (plane.name === "lease") {
    if (typeof fencing !== "number") {
      throw new Error(
        "releaseClaim on the lease plane requires the fencing token from claimNext — " +
          "a release without one is how a zombie frees the NEW holder's lease",
      );
    }
    // `status` goes into the DO's grant history and reaches Dolt via the
    // lease-projection workflow — the released-vs-completed interval effort
    // calibration reads. A worker predating status recording is detected by
    // the client (missing echo) and warned there, not silently absorbed here.
    await releaseLeaseRemote(itemId, agent, fencing, status);
    return;
  }
  const id = sqlEscape(itemId);
  const a = sqlEscape(agent);
  // Both statements in one session → one commit: the lease disappears and the
  // claim interval closes atomically in history.
  await claimWrite(
    [
      `DELETE FROM leases WHERE item_id = '${id}' AND agent = '${a}'`,
      `UPDATE claims SET status = '${status}', released_at = UTC_TIMESTAMP()
       WHERE item_id = '${id}' AND agent = '${a}' AND status = 'active'`,
    ],
    `${status} ${itemId} by ${agent}`,
    `${agent} <${agent}@front-desk>`,
  );
}

/** Item ids currently under a live lease — excluded from the ready queue. */
export async function liveClaimedIds(): Promise<Set<string>> {
  const rows = await claimRows<{ item_id: string }>(
    `SELECT item_id FROM leases WHERE ${LEASE_LIVE()}`,
  );
  return new Set(rows.map((r) => r.item_id));
}

// --- push (dolt → gh): the second write surface ---

/** Flip a hidden item to "capture-requested" so the next push promotes it to a real issue. */
export async function captureHidden(itemId: string): Promise<void> {
  await dsql(`UPDATE items SET sync_state = 'dolt-dirty' WHERE item_id = '${sqlEscape(itemId)}' AND origin = 'dolt'`);
}

export interface PushResult {
  readonly captured: number; // dolt-born rows promoted to GitHub issues
  readonly pushed: number; // dolt-dirty github rows whose fields were written up
  readonly gated: boolean;
}

/**
 * Push Dolt-owned edits to GitHub — the "captured work" flow:
 *   - dolt-born, capture-requested (`dolt:` id, dolt-dirty): create the GitHub
 *     issue (scheduling fields ride in frontmatter); drop the placeholder so the
 *     next pull re-absorbs it as a real github-origin row.
 *   - github row, dolt-dirty: write effort/value UP to the board project fields
 *     (Dolt is authoritative; this also corrects any out-of-band drift), mark synced.
 * Budget-gated like the pull.
 */
export async function syncPush(estimatePoints = 200): Promise<PushResult> {
  const before = await fetchGraphqlLimit();
  // + reserve, same as the pull. #60 names only syncPull, but the push is the same
  // syncer drawing on the same shared bucket — reserving in one and not the other
  // would leave the hole open exactly where the reserve is meant to bite.
  if (!budgetGate(apiCapacity(before), estimatePoints + SHARED_TOKEN_RESERVE).allow) {
    return { captured: 0, pushed: 0, gated: true };
  }
  const { fetchProjectMeta, setNumberField } = await import("./board.ts");

  // 1. capture dolt-born rows
  const born = await dsqlRows<{ item_id: string; title: string; repository: string; kind: string; effort: number; value: number }>(
    "SELECT item_id, title, repository, kind, effort, value FROM items WHERE origin='dolt' AND sync_state='dolt-dirty' AND item_id LIKE 'dolt:%'",
  );
  let captured = 0;
  for (const r of born) {
    const fm = `---\nkind: ${r.kind}\neffort: ${r.effort}\nvalue: ${r.value}\n---\n\n_Captured from Front Desk hidden work._`;
    await pexecFile("gh", ["issue", "create", "--repo", `bounded-systems/${r.repository}`, "--title", r.title, "--body", fm]);
    await dsql(`DELETE FROM items WHERE item_id = '${sqlEscape(r.item_id)}'`); // next pull re-absorbs as github-origin
    captured++;
  }

  // 2. push dolt-dirty github rows' owned fields up to the board
  const dirty = await dsqlRows<{ item_id: string; effort: number; value: number }>(
    "SELECT item_id, effort, value FROM items WHERE origin='github' AND sync_state='dolt-dirty'",
  );
  let pushed = 0;
  let failed = 0;
  if (dirty.length > 0) {
    const meta = await fetchProjectMeta();
    // GitHub's project API 5xx/504s intermittently under load — retry a few times
    // with backoff before giving up on an item (it stays dolt-dirty for next run).
    const setWithRetry = async (field: string, value: number, id: string) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await setNumberField(meta, id, field, value);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 5 && /50[0234]|timeout|ECONNRESET|EOF|reset by peer/i.test(msg)) {
            await new Promise((r) => setTimeout(r, 500 * attempt));
            continue;
          }
          throw err;
        }
      }
    };
    for (const r of dirty) {
      try {
        await setWithRetry("Effort", r.effort, r.item_id);
        await setWithRetry("Value", r.value, r.item_id);
        await dsql(`UPDATE items SET sync_state='synced' WHERE item_id='${sqlEscape(r.item_id)}'`);
        pushed++;
      } catch {
        failed++; // leave dolt-dirty; a later run retries
      }
    }
    if (failed > 0) console.error(`syncPush: ${failed} items left dolt-dirty (transient errors) — retry later`);
  }
  return { captured, pushed, gated: false };
}

// --- native-relations mining (typed dep edges from GH-native relations) ---

interface RelationEdge {
  readonly src: string; // item_id that is blocked
  readonly dst: string; // item_id it waits on
  readonly type: "blocks" | "parent-child" | "closes";
}

export interface ContentMeta {
  readonly itemId: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly fm: FrontMatterResult;
}

export interface ContentGraph {
  readonly edges: RelationEdge[];
  readonly meta: ContentMeta[];
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
export async function fetchContentGraph(
  idByRepoNumber: ReadonlyMap<string, string>,
  org = "bounded-systems",
  project = 2,
): Promise<ContentGraph> {
  const edges: RelationEdge[] = [];
  const meta: ContentMeta[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const args = [
      "api", "graphql",
      "-f", `query=query($org:String!,$num:Int!,$cursor:String){organization(login:$org){projectV2(number:$num){items(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id content{__typename ... on Issue{number createdAt closedAt body repository{name}parent{number repository{name}}} ... on PullRequest{number createdAt closedAt body repository{name}closingIssuesReferences(first:10){nodes{number repository{name}}}}}}}}}}`,
      "-F", `org=${org}`, "-F", `num=${project}`,
      ...(cursor ? ["-F", `cursor=${cursor}`] : []),
    ];
    const { stdout } = await pexecFile("gh", args, { maxBuffer: 64 * 1024 * 1024 });
    const data = JSON.parse(stdout) as {
      data?: { organization?: { projectV2?: { items?: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: {
          id: string;
          content?: {
            __typename: string;
            number?: number;
            createdAt?: string;
            closedAt?: string;
            body?: string;
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
      const fm = parseFrontMatter(c.body ?? "");
      meta.push({ itemId: n.id, createdAt: c.createdAt, closedAt: c.closedAt ?? undefined, fm });
      if (c.parent) {
        const parentId = idByRepoNumber.get(`${c.parent.repository.name}#${c.parent.number}`);
        if (parentId && parentId !== n.id) edges.push({ src: parentId, dst: n.id, type: "parent-child" });
      }
      for (const ref of c.closingIssuesReferences?.nodes ?? []) {
        const issueId = idByRepoNumber.get(`${ref.repository.name}#${ref.number}`);
        if (issueId && issueId !== n.id) edges.push({ src: issueId, dst: n.id, type: "closes" });
      }
      // frontmatter-declared deps: unambiguous repo#number, any repo → 'blocks'
      for (const d of fm.fm.dependsOn) {
        const depId = idByRepoNumber.get(`${d.repo}#${d.number}`);
        if (depId && depId !== n.id) edges.push({ src: n.id, dst: depId, type: "blocks" });
      }
    }
    if (!items.pageInfo.hasNextPage) break;
    cursor = items.pageInfo.endCursor;
  }
  return { edges, meta };
}

/** Apply content meta: created_at + frontmatter overrides (author intent wins). */
export async function applyContentMeta(meta: readonly ContentMeta[]): Promise<ShapeFinding[]> {
  const CHUNK = 100;
  for (let at = 0; at < meta.length; at += CHUNK) {
    const stmts = meta
      .slice(at, at + CHUNK)
      .flatMap((m) => {
        const sets: string[] = [];
        if (m.createdAt) sets.push(`created_at = '${m.createdAt.replace("T", " ").replace("Z", "")}'`);
        if (m.closedAt) sets.push(`closed_at = '${m.closedAt.replace("T", " ").replace("Z", "")}'`);
        if (m.fm.fm.kind) sets.push(`kind = '${m.fm.fm.kind}'`);
        if (m.fm.fm.effort !== undefined) sets.push(`effort = ${m.fm.fm.effort}`);
        if (m.fm.fm.value !== undefined) sets.push(`value = ${m.fm.fm.value}`);
        return sets.length > 0
          ? [`UPDATE items SET ${sets.join(", ")} WHERE item_id = '${sqlEscape(m.itemId)}';`]
          : [];
      })
      .join("");
    if (stmts) await dsql(stmts);
  }
  const bad = meta.filter((m) => m.fm.findings.length > 0);
  if (bad.length === 0) return [];
  return [{
    id: "D5",
    severity: "warn",
    count: bad.length,
    message: `${bad.length} item(s) with invalid frontmatter: ` +
      bad.slice(0, 5).map((m) => `${m.itemId.slice(-6)}:${m.fm.findings.map((f) => f.message).join(";")}`).join(" | "),
  }];
}

/** Replace mined + declared edges (text-parsed 'blocks' from upsertItems survive via PK dedupe). */
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
  // (ready-rule agreement). 'closes' edges excluded: an open closing-PR means the
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

  // D6 — items stuck dolt-dirty (edited on the Dolt surface, never pushed to GitHub).
  // Not a data error — a reminder that the second write surface has unflushed work.
  await check(
    "D6",
    "warn",
    "SELECT COUNT(*) AS n FROM items WHERE sync_state = 'dolt-dirty'",
    "item(s) with unpushed Dolt-owned edits (run scripts/push.ts to capture)",
  );

  return findings;
}

/**
 * Drift: a github row whose LIVE board project-field effort/value diverges from
 * Dolt's authoritative value with no frontmatter to justify it — i.e. someone
 * edited the project field directly in the GitHub UI (an invalid write under the
 * authority contract). Returns the offenders; the caller decides (re-push wins).
 */
export async function detectFieldDrift(
  boardItems: readonly BoardItem[],
): Promise<{ itemId: string; number: number; field: string; board: number; dolt: number }[]> {
  const dolt = new Map(
    (await dsqlRows<{ item_id: string; effort: number; value: number }>(
      "SELECT item_id, effort, value FROM items WHERE origin='github' AND sync_state='synced'",
    )).map((r) => [r.item_id, r]),
  );
  const drift: { itemId: string; number: number; field: string; board: number; dolt: number }[] = [];
  for (const b of boardItems) {
    const d = dolt.get(b.id);
    if (!d) continue;
    if (b.effort !== d.effort) drift.push({ itemId: b.id, number: b.number, field: "effort", board: b.effort, dolt: d.effort });
    if (b.value !== d.value) drift.push({ itemId: b.id, number: b.number, field: "value", board: b.value, dolt: d.value });
  }
  return drift;
}

/** Headroom over the last measured pull — the board grows between syncs. */
const SYNC_ESTIMATE_HEADROOM = 1.1;
/** Used only until `api_spend` has a measured `sync-pull` to learn from. */
export const SYNC_ESTIMATE_FALLBACK = 1600;

/**
 * Estimate the next full pull's cost from what the last few actually cost.
 *
 * A hardcoded estimate goes stale in the dangerous direction: it was set to 1400
 * when a 1,253-item pull cost 1,314, and by the time the board reached 1,330
 * items the real cost was 1,415 — the gate was reserving LESS than the sync
 * would spend. Reading `api_spend` keeps the reservation ahead of the true cost
 * as the board grows.
 */
export async function estimateSyncCost(): Promise<number> {
  const rows = await dsqlRows<{ points: number }>(
    "SELECT points FROM api_spend WHERE verb = 'sync-pull' AND points > 0 ORDER BY at DESC LIMIT 5",
  ).catch(() => [] as { points: number }[]);
  const measured = rows.map((r) => Number(r.points)).filter((p) => Number.isFinite(p) && p > 0);
  if (measured.length === 0) return SYNC_ESTIMATE_FALLBACK;
  return Math.ceil(Math.max(...measured) * SYNC_ESTIMATE_HEADROOM);
}

/**
 * Pull the live board into the mirror as one Dolt commit. Fail-closed: if the
 * API budget can't afford an estimated sync (~`estimatePoints`, derived from
 * recent measured cost when not given), refuse and say when it resets — instead
 * of running into the wall like a blind retry.
 */
export async function syncPull(estimatePoints?: number): Promise<SyncResult | SyncGated> {
  const estimate = estimatePoints ?? await estimateSyncCost();
  const before = await fetchGraphqlLimit();
  // + reserve: the pull competes with every other consumer of the shared App token.
  const gate = budgetGate(apiCapacity(before), estimate + SHARED_TOKEN_RESERVE);
  if (!gate.allow) {
    return {
      gated: true,
      reason: gate.reason,
      resetAt: before.resetAt,
      remaining: before.remaining,
      limit: before.limit,
      estimatePoints: estimate,
    };
  }

  const items = await fetchBoardItems(undefined, undefined, undefined, 0); // live, no cache
  const after = await fetchGraphqlLimit();
  const cost = Math.max(before.remaining - after.remaining, 0);
  await upsertItems(items);

  // Mine native relations + content meta (frontmatter, createdAt) — metered separately.
  const idByRepoNumber = new Map(items.map((i) => [`${i.repository}#${i.number}`, i.id]));
  const graph = await fetchContentGraph(idByRepoNumber);
  await upsertRelationEdges(graph.edges);
  const fmFindings = await applyContentMeta(graph.meta);
  const afterRel = await fetchGraphqlLimit();
  const relCost = Math.max(after.remaining - afterRel.remaining, 0);
  await dsql(`INSERT INTO api_spend (at, verb, points) VALUES (UTC_TIMESTAMP(), 'relations-pull', ${relCost})`);

  const shapeFindings = [...(await shapeChecks()), ...fmFindings];
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

// --- delta sync (#1): refresh only what changed, via the Search API ---

export interface DeltaResult {
  readonly changed: number; // existing rows refreshed
  readonly newSeen: number; // changed issues not yet on the mirror (weekly full-add covers these)
  readonly since: string;
}

/**
 * Cheap incremental refresh. The full pull measured 1,415 GraphQL points on the
 * legacy `gh project item-list` path (the "~610" this comment used to claim was
 * long stale); the `fieldValueByName` query should bring that to ~15 — confirm
 * with `npm run board:parity`. Most of the 1,330 items are Done and static
 * either way, so an incremental refresh is still the right shape. The Search API
 * (a SEPARATE rate-limit budget, not GraphQL) returns only issues updated since
 * the last sync — usually a handful. We refresh github-owned fields (title,
 * status via open/closed) on the rows we already have; brand-new issues are left
 * for the weekly full pull to add (they need a project-item id search can't give).
 *
 * Deliberately conservative: only sets closed→Done (the transition that goes
 * stale); open items keep their board status (Todo/In Progress/Blocked), which
 * the full pull reconciles.
 */
export async function syncPullDelta(org = "bounded-systems"): Promise<DeltaResult> {
  // Metered, not assumed. This path is believed to spend no GraphQL (Search is a
  // separate budget), but it runs ~10x more often than the full pull, and it used
  // to record `0`/`-1` as literals — so 174 of the last 192 runs told the ledger
  // nothing. When points DID disappear between full syncs (2026-07-25: remaining
  // fell to 935) there was no row to attribute them to. Measuring costs one free
  // rate_limit call and turns "we assume this is free" into a checkable claim.
  const before = await fetchGraphqlLimit().catch(() => null);
  const last = await dsqlRows<{ synced_at: string }>(
    "SELECT synced_at FROM sync_log ORDER BY id DESC LIMIT 1",
  );
  const since = (last[0]?.synced_at ?? "2020-01-01 00:00:00").slice(0, 10); // date granularity
  const { stdout } = await pexecFile("gh", [
    "search", "issues",
    "--owner", org,
    "--updated", `>=${since}`,
    "--json", "number,repository,title,state,isPullRequest",
    "--limit", "500",
  ], { maxBuffer: 32 * 1024 * 1024 });
  const results = JSON.parse(stdout) as {
    number: number; title: string; state: string; isPullRequest: boolean;
    repository: { name: string };
  }[];

  const known = new Map(
    (await dsqlRows<{ item_id: string; repository: string; number: number }>(
      "SELECT item_id, repository, number FROM items WHERE origin='github'",
    )).map((r) => [`${r.repository}#${r.number}`, r.item_id]),
  );

  let changed = 0;
  let newSeen = 0;
  for (const r of results) {
    const id = known.get(`${r.repository.name}#${r.number}`);
    if (!id) { newSeen++; continue; }
    const status = r.state.toLowerCase() === "closed" ? "Done" : undefined;
    const sets = [`title = '${sqlEscape(r.title)}'`];
    if (status) sets.push(`status = '${status}'`);
    await dsql(`UPDATE items SET ${sets.join(", ")} WHERE item_id = '${sqlEscape(id)}'`);
    changed++;
  }
  const after = before ? await fetchGraphqlLimit().catch(() => null) : null;
  // -1 stays the "not sampled" sentinel, so a failed reading is distinguishable
  // from a genuine zero-cost run rather than silently logging as free.
  const cost = before && after ? Math.max(before.remaining - after.remaining, 0) : 0;
  const remaining = after ? after.remaining : -1;
  await dsql(
    `INSERT INTO sync_log (synced_at, items_count, graphql_cost_points, graphql_remaining) VALUES (UTC_TIMESTAMP(), ${changed}, ${cost}, ${remaining})`,
  );
  await dsql(`INSERT INTO api_spend (at, verb, points) VALUES (UTC_TIMESTAMP(), 'delta-search', ${cost})`);
  return { changed, newSeen, since };
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
 * dependency scores high on flow. This is the ready-rule computation, in the mirror.
 */
/** Typed dep edges (with edge_type) from the local clone — the dep-graph source. */
export async function readMirrorTypedEdges(): Promise<RawTypedEdge[]> {
  return dsqlRows<RawTypedEdge>(SQL.typedEdges);
}

/** ALL items incl Done from the local clone (the `list` verb). */
export async function readMirrorAllItems(): Promise<RawItem[]> {
  return dsqlRows<RawItem>(SQL.allItems);
}

export async function readMirrorScheduling(): Promise<
  (BoardItem & { openBlockers: number; unblocks: number; ageDays: number; leased: boolean })[]
> {
  const rows = await dsqlRows<{
    number: number; item_id: string; title: string; repository: string;
    status: string; kind: string; effort: number; value: number; depends_on: string;
    open_blockers: number | string; unblocks: number | string; age_days: number | string | null; leased: number | string;
  }>(`SELECT i.*, DATEDIFF(UTC_TIMESTAMP(), i.created_at) AS age_days,
      EXISTS(SELECT 1 FROM leases l WHERE l.item_id=i.item_id AND ${LEASE_LIVE("l.")}) AS leased,
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
    ageDays: r.age_days == null ? 0 : Number(r.age_days),
    leased: Number(r.leased) > 0,
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
