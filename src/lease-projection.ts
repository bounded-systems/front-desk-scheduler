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
 *                watermark is THE PROJECTION ITSELF — read back from Dolt, no
 *                separate cursor to lose: a failed run changes nothing, and
 *                the next run re-reads from the same watermark and re-upserts
 *                the same rows. The watermark is the max fencing whose interval
 *                is CLOSED — an `active` row never advances it (#119), which is
 *                what lets a later run overwrite a mid-life projection with its
 *                close. Same row, same key, later truth.
 *
 * Status progression is monotone — active → (renewed, still active) →
 * released|completed|expired|reaped, and the terminal states never regress —
 * so re-projecting a live interval until it closes converges rather than
 * flapping. Before #119 the watermark counted `active` rows, the projector
 * read strictly above it, and a mid-life projection was therefore final: the
 * row stayed `active`, `released_at` NULL, forever. That was precisely the
 * replayability failure the doc's property names.
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

/** The projected rows the watermark rule folds over — `watermarks()` is the
 *  ONE definition of that rule (#59 discipline); SQL only fetches rows. */
export interface ProjectedRowMark {
  readonly item_id: string;
  readonly fencing: number;
  readonly status: string;
}

/** Row fetch for `watermarks()`. Legacy inline rows (NULL fencing, written by
 *  the Dolt planes at claim time) carry no ordinal and are not watermarks.
 *  Local-clone read via `dolt sql`, so no DoltHub row cap applies; growth is
 *  one row per grant interval. */
export const WATERMARK_ROWS_SQL =
  "SELECT item_id, fencing, status FROM claims WHERE fencing IS NOT NULL";

/**
 * Watermarks: per item, the fencing below which the projection is settled —
 * the DO is only asked for records strictly above it.
 *
 *   - no `active` rows: MAX(fencing). Every projected interval is closed;
 *     nothing below the mark can change (terminal states never regress).
 *   - any `active` row: MIN(active fencing) - 1, so every still-open interval
 *     is re-fetched until its close lands (#119). MIN rather than "ignore
 *     actives" because a row frozen at `active` BELOW a terminal row — the
 *     shape the pre-#119 watermark could strand — must also be re-read; this
 *     rule self-heals it instead of stepping over it.
 *
 * The re-read set is bounded by the DO's one-lease-per-item invariant: at most
 * one live interval per item, so at most a handful of rows above the mark.
 *
 * Items never projected simply do not appear (callers default to 0). Fencing
 * arrives as a JSON string from `dolt sql -r json` on some planes (#101), so
 * it is coerced here, where the read lands.
 */
export function watermarks(rows: readonly ProjectedRowMark[]): Map<string, number> {
  const marks = new Map<string, number>();
  const openMin = new Map<string, number>();
  for (const r of rows) {
    const fencing = Number(r.fencing);
    if (!Number.isFinite(fencing)) continue;
    if (r.status === "active") {
      const open = openMin.get(r.item_id);
      if (open === undefined || fencing < open) openMin.set(r.item_id, fencing);
    }
    const max = marks.get(r.item_id);
    if (max === undefined || fencing > max) marks.set(r.item_id, fencing);
  }
  for (const [itemId, min] of openMin) marks.set(itemId, min - 1);
  return marks;
}

/** Enumerate the items whose DOs are worth polling. From the board mirror —
 *  claims flow through orderedReadyIds, which ranks board items, so the board
 *  bounds the poll set. (A hand-made claim on an unknown item_id is excluded
 *  by construction: its row could not be inserted anyway — claims has an FK to
 *  items with ON DELETE CASCADE, so Dolt would refuse the orphan.) */
export const ITEMS_SQL = "SELECT item_id FROM items";

function msToDatetime(ms: number): string {
  return sqlDatetime(Math.floor(ms / 1000));
}

/** `claims.referent` (#119): `kind:id`, the same rendering reap-leases and
 *  expiry-watch print. NULL when the grant was never bound — the ordinary
 *  shape of a lease whose session died before opening a PR — and on records
 *  from a worker that predates the referent (#107). */
function referentSql(r: LeaseHistoryRecord): string {
  const ref = r.referent ?? null;
  if (ref === null) return "NULL";
  if (typeof ref.kind !== "string" || ref.kind === "" || typeof ref.id !== "string" || ref.id === "") {
    throw new TypeError(`referent must be {kind, id} strings, got ${JSON.stringify(ref)}`);
  }
  const rendered = `${ref.kind}:${ref.id}`;
  // varchar(255) — refuse loudly rather than let Dolt truncate a forensic key.
  if (rendered.length > 255) throw new RangeError(`referent exceeds 255 chars: ${rendered.slice(0, 64)}…`);
  return sqlLit(rendered);
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
  const referent = referentSql(r);

  return (
    `INSERT INTO claims (item_id, agent, fencing, decided_at_commit, claimed_at, ttl_sec, released_at, status, referent)\n` +
    `VALUES (${item}, ${agent}, ${r.fencing}, ${dac}, ${claimedAt}, ${ttl}, ${releasedAt}, ${st}, ${referent})\n` +
    `ON DUPLICATE KEY UPDATE agent = ${agent}, decided_at_commit = ${dac}, claimed_at = ${claimedAt},\n` +
    `  ttl_sec = ${ttl}, released_at = ${releasedAt}, status = ${st}, referent = ${referent}`
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
