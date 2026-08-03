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
import { ITEMS_SQL, planProjection, projectionUpsertSql, WATERMARK_SQL } from "../src/lease-projection.ts";

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
  assert.match(sql, /^INSERT INTO claims \(item_id, agent, fencing, decided_at_commit, claimed_at, ttl_sec, released_at, status\)/);
  // Not hand-computed (that went wrong once today already): derived from the
  // same conversion the code under test uses is a tautology, so derive from
  // the platform's OWN formatter instead.
  const want = new Date(T0).toISOString().replace("T", " ").slice(0, 19);
  assert.match(sql, new RegExp(`VALUES \\('prx#12', 'alice', 1, NULL, '${want}', 60, NULL, 'active'\\)`));
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
  assert.match(WATERMARK_SQL, /MAX\(fencing\)/);
  assert.match(WATERMARK_SQL, /fencing IS NOT NULL/, "legacy inline rows (NULL fencing) are not watermarks");
  assert.match(ITEMS_SQL, /FROM items/);
});
