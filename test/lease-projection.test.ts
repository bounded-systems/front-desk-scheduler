/**
 * The projection: DO grant history → Dolt claims rows.
 *
 * The two properties under test are the two halves of the named weakening in
 * docs/queue-vs-log.md. Idempotency is tested at the SQL-shape level here and
 * was verified against a REAL Dolt 2.2.2 before the design was committed
 * (upsert applied twice → one row, final state); replayability is a planning
 * property — same records + same watermark → same plan — so it IS testable
 * purely, and is.
 *
 * The rest is the trust boundary: everything interpolated is escaped or
 * allowlisted, because "the DO is ours" is exactly the kind of assumption this
 * repo has learned to stop leaning on.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { LeaseHistoryRecord } from "../src/lease-client.ts";
import {
  ITEMS_SQL,
  planProjection,
  projectionUpsertSql,
  WATERMARK_ROWS_SQL,
  watermarks,
} from "../src/lease-projection.ts";

const T0 = 1_800_000_000_000;

function rec(over: Partial<LeaseHistoryRecord> = {}): LeaseHistoryRecord {
  return {
    fencing: 1,
    agent: "alice",
    decidedAtCommit: null,
    grantedAt: T0,
    ttlSec: 60,
    expiresAt: T0 + 60_000,
    releasedAt: null,
    status: "active",
    effective_status: "active",
    reason: "free",
    ...over,
  };
}

test("an open interval projects as active with no close", () => {
  const sql = projectionUpsertSql("prx#12", rec());
  assert.match(sql, /^INSERT INTO claims \(item_id, agent, fencing, decided_at_commit, claimed_at, ttl_sec, released_at, status, referent\)/);
  // Not hand-computed (that went wrong once today already): derived from the
  // same conversion the code under test uses is a tautology, so derive from
  // the platform's OWN formatter instead.
  const want = new Date(T0).toISOString().replace("T", " ").slice(0, 19);
  assert.match(sql, new RegExp(`VALUES \\('prx#12', 'alice', 1, NULL, '${want}', 60, NULL, 'active', NULL\\)`));
  assert.match(sql, /ON DUPLICATE KEY UPDATE/, "the idempotency mechanism must be present");
});

test("a closed interval carries its close — same key, later truth", () => {
  const sql = projectionUpsertSql("prx#12", rec({
    releasedAt: T0 + 30_000, status: "completed", effective_status: "completed",
  }));
  assert.match(sql, /'completed'/);
  assert.doesNotMatch(sql, /released_at = NULL/, "the close must reach the UPDATE clause too");
});

test("a lapsed-but-untouched grant closes at its FACTUAL expiry", () => {
  // Stored status 'active', effective 'expired', releasedAt null: the DO never
  // saw a successor, so the projector supplies the close from the recorded
  // expiry — the factual lapse time, the only honest timestamp available.
  const sql = projectionUpsertSql("prx#12", rec({ effective_status: "expired" }));
  assert.match(sql, /'expired'/);
  const expiry = /released_at = '([^']+)'/.exec(sql);
  assert.ok(expiry, "an expired interval must be closed");
  assert.match(sql, new RegExp(`VALUES \\('prx#12', 'alice', 1, NULL, '([^']+)', 60, '${expiry![1]}'`));
});

test("replayability: same records + same watermark ⇒ byte-identical plan", () => {
  const records = [rec({ fencing: 3 }), rec({ fencing: 1, status: "completed", effective_status: "completed", releasedAt: T0 + 1 }), rec({ fencing: 2, effective_status: "expired" })];
  const a = planProjection("prx#12", records, 0);
  const b = planProjection("prx#12", records, 0);
  assert.deepEqual(a, b, "a lost run is a catch-up precisely because re-planning is deterministic");
  assert.equal(a.length, 3);
});

test("the plan respects the watermark and lands in grant order", () => {
  const records = [rec({ fencing: 5 }), rec({ fencing: 2 }), rec({ fencing: 9 })];
  const plan = planProjection("prx#12", records, 4);
  assert.equal(plan.length, 2, "records at or below the watermark are already projected");
  assert.match(plan[0], /, 5, /);
  assert.match(plan[1], /, 9, /, "ordered by fencing, not arrival");
});

test("a reaped interval projects as 'reaped' — never collapsed into released (#105)", () => {
  // The distinction is the observable #105 exists to create: once the TTL is a
  // backstop, an 'expired' row means the liveness path is broken — but only if
  // a GC close cannot masquerade as any other status.
  const sql = projectionUpsertSql("prx#12", rec({
    releasedAt: T0 + 30_000, status: "reaped", effective_status: "reaped",
  }));
  assert.match(sql, /'reaped'/);
  assert.doesNotMatch(sql, /'released'/);
  assert.doesNotMatch(sql, /released_at = NULL/, "the GC's close reaches the UPDATE clause");
});

test("everything interpolated is escaped — the DO being ours is not a trust argument", () => {
  const sql = projectionUpsertSql("it'; DROP TABLE claims; --", rec({ agent: "o'brien" }));
  assert.match(sql, /'it''; DROP TABLE claims; --'/, "item_id neutralised");
  assert.match(sql, /'o''brien'/, "agent neutralised");
});

test("a record that fails validation refuses to become SQL", () => {
  assert.throws(() => projectionUpsertSql("i", rec({ fencing: 0 })), /fencing/);
  assert.throws(() => projectionUpsertSql("i", rec({ fencing: 1.5 })), /fencing/);
  assert.throws(() => projectionUpsertSql("i", rec({ effective_status: "pwned" as never })), /unknown status/);
  assert.throws(() => projectionUpsertSql("i", rec({ agent: "" })), /agent/);
});

test("provenance survives the projection", () => {
  const sql = projectionUpsertSql("prx#12", rec({ decidedAtCommit: "v0110csl2jph0aeeij7rhhurrbjcft6g" }));
  assert.match(sql, /'v0110csl2jph0aeeij7rhhurrbjcft6g'/, "decided_at_commit reaches the row");
});

test("the watermark comes from the projection itself, and the poll set from the board", () => {
  assert.match(WATERMARK_ROWS_SQL, /FROM claims/);
  assert.match(WATERMARK_ROWS_SQL, /fencing IS NOT NULL/, "legacy inline rows (NULL fencing) are not watermarks");
  assert.match(ITEMS_SQL, /FROM items/);
});

// ── the watermark rule (#119) ──────────────────────────────────────────────

test("a settled item watermarks at its max fencing", () => {
  const marks = watermarks([
    { item_id: "i1", fencing: 1, status: "completed" },
    { item_id: "i1", fencing: 2, status: "reaped" },
    { item_id: "i2", fencing: 7, status: "expired" },
  ]);
  assert.equal(marks.get("i1"), 2);
  assert.equal(marks.get("i2"), 7);
});

test("an ACTIVE row does not advance the watermark — the close must be able to land", () => {
  // The #119 defect exactly: before the fix this returned 3, the projector
  // asked for `> 3`, and the open interval's close could never be re-read.
  const marks = watermarks([
    { item_id: "i1", fencing: 1, status: "completed" },
    { item_id: "i1", fencing: 2, status: "reaped" },
    { item_id: "i1", fencing: 3, status: "active" },
  ]);
  assert.equal(marks.get("i1"), 2, "the frontier is the last CLOSED interval");
});

test("a stranded active row BELOW a terminal one is re-read, not stepped over", () => {
  // MIN(active) - 1 rather than "ignore actives": a row frozen at 'active'
  // beneath a later closed one is the shape the pre-#119 watermark could
  // strand, and the rule has to self-heal it rather than leave it behind.
  const marks = watermarks([
    { item_id: "i1", fencing: 4, status: "active" },
    { item_id: "i1", fencing: 5, status: "reaped" },
  ]);
  assert.equal(marks.get("i1"), 3, "re-fetch from below the stranded interval");
});

test("an item never projected has no watermark (callers default to 0)", () => {
  assert.equal(watermarks([]).get("i1"), undefined);
});

test("fencing arriving as a JSON string still compares numerically (#101)", () => {
  // `dolt sql -r json` returns real numbers; the DoltHub HTTP plane returns
  // every column as a string. A lexical MAX would rank '9' above '10'.
  const marks = watermarks([
    { item_id: "i1", fencing: "9" as unknown as number, status: "reaped" },
    { item_id: "i1", fencing: "10" as unknown as number, status: "completed" },
  ]);
  assert.equal(marks.get("i1"), 10);
});

test("the mid-life case end to end: project live, close, project again", () => {
  // The property the module doc claimed and the code did not deliver — driven
  // as the projector drives it, watermark included, rather than asserted about
  // one SQL string.
  const open = rec({ fencing: 1, status: "active", effective_status: "active" });

  // Run 1 — the interval is live.
  const first = planProjection("prx#12", [open], watermarks([]).get("prx#12") ?? 0);
  assert.equal(first.length, 1);
  assert.match(first[0], /'active'/);
  assert.match(first[0], /, NULL, 'active'/, "an open interval has no close yet");

  // The projected row as it now stands in `claims`.
  const projected = [{ item_id: "prx#12", fencing: 1, status: "active" }];

  // Run 2 — the DO has since closed it. The watermark must NOT have frozen it.
  const closed = rec({
    fencing: 1, status: "reaped", effective_status: "reaped", releasedAt: T0 + 30_000,
    referent: { kind: "pr", id: "bounded-systems/front-desk-scheduler#111" },
  });
  const mark = watermarks(projected).get("prx#12") ?? 0;
  assert.equal(mark, 0, "the active row must not advance the frontier");

  const second = planProjection("prx#12", [closed], mark);
  assert.equal(second.length, 1, "the close is re-read rather than filtered out");
  assert.match(second[0], /'reaped'/);
  assert.match(second[0], /released_at = '[^']+'/, "the close reaches the UPDATE clause");
  assert.doesNotMatch(second[0], /released_at = NULL/);
  assert.match(second[0], /'pr:bounded-systems\/front-desk-scheduler#111'/);

  // Run 3 — now settled, the interval stops being re-read.
  const settled = watermarks([{ item_id: "prx#12", fencing: 1, status: "reaped" }]).get("prx#12") ?? 0;
  assert.equal(settled, 1);
  assert.equal(planProjection("prx#12", [closed], settled).length, 0, "converges; no re-projection forever");
});

// ── the referent (#119 defect 2) ───────────────────────────────────────────

test("the referent reaches the row — what the grant was pinned to, not just that it ended", () => {
  const sql = projectionUpsertSql("prx#12", rec({
    status: "reaped", effective_status: "reaped", releasedAt: T0 + 30_000,
    referent: { kind: "pr", id: "bounded-systems/front-desk-scheduler#117" },
  }));
  assert.match(sql, /INSERT INTO claims \([^)]*referent\)/, "the column is written");
  assert.match(sql, /'pr:bounded-systems\/front-desk-scheduler#117'/);
  assert.match(sql, /referent = 'pr:bounded-systems\/front-desk-scheduler#117'/, "and reaches the UPDATE clause");
});

test("an unbound grant projects a NULL referent — information, not omission", () => {
  // A referent-less lapse is the ORDINARY end of a session that died before
  // opening a PR. Distinguishing it from a bound lease reaching its backstop
  // is the whole reason the column exists (#113).
  const sql = projectionUpsertSql("prx#12", rec({ effective_status: "expired" }));
  assert.match(sql, /, NULL\)/, "no referent → NULL, never a fabricated one");
  assert.match(sql, /referent = NULL/);
});

test("a malformed referent refuses to become SQL", () => {
  assert.throws(
    () => projectionUpsertSql("i", rec({ referent: { kind: "pr" } as never })),
    /referent must be/,
  );
  assert.throws(
    () => projectionUpsertSql("i", rec({ referent: { kind: "pr", id: "x".repeat(300) } })),
    /exceeds 255/,
  );
});

test("the referent is escaped like everything else", () => {
  const sql = projectionUpsertSql("prx#12", rec({ referent: { kind: "pr", id: "o'brien/repo#1" } }));
  assert.match(sql, /'pr:o''brien\/repo#1'/);
});
