/**
 * The scheduled-lane watchdog (#124).
 *
 * Two kinds of test here. Most pin the classification rules — which are where
 * the judgement lives, and where a wrong call either cries wolf or stays quiet
 * through an outage. The last one is different in kind: it checks the
 * ENUMERATION against the actual workflow files, because #124's whole premise
 * is that a hand-maintained list of lanes to watch is the next thing to go
 * silently stale.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyLane,
  describeLane,
  expandField,
  expectedPeriodSec,
  isRed,
  PERIOD_MULTIPLIER,
  readLanes,
  toleranceSec,
} from "../src/lane-watch.ts";

const T = Date.UTC(2026, 7, 4, 0, 0, 0);
const HOUR = 3600;

// ── cron → period ───────────────────────────────────────────────────────────

test("the period comes from when the cron FIRES, not from how its first field reads", () => {
  // The case that motivated simulating rather than parsing: `13,43 * * * *` is
  // every 30 minutes. Reading the minute field gives no hint of that.
  assert.equal(expectedPeriodSec("13,43 * * * *"), 30 * 60);
  assert.equal(expectedPeriodSec("37 * * * *"), HOUR);
  assert.equal(expectedPeriodSec("17 */6 * * *"), 6 * HOUR);
  assert.equal(expectedPeriodSec("51 */3 * * *"), 3 * HOUR);
  assert.equal(expectedPeriodSec("47 6 * * *"), 24 * HOUR);
  assert.equal(expectedPeriodSec("23 7 * * 2"), 7 * 24 * HOUR);
});

test("an uneven step reports its LONGEST gap, which is the one a tolerance must survive", () => {
  // */7 fires at :00,:07,…,:56 then wraps to the next hour's :00 — so the wrap
  // gap is 4 minutes and the longest gap is the ordinary 7. Worth pinning
  // because the wrap is where an off-by-one would hide, and because writing
  // this test is how I found my own arithmetic was wrong: I expected 11.
  assert.equal(expectedPeriodSec("*/7 * * * *"), 7 * 60);
  // A step that does NOT divide the range evenly and wraps LONG: :00 and :50
  // are 50 apart within the hour, but :50 → next :00 is only 10.
  assert.equal(expectedPeriodSec("0,50 * * * *"), 50 * 60);
});

test("a cron too rare to see twice reports null rather than a short period", () => {
  // Feb 29 fires once in the window at most. Guessing small here would mark a
  // healthy rare lane silent forever.
  assert.equal(expectedPeriodSec("0 0 29 2 *"), null);
});

test("an unsupported cron form throws instead of quietly matching everything", () => {
  // A watchdog that silently widens its own tolerance is the failure it watches
  // for.
  assert.throws(() => expandField("1-2-3", 0, 59), /unsupported|out of range/);
  assert.throws(() => expandField("99", 0, 59), /out of range/);
  assert.throws(() => expandField("*/0", 0, 59), /step/);
  assert.throws(() => expectedPeriodSec("1 2 3"), /5 cron fields/);
});

// ── tolerance ───────────────────────────────────────────────────────────────

test("tolerance survives the 83-minute gap that actually happened", () => {
  // #124 records real reap-leases gaps reaching 83 minutes on a twice-hourly
  // schedule — 2.8x the period. Anything at or below 3x would have cried wolf
  // on a healthy lane, which is why the multiplier is not derived from the cron.
  const tol = toleranceSec(30 * 60);
  assert.ok(tol > 83 * 60, `tolerance ${tol}s must exceed the observed 4980s gap`);
  assert.ok(PERIOD_MULTIPLIER > 3, "3x would have been too tight against observed behaviour");
});

test("tolerance is capped, so a weekly lane's silence is not noticed a month late", () => {
  assert.ok(toleranceSec(7 * 24 * HOUR) <= 10 * 86400);
});

// ── classification ──────────────────────────────────────────────────────────

