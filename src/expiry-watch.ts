/**
 * @module expiry-watch
 * The observer for the observable #105 built (#113).
 *
 * #105's stated payoff was never the reaper itself:
 *
 *   > Once TTL is a backstop, an expiry becomes a monitorable anomaly — it
 *   > means the GC is down.
 *
 * The distinguishability shipped — `historyStep` records `reaped` apart from
 * `expired`, and `specs/lean/Leases.lean` proves the two are different
 * transitions — and then nothing looked at it. This module is the looking.
 *
 * WHY IT READS THE DOs AND NOT `claims`
 * -------------------------------------
 * The obvious source is the projection: one cheap unauthenticated query
 * against the mirror. It cannot answer the question, for two reasons that are
 * facts about the code rather than preferences:
 *
 *   1. `claims` HAS NO REFERENT. The alarm is not "a lease expired" — it is "a
 *      BOUND lease expired", because a referent-less lapse on the short claim
 *      ttl is ordinary (a session died before opening a PR) while a bound
 *      lease reaching its backstop means the reaper never arrived. The
 *      discriminator is the referent, `projectionUpsertSql` does not project
 *      it, and the only claims-side proxy is `ttl_sec` — a convention of
 *      bind-ticket.yml's default, not an invariant anything enforces.
 *
 *   2. THE PROJECTION FREEZES LIVE INTERVALS. `WATERMARK_SQL` takes
 *      MAX(fencing) over all projected rows including `status='active'`, and
 *      the projector then reads strictly above it — so an interval projected
 *      mid-life is never re-read and its close never lands. A bound lease
 *      sitting live for 24h spans up to four projection runs, which makes the
 *      exact case this module exists to catch the case most likely to be
 *      frozen at 'active' and never reported as expired at all.
 *
 * Both are #119, and neither blocks this. Reading `/history` also keeps the
 * ONE-DEFINITION discipline (#59) that a claims-side monitor would have to
 * break: catching a lapsed-but-unclosed interval from SQL means restating
 * `effectiveStatus` as `claimed_at + INTERVAL ttl_sec SECOND <
 * UTC_TIMESTAMP()`, whereas the DO computes `effective_status` on read and
 * hands over the answer.
 *
 * WHAT THIS CAN AND CANNOT SEE
 * ----------------------------
 * A `DurableObjectNamespace` cannot be enumerated (#84), so candidates come
 * from the mirror — and deliberately through `candidateIds` in src/reaper.ts,
 * the reaper's own union, imported rather than restated. That makes this
 * module's blind spot IDENTICAL to the reaper's by construction: a lease the
 * sweep could never have collected is not one this monitor pretends to have
 * checked. It is a statable property instead of an accident.
 *
 * The two windows must compose, and test/expiry-watch.test.ts checks it
 * against the SQL rather than trusting this sentence: the alarm window has to
 * stay inside the recently-closed candidate window, or the monitor would be
 * hunting for expiries on items it has already stopped enumerating.
 */

import { CANDIDATE_CLOSED_WINDOW_DAYS } from "./reaper.ts";
import type { LeaseHistoryRecord, LeaseReferent } from "./lease-client.ts";

/** How far back an expiry still counts as news.
 *
 *  Windowed on purpose. An all-time query would keep this lane red forever
 *  after a single incident, and broker-drift.yml is the standing lesson on
 *  what that costs: a monitor that is always red is one nobody reads, exactly
 *  when its job is to be believed on the day it goes red for real. Seven days
 *  is long enough that a fix has to actually hold and short enough that the
 *  lane returns to green on its own.
 *
 *  MUST stay <= CANDIDATE_CLOSED_WINDOW_DAYS — see the module header. */
export const ALARM_WINDOW_DAYS = 7;

/** How long reap-leases may be silent before that alone is the alarm.
 *
 *  The reaper runs twice an hour (`13,43 * * * *`), so three hours is six
 *  missed sweeps — comfortably past a flake, well short of a backstop.
 *
 *  This is the LEADING indicator and the reason it is worth more than the
 *  expiry count: a dead GC shows up here within hours, whereas the first
 *  `expired` row confirming it is 24h of backstop away. An expiry is the
 *  lagging confirmation, not the primary signal. */
