#!/usr/bin/env node
/**
 * expiry-watch — the observer for #105's observable (#113).
 *
 *     FDS_CLAIM_ENDPOINT=https://… GH_TOKEN=… node scripts/expiry-watch.ts
 *
 * Asks the two questions that together mean "the lease GC is doing its job":
 *
 *   1. Did any BOUND lease close as `expired` in the alarm window? A bound
 *      lease reaching its 24h backstop means the reaper never observed its
 *      referent. (A referent-less lapse is ordinary and is counted, not
 *      alarmed — reap-leases would have skipped it as `no-referent`.)
 *   2. Is reap-leases actually running? This is the LEADING half: a dead
 *      collector shows up here within hours, while the first `expired` row
 *      confirming it is a backstop away.
 *
 * Every judgment is in src/expiry-watch.ts, pure and tested. This file is
 * transport: DoltHub for candidates, the Worker's open /history for grant
 * intervals, the Actions API for the collector's liveness.
 *
 * WHY /history AND NOT `claims` — the design decision #113 asked to be made
 * deliberately, argued in full in src/expiry-watch.ts. Short form: the
 * projection drops the referent, so `claims` cannot tell the ordinary expiry
 * from the alarming one at all; and its watermark freezes intervals projected
 * mid-life, which is exactly the shape of the 24h-bound lease this watch
 * exists to catch. Both are #119.
 *
 * REFUSES to run without FDS_CLAIM_ENDPOINT (exit 2), the same posture as
 * project-leases and reap-leases: a monitor reporting a quiet plane that was
 * never configured is a green made of nothing.
 *
 * The verdict is one greppable line, mirroring the other lanes:
 *
 *     FDS-EXPIRY-RESULT {"candidates":251,"expired":{"alarming":0,...},...}
 *
 * WHAT IT STILL CANNOT DO — stated because done-when #3 of #113 asks for
 * honesty about its own liveness and this is the honest edge: a workflow
 * cannot detect its own non-execution. This watch checks that ITS SUBJECT is
 * alive; nothing here notices if this lane itself stops being scheduled. That
 * residue is #112's deferred checkbox — the general "every scheduled lane has
 * run recently" watchdog — and it is one lane's worth of hole rather than the
 * whole class.
 */

import { query } from "../src/dolthub.ts";
import { fetchLeaseHistory } from "../src/lease-client.ts";
import { candidateIds } from "../src/reaper.ts";
import {
  ALARM_WINDOW_DAYS,
  type AlarmDetail,
  classifyExpiry,
  classifyReaperLiveness,
  emptyWatchReport,
  REAPER_SILENCE_LIMIT_SEC,
  watchVerdict,
} from "../src/expiry-watch.ts";

if (!process.env.FDS_CLAIM_ENDPOINT?.trim()) {
  console.error(
    "expiry-watch: FDS_CLAIM_ENDPOINT is unset — there is no lease plane to watch.\n" +
      "  Refusing rather than reporting a quiet system; the caller decides whether\n" +
      "  'no plane deployed' is a skip (the workflow does) or a failure.",
  );
  process.exit(2);
}

const GITHUB = "https://api.github.com";
const WINDOW_MS = ALARM_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Alarms are rare by construction; cap the JSON line and SAY so when it bites,
 *  rather than letting a truncated list read as the whole story. */
const ALARMS_IN_LEDGER = 20;

/** When did reap-leases last SUCCEED? null = never; undefined = we could not
 *  find out, which is a different fact and is reported as such. */
async function reaperLastSuccessMs(): Promise<
  { ms: number | null } | { unknown: string }
