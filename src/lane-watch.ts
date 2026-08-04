/**
 * @module lane-watch
 * The watchdog for scheduled lanes (#124).
 *
 * `lease-projection` ran 24 times and failed 24 times before anyone noticed
 * (#112). `broker-drift` was permanently red for a different reason and became
 * unread. The shape is not "a workflow broke" — it is that **a red or absent
 * scheduled lane is indistinguishable from a healthy one unless somebody opens
 * the Actions tab**.
 *
 * #113 built the right mechanism for exactly one lane: `lease-expiry-watch`
 * checks that `reap-leases` has succeeded recently. It could not close #112's
 * checkbox because **a workflow cannot detect its own non-execution** — every
 * scheduled lane has that hole, including the monitor. This module generalises
 * the mechanism to every lane, which reduces N holes to one: the watchdog's own.
 * There is no way to reach zero from inside GitHub Actions, and pretending
 * otherwise would be the unearned guarantee this project keeps finding.
 *
 * THE RESIDUAL HOLE, STATED WHERE THE NEXT READER HITS IT
 * -------------------------------------------------------
 * If `lane-watch.yml` itself stops running, nothing here notices. That is the
 * one remaining instance of the defect this module exists to remove, and it is
 * accepted rather than solved. Closing it needs an observer OUTSIDE Actions —
 * a Worker cron hitting the Actions API, say — and that is a different piece of
 * infrastructure with its own liveness question. The honest position is: this
 * takes ~10 holes to 1, and the 1 is written down.
 *
 * TWO SIGNALS, BECAUSE ONE IS NOT ENOUGH
 * ---------------------------------------
 * Recency of last success is the primary contract, and is what #113 already
 * does. It is not sufficient: on 2026-08-03 `lease-projection` failed twice in
 * ten minutes (#129, a push race) and then SUCCEEDED, so a recency-only check
 * would have read `live` throughout while two projections were being lost and
 * silently re-projected later. Intermittent-red-then-green is the nastier
 * variant of #112 — the Actions tab makes it look like flakiness rather than a
 * defect.
 *
 * So a lane is also judged on its recent FAILURE RATE. The threshold is a
 * majority rather than "any failure", deliberately: `broker-drift` is the
 * standing lesson that a monitor which is always red is one nobody reads, and a
 * single transient runner failure must not spend that credibility. A majority
 * of recent runs failing is not flakiness — #112 was 24/24 and #129 was 2 of 3.
 */

import { readdirSync, readFileSync } from "node:fs";

/** A scheduled lane, as read from its workflow file. */
export interface Lane {
  /** Workflow file name, e.g. "reap-leases.yml" — the Actions API's key. */
  readonly file: string;
  /** Every cron on the workflow. Multiple entries mean multiple schedules. */
  readonly crons: readonly string[];
  /** True when the lane also runs on repository_dispatch — its cron is then a
   *  BACKSTOP rather than a description of how often it actually runs. */
  readonly webhookDriven: boolean;
}

/** Where the lanes live. */
export const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url);

/**
 * Read the lanes off disk — the ONE definition of "what is a lane", so the
 * watchdog and the test that checks it cannot disagree (#124: a hand-maintained
 * list of lanes to watch is the next thing to silently go stale).
 *
 * Deliberately a narrow scan rather than a YAML parse: the only questions are
 * "does this file have a schedule" and "does it also take a repository_dispatch",
 * both answerable from the text, and a watchdog does not need a YAML dependency.
 * The test asserts this agrees with the actual files, so a form the scan cannot
 * read fails loudly there instead of a lane quietly dropping out of the watch.
 */
