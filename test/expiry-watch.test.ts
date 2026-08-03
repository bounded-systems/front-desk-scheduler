/**
 * The expiry monitor's judgments (#113), driven without a network.
 *
 * What is pinned here is the LINE #113 asks to be drawn: not every expiry is an
 * anomaly. A referent-less lease lapsing on its short claim ttl is the designed
 * outcome for a session that died before opening a PR, while a BOUND lease
 * reaching its backstop means the reaper never arrived. Only the second is "the
 * GC is down", and the discriminator is the referent — which is why this monitor
 * reads the DOs' /history, where the referent is, rather than `claims`, where
 * the projection drops it (#119).
 *
 * The collector's own liveness is tested alongside, because it is the leading
 * half of the same question: an expiry is a backstop-delayed confirmation that
 * reap-leases is down, and "reap-leases has not run" says the same thing hours
 * earlier.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ALARM_WINDOW_DAYS,
  boundReferent,
  classifyExpiry,
  classifyReaperLiveness,
  closedAt,
  emptyWatchReport,
  REAPER_SILENCE_LIMIT_SEC,
  watchVerdict,
  windowsCompose,
} from "../src/expiry-watch.ts";
import { CANDIDATE_CLOSED_WINDOW_DAYS, CANDIDATE_SQL } from "../src/reaper.ts";
import type { LeaseHistoryRecord } from "../src/lease-client.ts";

const NOW = 1_800_000_000_000;
const WINDOW_MS = ALARM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const HOUR = 3_600_000;

/** A referent-less grant that lapsed on the short claim ttl an hour ago. This is
 *  the exact shape of both real `expired` records on the live plane. */
const lapsed: LeaseHistoryRecord = {
  fencing: 1,
  agent: "gha/session-6993hp",
  decidedAtCommit: null,
  grantedAt: NOW - 2 * HOUR,
  ttlSec: 3600,
  expiresAt: NOW - HOUR,
  releasedAt: null,
  status: "active", // stored active — nobody came back to close it
  effective_status: "expired", // …and the DO computes the truth on read
  reason: "free",
  referent: null,
};

/** The same shape, but BOUND to a PR: the reaper's job, undone. */
const boundAndExpired: LeaseHistoryRecord = {
  ...lapsed,
  agent: "gha/session-abc123",
  ttlSec: 86400,
  referent: { kind: "pr", id: "bounded-systems/front-desk-scheduler#113" },
};

test("a referent-less lapse is ORDINARY — the designed outcome, not an anomaly", () => {
  const v = classifyExpiry(lapsed, NOW, WINDOW_MS);
  assert.equal(v.expired, true);
  if (!v.expired) return;
  assert.equal(v.kind, "ordinary");
  // #105: the session died before producing a referent. reap-leases would have
  // skipped it as `no-referent`, so its expiry implicates nobody.
});

test("a BOUND lease reaching its backstop is the alarm, and carries what it was pinned to", () => {
  const v = classifyExpiry(boundAndExpired, NOW, WINDOW_MS);
  if (!v.expired || v.kind !== "alarming") assert.fail("a bound lease that expired must be alarming");
  assert.deepEqual(v.referent, { kind: "pr", id: "bounded-systems/front-desk-scheduler#113" });
  assert.equal(v.closedAt, NOW - HOUR, "the alarm reports the factual lapse, not when it was noticed");
});

test("effective_status is what counts — a lapsed record is still stored 'active'", () => {
  // The case a monitor most needs to see: nobody came back to close the interval
  // precisely because nobody came back. The DO computes it on read.
  assert.equal(lapsed.status, "active");
  assert.equal(classifyExpiry(lapsed, NOW, WINDOW_MS).expired, true);
  // …and a genuinely live grant is not an expiry.
  const live = { ...lapsed, effective_status: "active" } as LeaseHistoryRecord;
  assert.deepEqual(classifyExpiry(live, NOW, WINDOW_MS), { expired: false, why: "not-expired" });
});

test("reaped and released intervals are not expiries — that distinction IS the observable", () => {
  for (const s of ["reaped", "released", "completed"] as const) {
    const r = { ...boundAndExpired, status: s, effective_status: s } as LeaseHistoryRecord;
    assert.deepEqual(
      classifyExpiry(r, NOW, WINDOW_MS),
      { expired: false, why: "not-expired" },
      `${s} must never raise the backstop alarm — #105 built the split precisely so it does not`,
    );
  }
});