> {
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!repo) return { unknown: "GITHUB_REPOSITORY is unset" };
  const tok = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!tok) {
    return {
      unknown: "no GitHub token for the Actions API (needs actions: read)",
    };
  }

  const url =
    `${GITHUB}/repos/${repo}/actions/workflows/reap-leases.yml/runs?status=success&per_page=1`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tok}`,
        "user-agent": "front-desk-expiry-watch",
      },
    });
  } catch (e) {
    return {
      unknown: `Actions API unreachable: ${String((e as Error).message ?? e)}`,
    };
  }
  if (res.status === 404) {
    // Ambiguous the same way the reaper's PR probes are: no such workflow, or
    // a token that cannot see it. Neither is evidence about the collector.
    return {
      unknown:
        "reap-leases.yml not visible to this token (404) — needs `actions: read`",
    };
  }
  if (!res.ok) return { unknown: `Actions API HTTP ${res.status}` };

  const body = (await res.json()) as {
    workflow_runs?: { updated_at?: string }[];
  };
  const runs = body.workflow_runs ?? [];
  if (runs.length === 0) return { ms: null };
  const stamp = runs[0]?.updated_at;
  if (!stamp) return { unknown: "successful run carried no timestamp" };
  const ms = Date.parse(stamp);
  return Number.isFinite(ms)
    ? { ms }
    : { unknown: `unparseable run timestamp ${JSON.stringify(stamp)}` };
}

async function main(): Promise<void> {
  const report = emptyWatchReport();
  const now = Date.now();

  // The collector's liveness first: it is the leading indicator, and it is
  // still worth reporting even if the history sweep below falls over.
  const last = await reaperLastSuccessMs();
  report.reaper = "unknown" in last
    ? { state: "unknown", why: last.unknown }
    : classifyReaperLiveness(last.ms, now, REAPER_SILENCE_LIMIT_SEC);

  const ids = await candidateIds((sql) => query<{ item_id: string }>(sql));
  report.candidates = ids.length;

  const CONCURRENCY = 8;
  for (let at = 0; at < ids.length; at += CONCURRENCY) {
    const batch = ids.slice(at, at + CONCURRENCY);
    const settled = await Promise.allSettled(
      // sinceFencing 0: every interval, not a watermark. This watch has no
      // cursor to keep — the time window is the bound, and a history that is
      // one record per grant is small.
      batch.map(async (itemId) => ({
        itemId,
        history: await fetchLeaseHistory(itemId, 0),
      })),
    );

    for (const [i, r] of settled.entries()) {
      report.polled++;
      if (r.status === "rejected") {
        // One unreadable candidate must not silently shrink the watch.
        report.failures++;
        console.error(`expiry-watch: ${batch[i]}: ${String(r.reason)}`);
        continue;
      }
      const { itemId, history } = r.value;
      for (const rec of history.records) {
        report.intervals++;
        const verdict = classifyExpiry(rec, now, WINDOW_MS);
        if (!verdict.expired) {
          if (verdict.why === "outside-window") report.expired.outsideWindow++;
          continue;
        }
        if (verdict.kind === "ordinary") {
          report.expired.ordinary++;
          continue;
        }
        report.expired.alarming++;
        const detail: AlarmDetail = {
          itemId,
          fencing: rec.fencing,
          agent: rec.agent,
          referent: verdict.referent,
          closedAt: verdict.closedAt,
          ttlSec: rec.ttlSec,
        };
        report.alarms.push(detail);
        console.error(
          `expiry-watch: ALARM ${itemId} fencing ${detail.fencing}: a lease BOUND to ` +
            `${detail.referent.kind}:${detail.referent.id} (held by ${detail.agent}) reached its ` +
            `${detail.ttlSec}s backstop at ${
              new Date(detail.closedAt).toISOString()
            } instead of being ` +
            "reaped — the collector did not observe that referent.",
        );
      }
    }
  }

  if (report.alarms.length > ALARMS_IN_LEDGER) {
    console.error(
      `expiry-watch: ${report.alarms.length} alarms; the ledger line carries the first ` +
        `${ALARMS_IN_LEDGER}. The full list is in the lines above — the count is not truncated.`,
    );
  }
  console.log(
    `FDS-EXPIRY-RESULT ${
      JSON.stringify({
        ...report,
        alarms: report.alarms.slice(0, ALARMS_IN_LEDGER),
      })
    }`,
  );

  const { red, reasons } = watchVerdict(report);
  if (report.reaper.state === "unknown") {
    // Not red: an oracle that cannot see is not an oracle reporting bad news
    // (the reaper's own asymmetry). Not silent either.
    console.error(
      `expiry-watch: could not determine reap-leases liveness — ${report.reaper.why}`,
    );
  }
  if (red) {
    for (const why of reasons) console.error(`expiry-watch: ${why}`);
    process.exit(1);
  }
  console.log(
    `expiry-watch: no bound lease reached its backstop in the last ${ALARM_WINDOW_DAYS}d ` +
      `(${report.expired.ordinary} ordinary referent-less lapse(s), which are not anomalies), ` +
      `and reap-leases is ${report.reaper.state}.`,
  );
}

main().catch((e: unknown) => {
  console.error(`expiry-watch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
