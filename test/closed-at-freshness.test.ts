/**
 * `closed_at` must be refreshed by the SAME pass that refreshes `status`.
 *
 * #89 made closed_at load-bearing in two places — SCHEDULABLE excludes on it,
 * and status-drift compares it against the card. Both assume the field is as
 * fresh as the card. It was not: `syncPullDelta` (every ~6h) wrote `status` and
 * never touched `closed_at`, while `applyContentMeta` (full pull, rare) wrote
 * closed_at. Two completion signals on different clocks produced:
 *
 *   - a false drift report on EVERY closure — `status=Done, closed_at=NULL`
 *     until the next full sync. Observed live on #89 itself, ~30 min after the
 *     PR that introduced the detector merged and closed it.
 *   - worse, and silent: an issue closed WITHOUT its card moving stayed
 *     schedulable, because the mirror had no closed_at for it yet. That is #89
 *     recurring in the window the #89 fix was supposed to cover.
 *
 * The symmetry assertion is the subtle half. `closed_at` must be assigned
 * unconditionally, because a REOPEN clears it — skip the null and a stale
 * timestamp survives, and SCHEDULABLE reads that as "closed", so a reopened
 * item silently never ranks again. `created_at` is immutable and so is
 * correctly written behind an `if`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { sqlDatetimeOrNull, toSqlDatetime } from "../src/mirror.ts";

const SRC = readFileSync(new URL("../src/mirror.ts", import.meta.url), "utf8");

test("ISO → MySQL DATETIME", () => {
  assert.equal(toSqlDatetime("2026-07-08T23:26:31Z"), "2026-07-08 23:26:31");
});

test("a closed issue yields a quoted literal; a reopened one yields NULL", () => {
  assert.equal(sqlDatetimeOrNull("2026-07-08T23:26:31Z"), "'2026-07-08 23:26:31'");
  // Every absent-shape must clear the column, not omit the assignment.
  assert.equal(sqlDatetimeOrNull(null), "NULL", "reopened (GraphQL null) must CLEAR closed_at");
  assert.equal(sqlDatetimeOrNull(undefined), "NULL", "absent key must CLEAR closed_at");
  assert.equal(sqlDatetimeOrNull(""), "NULL", "empty string is absent, not a zero date");
});

test("Go's zero time means OPEN, not closed at year 1", () => {
  // THE ONE THAT WOULD HAVE EMPTIED THE QUEUE. `gh search issues --json closedAt`
  // does not omit the key or send null for an open issue: closedAt reaches
  // Issue.ExportData's `default:` branch as a time.Time, so the zero value
  // marshals to this string. It is truthy in JS, so a naive `iso ? ... : NULL`
  // writes it as a real timestamp — and SCHEDULABLE excludes every row with
  // closed_at set, so one hourly delta sync would drop every open item from the
  // ready queue.
  assert.equal(sqlDatetimeOrNull("0001-01-01T00:00:00Z"), "NULL");
  assert.equal(sqlDatetimeOrNull("0001-01-01T00:00:00.000Z"), "NULL", "fractional-seconds variant too");
  // A real timestamp that merely starts with a 0 digit must survive.
  assert.equal(sqlDatetimeOrNull("2001-01-01T00:00:00Z"), "'2001-01-01 00:00:00'");
});

test("NULL is emitted bare — a quoted 'NULL' would be a string, not a null", () => {
  assert.doesNotMatch(sqlDatetimeOrNull(null), /'/, "must not be quoted");
});

test("the delta search fetches closedAt, so status and closed_at share a clock", () => {
  const json = SRC.match(/"--json",\s*"([^"]+)"/);
  assert.ok(json, "the delta search must pass a --json field list");
  assert.match(
    json[1],
    /\bclosedAt\b/,
    "syncPullDelta must fetch closedAt — without it the field is refreshed only by the rare full pull, " +
      "and a freshly-closed issue whose card has not moved stays schedulable (#89 recurring)",
  );
});

test("both write paths assign closed_at unconditionally (reopen clears it)", () => {
  const assignments = [...SRC.matchAll(/^.*closed_at = .*$/gm)].map((m) => m[0].trim());
  assert.ok(assignments.length >= 2, "expected the delta and content-meta write paths");
  for (const line of assignments) {
    assert.doesNotMatch(
      line,
      /^if\s*\(/,
      `closed_at must not be written behind a truthiness guard — a reopen would leave it stale: ${line}`,
    );
    assert.match(line, /sqlDatetimeOrNull/, `closed_at must go through the null-safe helper: ${line}`);
  }
});
