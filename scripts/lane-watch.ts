#!/usr/bin/env node
/**
 * lane-watch — assert every scheduled lane in this repo has run recently (#124).
 *
 *     GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/lane-watch.ts [--gate]
 *
 * Enumerates lanes from the workflow FILES rather than a hand-maintained list,
 * because a hand-maintained list of lanes to watch is the next thing to
 * silently go stale — which is the defect this whole lane exists to remove.
 *
 * Reads the Actions API for each lane's last successful run and its recent run
 * conclusions, classifies both signals in src/lane-watch.ts, and prints one
 * line per lane naming which lane and what to do about it.
 *
 * `--gate` makes a red finding fail the process. Without it the run reports and
 * exits 0, which is what a PR should do: the drift is a property of the
 * DEPLOYED lanes, and a PR neither causes nor can fix it — the same split
 * schema-drift.yml draws for status-drift.
 */

import {
  classifyLane,
  describeLane,
  expectedPeriodSec,
  isRed,
  FAILURE_SAMPLE,
  type LaneObservation,
  type LaneRun,
  type LaneState,
  readLanes,
  toleranceSec,
} from "../src/lane-watch.ts";

const GITHUB = "https://api.github.com";
const GATE = process.argv.includes("--gate");

async function gh(path: string): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  const tok = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!tok) return { ok: false, why: "no GitHub token for the Actions API (needs `actions: read`)" };
  let res: Response;
  try {
    res = await fetch(`${GITHUB}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tok}`,
        "user-agent": "front-desk-lane-watch",
      },
    });
  } catch (e) {
    return { ok: false, why: `Actions API unreachable: ${String((e as Error).message ?? e)}` };
  }
  if (res.status === 404) {
    // Ambiguous the same way the reaper's PR probes are: no such workflow, or a
    // token that cannot see it. Neither is evidence about the lane.
    return { ok: false, why: "not visible to this token (404) — needs `actions: read`" };
  }
  if (!res.ok) return { ok: false, why: `Actions API HTTP ${res.status}` };
  return { ok: true, body: await res.json() };
}

async function observe(repo: string, file: string): Promise<LaneObservation> {
  const success = await gh(`/repos/${repo}/actions/workflows/${file}/runs?status=success&per_page=1`);
  if (!success.ok) return { lastSuccessMs: null, recent: [], unknown: success.why };

  const sruns = (success.body as { workflow_runs?: { updated_at?: string }[] }).workflow_runs ?? [];
  let lastSuccessMs: number | null = null;
  if (sruns.length > 0) {
    const stamp = sruns[0]?.updated_at;
    if (!stamp) return { lastSuccessMs: null, recent: [], unknown: "successful run carried no timestamp" };
    lastSuccessMs = Date.parse(stamp);
  }

  // The second signal (#129): a lane can be succeeding NOW and still be broken.
  // `run_started_at` rather than `updated_at` so the window reflects when the
  // run HAPPENED, not when it was last touched.
  const recentRes = await gh(`/repos/${repo}/actions/workflows/${file}/runs?per_page=${FAILURE_SAMPLE}`);
  if (!recentRes.ok) return { lastSuccessMs, recent: [], unknown: recentRes.why };
  const raw = (recentRes.body as {
    workflow_runs?: { conclusion?: string | null; run_started_at?: string; created_at?: string }[];
  }).workflow_runs ?? [];
  const recent: LaneRun[] = raw
    // An in-flight run is not yet evidence either way.
    .filter((r) => r.conclusion)
    .map((r) => ({
      conclusion: r.conclusion as string,
      atMs: Date.parse(r.run_started_at ?? r.created_at ?? ""),
    }));

  return { lastSuccessMs, recent };
}

async function main(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY?.trim();
  if (!repo) {
    console.error("lane-watch: GITHUB_REPOSITORY is unset — there is nothing to enumerate lanes against.");
    process.exit(2);
  }

  const lanes = readLanes();
  if (lanes.length === 0) {
    // Zero lanes is not a healthy silence: this repo has ten, so an empty scan
    // means the enumeration broke, and reporting green would be the exact
    // failure being designed against.
    console.error("lane-watch: found NO scheduled lanes — the enumeration is broken, not the repo empty.");
    process.exit(1);
  }

  const now = Date.now();
  const results: { file: string; state: LaneState }[] = [];

  for (const lane of lanes) {
    // Several schedules on one workflow: the SHORTEST period is the promise the
    // lane makes, so hold it to that.
    const periods = lane.crons.map(expectedPeriodSec).filter((p): p is number => p !== null);
    if (periods.length === 0) {
      results.push({
        file: lane.file,
        state: { state: "unknown", why: `no cron in ${JSON.stringify(lane.crons)} fires twice within the simulation window — period unknown` },
      });
      continue;
    }
    const tolerance = toleranceSec(Math.min(...periods));
    results.push({ file: lane.file, state: classifyLane(await observe(repo, lane.file), now, tolerance) });
  }

  for (const r of results) console.log(describeLane(r.file, r.state));

  const red = results.filter((r) => isRed(r.state));
  const unknown = results.filter((r) => r.state.state === "unknown");
  console.log(
    `\nlane-watch: ${results.length} scheduled lane(s), ${red.length} red, ${unknown.length} unobservable.`,
  );
  // The residual hole, printed where the reader is already looking rather than
  // only in a module doc nobody opens (#124).
  console.log(
    "lane-watch does NOT watch itself — if this lane stops running, nothing here notices.\n" +
      "  That is the one hole left after taking ~10 to 1; closing it needs an observer outside Actions.",
  );

  if (red.length > 0 && GATE) {
    console.error(`::error::${red.length} scheduled lane(s) are not healthy — see the per-lane lines above.`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`lane-watch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