/** Runs inside the tolerance window, newest first, one minute apart. */
const runs = (...conclusions: string[]) =>
  conclusions.map((conclusion, i) => ({ conclusion, atMs: T - (i + 1) * 60_000 }));

const obs = (over: Partial<Parameters<typeof classifyLane>[0]> = {}) => ({
  lastSuccessMs: T - 60_000,
  recent: runs("success", "success", "success"),
  ...over,
});

test("a lane succeeding on time and not failing is live", () => {
  const s = classifyLane(obs(), T, 2 * HOUR);
  assert.equal(s.state, "live");
});

test("no success within tolerance is silent, and the line says which lane and what to do", () => {
  const s = classifyLane(obs({ lastSuccessMs: T - 5 * HOUR * 1000 }), T, 2 * HOUR);
  assert.equal(s.state, "silent");
  const line = describeLane("reap-leases.yml", s);
  assert.match(line, /reap-leases\.yml/, "names the lane");
  assert.match(line, /run list/, "names the next action");
  assert.ok(isRed(s));
});

test("never having succeeded is its own state — the #112 shape", () => {
  // 24 runs, 24 failures. Reporting that as merely "old" is how it survived.
  const s = classifyLane(obs({ lastSuccessMs: null, recent: runs(...Array(10).fill("failure")) }), T, 2 * HOUR);
  assert.equal(s.state, "never");
  assert.match(describeLane("lease-projection.yml", s), /first failure, not the latest/);
  assert.ok(isRed(s));
});

test("a lane with NO runs at all is unknown, not never — zero attempts is not evidence", () => {
  // Found by running it, not by a test: on its first real run this watchdog
  // accused ITSELF of the #112 shape, reporting `NEVER (0/0 recent runs
  // failed)`. #112 was 24 attempts and 24 failures; a lane merged an hour ago
  // has not failed, it has not been tried. Any newly added lane hit this.
  const s = classifyLane(obs({ lastSuccessMs: null, recent: [] }), T, 2 * HOUR);
  assert.equal(s.state, "unknown");
  assert.ok(!isRed(s), "a lane that has never been tried must not be red");
  assert.match(describeLane("lane-watch.yml", s), /newly added|still in flight/);
});

test("a lane that keeps failing and recovering is FLAPPING, not live — the #129 shape", () => {
  // lease-projection failed twice in ten minutes and then succeeded. A recency
  // check alone read `live` throughout while two projections were being lost.
  const s = classifyLane(obs({ recent: runs("success", "failure", "failure") }), T, 2 * HOUR);
  assert.equal(s.state, "flapping");
  assert.ok(isRed(s), "recovering is not the same as healthy");
  assert.match(describeLane("lease-projection.yml", s), /flakiness/i);
});

test("a single transient failure is NOT flapping — the monitor's credibility is finite", () => {
  // broker-drift is the standing lesson: a monitor that is always red is one
  // nobody reads on the day it goes red for real.
  const s = classifyLane(obs({ recent: runs("success", "success", "success", "failure") }), T, 2 * HOUR);
  assert.equal(s.state, "live");
  assert.ok(!isRed(s));
});

test("failures from a FIXED defect age out — the window is time, not run count", () => {
  // Found against real data, 2026-08-04: lease-projection sat at exactly 5
  // failures in its last 10 runs, but those were the #112 broker-allowlist era
  // plus the #129 push race, both already fixed. A run-count window would have
  // kept reporting a repaired lane as half-broken for days, which is exactly
  // how broker-drift became a monitor nobody read.
  const old = 5 * HOUR * 1000;
  const s = classifyLane(
    obs({
      recent: [
        { conclusion: "success", atMs: T - 60_000 },
        { conclusion: "success", atMs: T - 120_000 },
        { conclusion: "success", atMs: T - 180_000 },
        // The fixed era, outside a 2h tolerance window.
        { conclusion: "failure", atMs: T - old },
        { conclusion: "failure", atMs: T - old - 60_000 },
        { conclusion: "failure", atMs: T - old - 120_000 },
        { conclusion: "failure", atMs: T - old - 180_000 },
      ],
    }),
    T,
    2 * HOUR,
  );
  assert.equal(s.state, "live", "a lane that stopped failing must stop being reported as failing");
});