export const REAPER_SILENCE_LIMIT_SEC = 3 * 3600;

/** When a grant interval actually ended.
 *
 *  A record closed by a later claim carries `releasedAt` = its factual expiry
 *  (lease-core.mjs closes the lapsed grant AT its recorded expiry, not at the
 *  moment someone next showed up). A record that lapsed and has been untouched
 *  since is still stored `active` with `releasedAt: null` and only READS as
 *  expired, so its expiry is the close. Same value either way — which is why
 *  the projection uses the same fallback. */
export function closedAt(r: LeaseHistoryRecord): number {
  return r.releasedAt ?? r.expiresAt;
}

/** Was this grant pinned to a referent when it ended?
 *
 *  `referent` is optional on the record because a worker predating #105 never
 *  wrote the field. Absent and null are the SAME FACT — no referent ever
 *  materialized — which is lease-core.mjs's own reading in `currentReferent`,
 *  followed here rather than re-decided. It is also right on the merits: a
 *  grant from before /bind existed could not have been bound. */
export function boundReferent(r: LeaseHistoryRecord): LeaseReferent | null {
  return r.referent ?? null;
}

export type ExpiryVerdict =
  | { readonly expired: false; readonly why: "not-expired" | "outside-window" }
  | { readonly expired: true; readonly kind: "ordinary"; readonly closedAt: number }
  | {
    readonly expired: true;
    readonly kind: "alarming";
    readonly closedAt: number;
    readonly referent: LeaseReferent;
  };

/**
 * Classify one grant interval. The whole judgment of this module is here, pure
 * and testable without a network.
 *
 * `effective_status` rather than `status`: the DO computes expiry as-of-read,
 * so a lease that lapsed and was never touched again reads as expired without
 * any write having happened. That is the case a monitor most needs to see —
 * nobody came back to close it precisely because nobody came back.
 *
 * The referent split is the ordinary/alarming line and nothing else is:
 *
 *   referent-less  the lease never got a PR. The short claim ttl lapsing is
 *                  the DESIGNED outcome for a session that died before
 *                  pushing (#105) — reap-leases would have skipped it as
 *                  `no-referent`, so its expiry implicates nobody.
 *   bound          a referent existed, the reaper's whole job was to observe
 *                  it, and the 24h backstop fired instead. That is the "GC is
 *                  down" alarm, and Leases.lean's `stale_reap_noop`,
 *                  `referentless_never_reaped` and `fencing_monotone` are why
 *                  it can be read that way: a WRONG reap cannot manufacture a
 *                  spurious expiry, so the row really does implicate the
 *                  collector rather than a race.
 */
export function classifyExpiry(
  r: LeaseHistoryRecord,
  now: number,
  windowMs: number,
): ExpiryVerdict {
  if (r.effective_status !== "expired") {
    return { expired: false, why: "not-expired" };
  }
  const at = closedAt(r);
  if (!Number.isFinite(at) || now - at > windowMs) {
    return { expired: false, why: "outside-window" };
  }
  const referent = boundReferent(r);
  if (referent === null) {
    return { expired: true, kind: "ordinary", closedAt: at };
  }
  return { expired: true, kind: "alarming", closedAt: at, referent };
}

/** Is the collector this monitor watches actually running?
 *
 *  `unknown` is deliberately NOT red. It is the same asymmetry the reaper
 *  applies to its referent probes: an oracle that cannot see is not an oracle
 *  reporting bad news, and failing the lane on an Actions API hiccup would
 *  train the reader to ignore it. It does not read as healthy either — the
 *  runner warns, and the ledger records which of the two it was. */
export type ReaperLiveness =
  | { readonly state: "live"; readonly ageSec: number }
  | { readonly state: "silent"; readonly ageSec: number }
  | { readonly state: "never" }
  | { readonly state: "unknown"; readonly why: string };