export function readLanes(dir: URL = WORKFLOW_DIR): Lane[] {
  const lanes: Lane[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    const body = readFileSync(new URL(entry.name, dir), "utf8");
    const crons = [...body.matchAll(/^\s*-?\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    if (crons.length === 0) continue;
    lanes.push({
      file: entry.name,
      crons,
      webhookDriven: /^\s+repository_dispatch:/m.test(body),
    });
  }
  return lanes.sort((a, b) => a.file.localeCompare(b.file));
}

// ── cron ────────────────────────────────────────────────────────────────────

/** Expand one cron field into the set of values it matches. Supports the forms
 *  this repo actually uses: `*`, `a`, `a,b`, `a-b`, `*\/n`, `a-b/n`. An
 *  unsupported form throws rather than silently matching everything — a
 *  watchdog that quietly widens its own tolerance is the failure it watches
 *  for. */
export function expandField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step <= 0) {
      throw new RangeError(`unsupported cron step in ${JSON.stringify(field)}`);
    }
    let lo: number, hi: number;
    if (range === "*") {
      lo = min; hi = max;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      // Exactly two, or `1-2-3` silently becomes `1-2` and the tolerance
      // widens without anyone saying so — the failure this watchdog watches for,
      // committed by the watchdog. Caught by its own test.
      if (bounds.length !== 2) {
        throw new RangeError(`unsupported cron range in ${JSON.stringify(field)}`);
      }
      const [a, b] = bounds.map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new RangeError(`unsupported cron range in ${JSON.stringify(field)}`);
      }
      lo = a; hi = b;
    } else {
      const v = Number(range);
      if (!Number.isInteger(v)) {
        throw new RangeError(`unsupported cron value in ${JSON.stringify(field)}`);
      }
      // A bare value with a step (`5/15`) means "from 5 to the max, every 15".
      lo = v; hi = stepRaw === undefined ? v : max;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new RangeError(`cron field ${JSON.stringify(field)} out of range [${min},${max}]`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

interface CronSets {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(cron: string): CronSets {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) throw new RangeError(`expected 5 cron fields, got ${f.length} in ${JSON.stringify(cron)}`);
  return {
    minute: expandField(f[0], 0, 59),
    hour: expandField(f[1], 0, 23),
    dom: expandField(f[2], 1, 31),
    month: expandField(f[3], 1, 12),
    dow: expandField(f[4], 0, 6),
    domRestricted: f[2] !== "*",
    dowRestricted: f[4] !== "*",
  };
}

function fires(c: CronSets, d: Date): boolean {
  if (!c.minute.has(d.getUTCMinutes())) return false;
  if (!c.hour.has(d.getUTCHours())) return false;
  if (!c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  // POSIX: when BOTH day fields are restricted they are OR'd, not AND'd.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/** Simulation window. 40 days so a weekly cron yields several gaps; anything
 *  rarer than that reports its window as the period, which is stated rather
 *  than silently wrong — see `expectedPeriodSec`. */
const SIM_DAYS = 40;
const SIM_FROM_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/**
 * The longest gap between consecutive fires, in seconds — the lane's period as
 * its schedule actually behaves rather than as its first field reads. Derived
 * by simulation because `13,43 * * * *` is every 30 minutes, not hourly, and no
 * amount of staring at the minute field says so.
 *
 * Returns null when the cron fires 0 or 1 times in the window: the period is
 * longer than the simulation can see, and a caller must not treat that as a
 * short one.
 */
export function expectedPeriodSec(cron: string): number | null {
  const c = parseCron(cron);
  let prev: number | null = null;
  let maxGap = 0;
  let count = 0;
  const end = SIM_FROM_MS + SIM_DAYS * 86400_000;
  for (let t = SIM_FROM_MS; t < end; t += 60_000) {
    if (!fires(c, new Date(t))) continue;
    count++;
    if (prev !== null) maxGap = Math.max(maxGap, t - prev);
    prev = t;
  }
  if (count < 2) return null;
  return Math.floor(maxGap / 1000);
}

// ── tolerance ───────────────────────────────────────────────────────────────

/** Multiplier on the period before a lane counts as silent.
 *
 *  NOT derived from the cron, per #124: GitHub delays scheduled runs, and real
 *  gaps between consecutive `reap-leases` successes have reached 83 minutes on
 *  a twice-hourly schedule — 2.8x. Anything at or below 3x would have cried
 *  wolf on a healthy lane. */
export const PERIOD_MULTIPLIER = 4;

/** Floor added on top, so a frequent lane is not held to an unrealistically
 *  tight deadline: a 30-minute lane tolerates 2h+1h rather than exactly 2h. */
export const TOLERANCE_FLOOR_SEC = 3600;

/** Cap, so a rare lane's silence is still noticed within a working day of its
 *  own period rather than four weeks later. */
export const TOLERANCE_CAP_SEC = 10 * 86400;

/**
 * How long a lane may go without a successful run before it is silent.
 *
 * A webhook-driven lane gets the same treatment on purpose. Its cron is a
 * BACKSTOP — `mirror-sync-delta`'s observed inter-run gaps on 2026-08-03 ranged
 * from ~90 seconds to over an hour depending on board activity — so the cron is
 * the only lower bound on frequency that holds when the board is quiet, and
 * that is exactly the bound a watchdog wants. Deriving tolerance from observed
 * webhook rate would make a quiet weekend look like an outage.
 */
export function toleranceSec(periodSec: number): number {
  return Math.min(TOLERANCE_CAP_SEC, periodSec * PERIOD_MULTIPLIER + TOLERANCE_FLOOR_SEC);
}

// ── classification ──────────────────────────────────────────────────────────

/** How many recent runs to FETCH. The window that decides is time-based (see
 *  below); this only bounds the page size. */
export const FAILURE_SAMPLE = 20;

/** Fraction of in-window runs that must have failed before a lane is judged
 *  broken rather than flaky. A majority: #112 was 24/24 and #129 was 2 of 3,
 *  while a single transient runner failure must not spend the monitor's
 *  credibility. */
export const FAILURE_RATE_LIMIT = 0.5;

/** Below this many in-window runs, the failure RATE is not meaningful — one
 *  failure out of one run is 100% and means nothing. A rare lane is judged on
 *  recency alone, which is the signal it can actually support. */
export const MIN_FAILURE_SAMPLE = 3;

export interface LaneRun {
  readonly conclusion: string;
  /** When the run started. The failure signal is windowed on this. */
  readonly atMs: number;
}

export interface LaneObservation {
  /** Epoch ms of the last SUCCESSFUL run; null when there has never been one. */
  readonly lastSuccessMs: number | null;
  /** The most recent runs, newest first, whatever they concluded. */
  readonly recent: readonly LaneRun[];
  /** Set when the lane could not be observed at all. */
  readonly unknown?: string;
}

export type LaneState =
  /** Succeeded within tolerance and not failing at a rate that suggests breakage. */
  | { readonly state: "live"; readonly ageSec: number }
  /** Succeeding, but a majority of recent runs failed — the #129 shape. */
  | { readonly state: "flapping"; readonly ageSec: number; readonly failed: number; readonly of: number }
  /** No successful run within tolerance. */
  | { readonly state: "silent"; readonly ageSec: number; readonly toleranceSec: number }
  /** Never succeeded — the #112 shape, and the one a recency check alone reads
   *  as merely "old". */
  | { readonly state: "never"; readonly failed: number; readonly of: number }
  /** Could not be observed. Deliberately NOT red — same asymmetry #113 applies
   *  to referent probes: an oracle that cannot see is not an oracle reporting
   *  bad news, and failing the lane on an Actions API hiccup would train the
   *  reader to ignore it. */
  | { readonly state: "unknown"; readonly why: string };

export function classifyLane(obs: LaneObservation, now: number, tolerance: number): LaneState {
  if (obs.unknown !== undefined) return { state: "unknown", why: obs.unknown };

  // The failure signal is windowed on TIME, not on run count, and the window is
  // the tolerance — the span within which a healthy lane should have run
  // several times.
  //
  // Counting the last N runs regardless of age mixes eras: on 2026-08-04
  // `lease-projection` sat at exactly 5 failures in its last 10 runs, but those
  // were the #112 broker-allowlist era plus the #129 push race, BOTH FIXED. A
  // run-count window would have kept reporting a repaired lane as half-broken
  // for days, which is precisely how `broker-drift` became a monitor nobody
  // read. A time window forgets a fixed defect at the rate it stops happening.
  const windowStart = now - tolerance * 1000;
  const inWindow = obs.recent.filter((r) => Number.isFinite(r.atMs) && r.atMs >= windowStart);
  const countable = inWindow.filter(
    // A cancelled run is not a failure: mirror-sync-delta cancels in-progress
    // runs BY DESIGN to coalesce webhook bursts.
    (r) => r.conclusion !== "skipped" && r.conclusion !== "cancelled",
  );
  const of = countable.length;
  const failed = countable.filter((r) => r.conclusion !== "success").length;

  if (obs.lastSuccessMs === null) {
    // `never` counts over ALL fetched runs rather than the window: a lane that
    // has never succeeded has no era to forget, and 24-of-24 is the fact worth
    // printing (#112).
    const allCountable = obs.recent.filter(
      (r) => r.conclusion !== "skipped" && r.conclusion !== "cancelled",
    );
    // NO RUNS AT ALL is not the #112 shape and must not be red. #112 was 24
    // attempts and 24 failures; zero attempts is no evidence of anything. A
    // lane merged an hour ago has not failed — it has not been tried, and the
    // first thing this watchdog did on its own first run was accuse itself.
    // Caught by running it, not by a test (#124's own lesson, applied to it).
    if (allCountable.length === 0) {
      return { state: "unknown", why: "no completed runs yet — newly added, or its first run is still in flight" };
    }
    return {
      state: "never",
      failed: allCountable.filter((r) => r.conclusion !== "success").length,
      of: allCountable.length,
    };
  }
  if (!Number.isFinite(obs.lastSuccessMs)) {
    return { state: "unknown", why: "unparseable run timestamp" };
  }
  // Clamp at zero: a run stamped slightly ahead is clock skew, not a negative age.
  const ageSec = Math.max(0, Math.floor((now - obs.lastSuccessMs) / 1000));
  if (ageSec > tolerance) return { state: "silent", ageSec, toleranceSec: tolerance };
  if (of >= MIN_FAILURE_SAMPLE && failed / of > FAILURE_RATE_LIMIT) {
    return { state: "flapping", ageSec, failed, of };
  }
  return { state: "live", ageSec };
}

/** Does this state fail the watchdog?
 *
 *  `unknown` does not, per the asymmetry above. `flapping` DOES: a lane whose
 *  majority of runs fail is broken even though it keeps recovering, and #129 is
 *  the case in point — two lost projections that a recency check called live. */
export function isRed(s: LaneState): boolean {
  return s.state === "silent" || s.state === "never" || s.state === "flapping";
}

/** One line per lane, naming WHICH lane and WHAT to do — `broker-drift`'s
 *  discriminating-output posture (#124). A red that does not say which lane
 *  sends its reader hunting through ten workflow files. */
export function describeLane(file: string, s: LaneState): string {
  switch (s.state) {
    case "live":
      return `ok       ${file} — last success ${s.ageSec}s ago`;
    case "flapping":
      return `FLAPPING ${file} — ${s.failed}/${s.of} runs in the tolerance window failed, though it last succeeded ${s.ageSec}s ago. It is recovering, which is why the Actions tab reads as flakiness; open the failed runs (#129 was a push race that looked exactly like this).`;
    case "silent":
      return `SILENT   ${file} — no successful run in ${s.ageSec}s (tolerance ${s.toleranceSec}s). Either the schedule stopped firing or every run is failing; open the lane's run list.`;
    case "never":
      return `NEVER    ${file} — has never had a successful run (${s.failed}/${s.of} recent runs failed). This is the #112 shape: check the first failure, not the latest.`;
    case "unknown":
      return `unknown  ${file} — could not observe: ${s.why}`;
  }
}
