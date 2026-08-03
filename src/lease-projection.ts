/**
 * @module lease-projection
 * DO grant history → Dolt `claims` rows. The derived half of queue-vs-log.
 *
 * docs/queue-vs-log.md names the weakening the lease plane accepts — the log
 * records decisions rather than being the decision — and the two properties
 * that make it a catch-up-not-divergence trust edge. This module is where both
 * become code instead of promise:
 *
 *   IDEMPOTENT   every row is keyed by (item_id, fencing) under a UNIQUE index
 *                and written as INSERT … ON DUPLICATE KEY UPDATE, so applying a
 *                batch twice is the same as once. Verified against a real Dolt
 *                2.2.2 before this was written, not assumed from MySQL docs.
 *
 *   REPLAYABLE   the DO retains every grant record, and the projector's
 *                watermark is THE PROJECTION ITSELF — max projected fencing per
 *                item, read back from Dolt. There is no separate cursor to
 *                lose: a failed run changes nothing, and the next run re-reads
 *                from the same watermark and re-upserts the same rows.
 *
 * Status progression is monotone, which is what makes repeated projection of a
 * LIVE grant safe: active → (renewed, still active) → released|completed|
 * expired, and the terminal states never regress. Projecting an interval
 * mid-life writes status='active', released_at=NULL; a later run overwrites
 * with the close. Same row, same key, later truth.
 *
 * Everything interpolated here crosses a trust boundary — the DO is ours, but
 * "the input is trustworthy" is the assumption that stops being true the moment
 * anything else can write history. Statuses are allowlisted and strings escaped
 * unconditionally, same posture as attest.ts.
 */

import { sqlDatetime, sqlLit } from "./attest.ts";
import type { LeaseHistoryRecord } from "./lease-client.ts";

// 'reaped' (#105): the GC closed the interval because the grant's referent was
// observed merged, closed, or gone. Terminal like released/completed/expired,
// and kept distinct so a backstop expiry stays a monitorable anomaly.
const STATUSES = new Set(["active", "released", "completed", "expired", "reaped"]);

/** Watermarks: the max projected fencing per item, read from the projection
 *  itself. Items never projected simply do not appear (watermark 0). */
export const WATERMARK_SQL =
  "SELECT item_id, MAX(fencing) AS max_fencing FROM claims WHERE fencing IS NOT NULL GROUP BY item_id";

/** Enumerate the items whose DOs are worth polling. From the board mirror —
 *  claims flow through orderedReadyIds, which ranks board items, so the board
 *  bounds the poll set. (A hand-made claim on an unknown item_id is excluded
 *  by construction: its row could not be inserted anyway — claims has an FK to
 *  items with ON DELETE CASCADE, so Dolt would refuse the orphan.) */
export const ITEMS_SQL = "SELECT item_id FROM items";

function msToDatetime(ms: number): string {
  return sqlDatetime(Math.floor(ms / 1000));
}

/**
 * The upsert for one grant interval. Explicit literals in the UPDATE clause
 * rather than VALUES(col) — repeating them costs bytes and buys independence
 * from ON DUPLICATE KEY UPDATE dialect drift.
 */
export function projectionUpsertSql(itemId: string, r: LeaseHistoryRecord): string {
  if (!Number.isInteger(r.fencing) || r.fencing <= 0) {
    throw new RangeError(`fencing must be a positive integer, got ${JSON.stringify(r.fencing)}`);
  }
  const status = r.effective_status;
  if (!STATUSES.has(status)) {
    throw new RangeError(`unknown status ${JSON.stringify(status)} — refusing to interpolate`);
  }
  if (typeof r.agent !== "string" || r.agent === "") throw new TypeError("record has no agent");
  if (!Number.isFinite(r.grantedAt) || !Number.isFinite(r.ttlSec)) {
    throw new RangeError("record has no usable grantedAt/ttlSec");
  }

  const item = sqlLit(itemId);
  const agent = sqlLit(r.agent);
  const dac = r.decidedAtCommit === null ? "NULL" : sqlLit(r.decidedAtCommit);
  const claimedAt = sqlLit(msToDatetime(r.grantedAt));
  // A record closed by expiry carries releasedAt = its factual expiry; one
  // still active carries null. An 'expired' EFFECTIVE status on a stored
  // 'active' record (lapsed, untouched since) closes at the recorded expiry.
  const releasedMs = r.releasedAt ?? (status === "expired" ? r.expiresAt : null);
  const releasedAt = releasedMs === null ? "NULL" : sqlLit(msToDatetime(releasedMs));
  const ttl = Math.floor(r.ttlSec);
  const st = sqlLit(status);

  return (
    `INSERT INTO claims (item_id, agent, fencing, decided_at_commit, claimed_at, ttl_sec, released_at, status)\n` +
    `VALUES (${item}, ${agent}, ${r.fencing}, ${dac}, ${claimedAt}, ${ttl}, ${releasedAt}, ${st})\n` +
    `ON DUPLICATE KEY UPDATE agent = ${agent}, decided_at_commit = ${dac}, claimed_at = ${claimedAt},\n` +
    `  ttl_sec = ${ttl}, released_at = ${releasedAt}, status = ${st}`
  );
}

/**
 * Plan a batch: drop records at or below the watermark (defense in depth — the
 * DO already filtered by since_fencing, but a projector that trusts one filter
 * is a projector with one filter), order by fencing so the projection lands in
 * grant order, and emit one upsert per interval.
 */
export function planProjection(
  itemId: string,
  records: readonly LeaseHistoryRecord[],
  watermark: number,
): string[] {
  return [...records]
    .filter((r) => r.fencing > watermark)
    .sort((a, b) => a.fencing - b.fencing)
    .map((r) => projectionUpsertSql(itemId, r));
}