export function classifyReaperLiveness(
  lastSuccessMs: number | null,
  now: number,
  limitSec: number = REAPER_SILENCE_LIMIT_SEC,
): ReaperLiveness {
  if (lastSuccessMs === null) return { state: "never" };
  if (!Number.isFinite(lastSuccessMs)) {
    return { state: "unknown", why: "unparseable run timestamp" };
  }
  // Clamp at zero: a run stamped slightly in the future is clock skew between
  // GitHub and this runner, not a negative age worth reporting.
  const ageSec = Math.max(0, Math.floor((now - lastSuccessMs) / 1000));
  return ageSec > limitSec
    ? { state: "silent", ageSec }
    : { state: "live", ageSec };
}

export interface AlarmDetail {
  readonly itemId: string;
  readonly fencing: number;
  readonly agent: string;
  readonly referent: LeaseReferent;
  readonly closedAt: number;
  readonly ttlSec: number;
}

/** The watch's honesty ledger — every candidate lands in exactly one bucket,
 *  so "nothing expired" is a claim the numbers back or refute. Same shape and
 *  same reason as SweepReport in src/reaper.ts. */
export interface WatchReport {
  candidates: number;
  polled: number;
  intervals: number;
  expired: { ordinary: number; alarming: number; outsideWindow: number };
  alarms: AlarmDetail[];
  /** /history transport failures — the watch is INCOMPLETE if > 0. */
  failures: number;
  reaper: ReaperLiveness;
  windowDays: number;
}

export function emptyWatchReport(): WatchReport {
  return {
    candidates: 0,
    polled: 0,
    intervals: 0,
    expired: { ordinary: 0, alarming: 0, outsideWindow: 0 },
    alarms: [],
    failures: 0,
    reaper: { state: "unknown", why: "not checked" },
    windowDays: ALARM_WINDOW_DAYS,
  };
}

/**
 * Does this run go red, and for which of the three independent reasons?
 *
 * They are kept separate rather than summed because they call for different
 * fixes, and a monitor whose red does not say which fix is a monitor that
 * sends its reader hunting — the failure broker-drift.yml's output was
 * restructured to avoid.
 *
 * An INCOMPLETE watch is red on the reaper's own reasoning: reporting a clean
 * pass over candidates that could not be read is a green made of nothing. It
 * costs no correctness to be loud here — nothing is being collected, only
 * observed.
 */
export function watchVerdict(
  report: WatchReport,
): { readonly red: boolean; readonly reasons: string[] } {
  const reasons: string[] = [];
  if (report.expired.alarming > 0) {
    reasons.push(
      `${report.expired.alarming} BOUND lease(s) reached the backstop in the last ${report.windowDays}d — ` +
        "the reaper did not get there. This is the 'GC is down' alarm (#105/#113).",
    );
  }
  if (report.reaper.state === "silent") {
    reasons.push(
      `reap-leases has not had a successful run in ${report.reaper.ageSec}s ` +
        `(limit ${REAPER_SILENCE_LIMIT_SEC}s) — the collector is down NOW, ahead of any backstop firing.`,
    );
  }
  if (report.reaper.state === "never") {
    reasons.push(
      "reap-leases has never had a successful run — the collector has never worked (cf. #112).",
    );
  }
  if (report.failures > 0) {
    reasons.push(
      `${report.failures} candidate(s) could not be read — this watch is INCOMPLETE and is not reporting a pass.`,
    );
  }
  return { red: reasons.length > 0, reasons };
}

/** The alarm window must stay inside the window that still enumerates closed
 *  items, or this monitor would look for expiries on items it no longer asks
 *  about. Exported so the test can assert it against the reaper's SQL instead
 *  of against a comment. */
export function windowsCompose(
  alarmDays: number = ALARM_WINDOW_DAYS,
  candidateDays: number = CANDIDATE_CLOSED_WINDOW_DAYS,
): boolean {
  return alarmDays <= candidateDays;
}
