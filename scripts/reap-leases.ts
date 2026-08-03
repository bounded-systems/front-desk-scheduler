#!/usr/bin/env node
/**
 * reap-leases — the lease garbage collector (#105).
 *
 *     FDS_CLAIM_ENDPOINT=https://… GH_TOKEN=… node scripts/reap-leases.ts
 *
 * One sweep: enumerate candidate items from the public mirror (no credential),
 * read each candidate's /status (open read, DO ground truth), and for a live
 * lease bound to a `pr` referent, probe the PR. Merged, closed, or provably
 * gone → POST /reap with the fencing + referent from that same /status
 * snapshot; the DO refuses the pair if the world moved in between.
 *
 * Every decision is in src/reaper.ts, pure and tested. This file is transport:
 * DoltHub for candidates, the Worker for status/reap, the GitHub API for
 * probes. GH_TOKEN authenticates both the reap write (auth.mjs — a workflow's
 * github.token is an accepted identity) and the PR probes.
 *
 * REFUSES to run without FDS_CLAIM_ENDPOINT (exit 2), same posture as
 * project-leases: a reaper that reports a clean sweep of a plane that was
 * never configured is a green made of nothing.
 *
 * The verdict is one greppable line, mirroring the ticket windows:
 *
 *     FDS-REAP-RESULT {"candidates":312,"live":2,"reaped":1,...}
 *
 * A sweep with transport failures exits 1 AFTER applying what it could — the
 * missed candidates are still live in their DOs, the next sweep re-reads them,
 * and the backstop TTL bounds what a broken reaper can cost. That bound is the
 * whole reason expiry still exists.
 */

import { fetchLeaseStatus, reapLeaseRemote } from "../src/lease-client.ts";
import { query } from "../src/dolthub.ts";
import {
  CANDIDATE_SQL,
  emptyReport,
  planReap,
  type PrProbe,
  type PrRef,
  verdictFromPrProbe,
} from "../src/reaper.ts";

if (!process.env.FDS_CLAIM_ENDPOINT?.trim()) {
  console.error(
    "reap-leases: FDS_CLAIM_ENDPOINT is unset — there is no lease plane to collect from.\n" +
      "  Refusing rather than reporting an empty sweep; the caller decides whether\n" +
      "  'no plane deployed' is a skip (the workflow does) or a failure.",
  );
  process.exit(2);
}

const GITHUB = "https://api.github.com";

async function probePr(pr: PrRef): Promise<PrProbe> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "front-desk-reaper",
  };
  const tok = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (tok) headers.authorization = `Bearer ${tok}`;

  const prRes = await fetch(`${GITHUB}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { headers });
  if (prRes.status === 200) {
    const body = (await prRes.json()) as { state?: string; merged?: boolean };
    return {
      prHttpStatus: 200,
      state: body.state === "closed" ? "closed" : body.state === "open" ? "open" : undefined,
      merged: body.merged === true,
    };
  }
  if (prRes.status === 404) {
    // GitHub 404s both "no such PR" and "repo not visible to this token"; only
    // a visible repo makes the PR's absence a fact about the PR (src/reaper.ts).
    const repoRes = await fetch(`${GITHUB}/repos/${pr.owner}/${pr.repo}`, { headers });
    return { prHttpStatus: 404, repoHttpStatus: repoRes.status };
  }
  return { prHttpStatus: prRes.status };
}

async function candidates(): Promise<string[]> {
  const [schedulable, recentlyClosed, projectedActive] = await Promise.all([
    query<{ item_id: string }>(CANDIDATE_SQL.schedulable),
    query<{ item_id: string }>(CANDIDATE_SQL.recentlyClosed),
    // A mirror that predates the claims table (or a wiped scratch mirror) has
    // no active grants to reveal, which is different from the query failing for
    // an unknown reason — only the named absence degrades to empty.
    query<{ item_id: string }>(CANDIDATE_SQL.projectedActive).catch((e: unknown) =>
      /table not found: claims/i.test(String(e)) ? [] : Promise.reject(e)
    ),
  ]);
  return [...new Set([...schedulable, ...recentlyClosed, ...projectedActive].map((r) => r.item_id))];
}

async function main(): Promise<void> {
  const report = emptyReport();
  const ids = await candidates();
  report.candidates = ids.length;

  const CONCURRENCY = 8;
  for (let at = 0; at < ids.length; at += CONCURRENCY) {
    const batch = ids.slice(at, at + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (itemId) => {
        const status = await fetchLeaseStatus(itemId);
        const plan = planReap(status);
        if (plan.action === "skip") return { itemId, plan } as const;
        const verdict = verdictFromPrProbe(await probePr(plan.pr));
        if (!verdict.collect) return { itemId, plan, verdict } as const;
        const outcome = await reapLeaseRemote(itemId, plan.fencing, plan.referent);
        return { itemId, plan, verdict, outcome } as const;
      }),
    );

    for (const [i, r] of settled.entries()) {
      report.polled++;
      if (r.status === "rejected") {
        // One unreadable candidate must not silently shrink the sweep — count
        // it, name it, fail the run at the end (the project-leases posture).
        report.failures++;
        console.error(`reap-leases: ${batch[i]}: ${String(r.reason)}`);
        continue;
      }
      const { itemId, plan } = r.value;
      if (plan.action === "skip") {
        if (plan.reason !== "not-live") report.live++;
        switch (plan.reason) {
          case "not-live":
            report.skipped.notLive++;
            break;
          case "no-referent":
            report.skipped.noReferent++;
            break;
          case "unrecognized-kind":
            report.skipped.unrecognizedKind++;
            console.error(
              `reap-leases: ${itemId}: lease bound to unrecognised referent kind '${plan.kind}' — ` +
                "skipped, NOT immortal; the backstop TTL still bounds it",
            );
            break;
          case "malformed-referent":
            report.skipped.malformedReferent++;
            console.error(`reap-leases: ${itemId}: malformed pr referent id '${plan.id}' — skipped`);
            break;
        }
        continue;
      }
      report.live++;
      const { verdict, outcome } = r.value;
      if (!verdict!.collect) {
        if (verdict!.why === "alive") report.skipped.alive++;
        else {
          report.skipped.unobservable++;
          console.error(
            `reap-leases: ${itemId}: referent ${plan.referent.kind}:${plan.referent.id} is ` +
              "UNOBSERVABLE — not released (unobservable is not closed; #105 objection 2)",
          );
        }
        continue;
      }
      if (outcome!.reaped) {
        report.reaped++;
        console.log(
          `reap-leases: ${itemId}: reaped (referent ${plan.referent.id} ${verdict!.why}; ` +
            `held by ${outcome!.holder ?? "?"})`,
        );
      } else {
        // The DO refused: the evidence went stale between /status and /reap.
        // A skip, never a retry — the next sweep re-reads fresh truth.
        report.refused++;
        console.error(`reap-leases: ${itemId}: reap refused (${outcome!.reason}) — evidence stale, skipping`);
      }
    }
  }

  console.log(`FDS-REAP-RESULT ${JSON.stringify(report)}`);
  if (report.failures > 0) {
    console.error(
      `reap-leases: ${report.failures} candidate(s) could not be read — the sweep is INCOMPLETE this run.\n` +
        "  Failing rather than reporting a clean pass: the missed leases are still live in\n" +
        "  their DOs, the next sweep re-reads them, and the backstop TTL bounds the cost.",
    );
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`reap-leases: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