test("a rare lane is judged on recency alone — one failure of one run is not 100% broken", () => {
  // A weekly lane may have a single run inside its window. A rate computed over
  // it is noise wearing a percentage.
  const s = classifyLane(obs({ recent: runs("failure") , lastSuccessMs: T - 60_000 }), T, 2 * HOUR);
  assert.equal(s.state, "live");
});

test("cancelled and skipped runs are not failures", () => {
  // mirror-sync-delta cancels in-progress runs by design to coalesce webhook
  // bursts; counting those as failures would make correct behaviour look broken.
  const s = classifyLane(obs({ recent: runs("success", "cancelled", "cancelled", "skipped") }), T, 2 * HOUR);
  assert.equal(s.state, "live");
});

test("unobservable is not red — an oracle that cannot see is not reporting bad news", () => {
  // The same asymmetry #113 applies to referent probes. Failing the lane on an
  // Actions API hiccup trains the reader to ignore it.
  const s = classifyLane(obs({ unknown: "Actions API HTTP 502" }), T, 2 * HOUR);
  assert.equal(s.state, "unknown");
  assert.ok(!isRed(s), "an API hiccup must not spend the monitor's credibility");
  assert.match(describeLane("x.yml", s), /502/, "but it does say what happened");
});

test("a clock-skewed future timestamp reads as age 0, not as a negative age", () => {
  const s = classifyLane(obs({ lastSuccessMs: T + 30_000 }), T, 2 * HOUR);
  assert.equal(s.state, "live");
  assert.equal((s as { ageSec: number }).ageSec, 0);
});

// ── enumeration ─────────────────────────────────────────────────────────────

test("lanes are enumerated from the workflow files, and the scan agrees with them", () => {
  // #124's done-when: a hand-maintained list is the next thing to go stale. The
  // scan is narrow (regex, not YAML), so this is where a form it cannot read
  // fails loudly instead of a lane silently dropping out of the watch.
  const lanes = readLanes();
  const byFile = new Map(lanes.map((l) => [l.file, l]));

  // Spot-check the shapes present in this repo, including the two the scan
  // could plausibly get wrong.
  assert.ok(byFile.has("reap-leases.yml"), "a plain scheduled lane");
  assert.ok(byFile.has("mirror-sync-delta.yml"), "a webhook-driven lane with a cron backstop");
  assert.equal(byFile.get("mirror-sync-delta.yml")?.webhookDriven, true);
  assert.equal(byFile.get("reap-leases.yml")?.webhookDriven, false);

  // Nothing without a schedule is watched — claim-ticket is dispatch-only and
  // has no liveness expectation at all.
  assert.ok(!byFile.has("claim-ticket.yml"), "dispatch-only workflows are not lanes");

  // Every cron found must be parseable into a period, or the watch would carry
  // a lane it cannot judge.
  for (const lane of lanes) {
    for (const cron of lane.crons) {
      assert.doesNotThrow(() => expectedPeriodSec(cron), `unparseable cron in ${lane.file}: ${cron}`);
    }
  }

  assert.ok(lanes.length >= 8, `expected this repo's scheduled lanes, found ${lanes.length}`);
});

test("the watchdog watches itself in the enumeration, and says that it cannot in the output", () => {
  // The residual hole. It is accepted rather than solved — closing it needs an
  // observer outside Actions — but #124 requires it be written where the reader
  // hits it, not silently inherited.
  const runner = readLanes().map((l) => l.file);
  assert.ok(runner.includes("lane-watch.yml"), "the watchdog is itself a scheduled lane and is enumerated");
});