test("an old expiry falls out of the window, so a fixed reaper lets the lane go green", () => {
  const ancient = { ...boundAndExpired, expiresAt: NOW - WINDOW_MS - HOUR };
  assert.deepEqual(classifyExpiry(ancient, NOW, WINDOW_MS), { expired: false, why: "outside-window" });
  // broker-drift.yml is the standing lesson: a monitor that is permanently red
  // is one nobody reads on the day it goes red for real.
});

test("a record from a worker predating #105 has no referent field, and that is not 'bound'", () => {
  // Not hypothetical: BOTH real expired records on the live plane omit the key
  // entirely. lease-core.mjs's own reading in currentReferent is that absent and
  // null are the same fact, followed here rather than re-decided — and it is
  // right on the merits, since a grant from before /bind existed could not have
  // been bound.
  const { referent: _dropped, ...preReferent } = boundAndExpired;
  const r = preReferent as LeaseHistoryRecord;
  assert.equal(boundReferent(r), null);
  const v = classifyExpiry(r, NOW, WINDOW_MS);
  assert.equal(v.expired && v.kind, "ordinary");
});

test("closedAt prefers the recorded release, and falls back to the factual expiry", () => {
  // lease-core closes a lapsed grant AT its recorded expiry, not at the moment
  // somebody next showed up — so both paths name the same instant.
  assert.equal(closedAt(lapsed), lapsed.expiresAt);
  assert.equal(closedAt({ ...lapsed, releasedAt: NOW - 90 * 60_000 }), NOW - 90 * 60_000);
});

test("a silent collector is red BEFORE any backstop fires — the leading indicator", () => {
  assert.deepEqual(classifyReaperLiveness(NOW - 10 * 60_000, NOW), { state: "live", ageSec: 600 });
  assert.equal(classifyReaperLiveness(NOW - 5 * HOUR, NOW).state, "silent");
  assert.deepEqual(classifyReaperLiveness(null, NOW), { state: "never" });
  // Five hours is ten missed sweeps on a twice-hourly cron; the limit sits above
  // a flake and far below the 24h backstop.
  assert.ok(5 * HOUR / 1000 > REAPER_SILENCE_LIMIT_SEC);
});

test("clock skew is clamped, not reported as a negative age", () => {
  assert.deepEqual(classifyReaperLiveness(NOW + 30_000, NOW), { state: "live", ageSec: 0 });
});

test("an unreadable Actions API is NOT red — unobservable is not bad news", () => {
  // The same asymmetry the reaper applies to referent probes. Failing the lane
  // on an API hiccup trains the reader to ignore it.
  const report = emptyWatchReport();
  report.reaper = { state: "unknown", why: "Actions API HTTP 502" };
  assert.equal(watchVerdict(report).red, false);
});

test("the three red conditions are reported separately, because they have different fixes", () => {
  const report = emptyWatchReport();
  report.reaper = { state: "silent", ageSec: 20_000 };
  report.expired.alarming = 2;
  report.failures = 1;
  const { red, reasons } = watchVerdict(report);
  assert.equal(red, true);
  assert.equal(reasons.length, 3, "a red that does not say WHICH fix sends its reader hunting");
});

test("an INCOMPLETE watch is red — a clean pass over unread candidates is a green made of nothing", () => {
  const report = emptyWatchReport();
  report.reaper = { state: "live", ageSec: 60 };
  report.failures = 1;
  assert.equal(watchVerdict(report).red, true);
});

test("a quiet, complete watch over a live collector is green", () => {
  const report = emptyWatchReport();
  report.reaper = { state: "live", ageSec: 60 };
  report.expired.ordinary = 7; // ordinary lapses never turn the lane red
  assert.deepEqual(watchVerdict(report), { red: false, reasons: [] });
});

test("the alarm window stays inside the window that still enumerates closed items", () => {
  // Machine-checked against the reaper's actual SQL rather than a comment: if the
  // alarm window outgrew the candidate union, this monitor would hunt for
  // expiries on items it has already stopped asking about, and report a clean
  // pass it did not earn.
  assert.ok(windowsCompose(), `${ALARM_WINDOW_DAYS}d alarm window must fit in the candidate window`);
  const m = /INTERVAL (\d+) DAY/.exec(CANDIDATE_SQL.recentlyClosed);
  assert.ok(m, "the recently-closed candidate query must carry a day interval");
  assert.equal(
    Number(m![1]),
    CANDIDATE_CLOSED_WINDOW_DAYS,
    "the SQL and the exported constant must be the same number, not two numbers that agree today",
  );
  assert.ok(ALARM_WINDOW_DAYS <= Number(m![1]));
});
