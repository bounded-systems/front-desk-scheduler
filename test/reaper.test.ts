/**
 * The reaper's decisions (#105), driven without a network.
 *
 * What is pinned here is the ASYMMETRY: collecting a lease requires a positive
 * observation — the referent merged, closed, or provably gone — and everything
 * the probe cannot pin down releases nothing. The two objections the design
 * had to survive (a referent that never materialized; an oracle that is down)
 * are each a test, not a paragraph.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { candidateIds, CANDIDATE_SQL, parsePrReferent, planReap, verdictFromPrProbe } from "../src/reaper.ts";
import type { LeaseStatus } from "../src/lease-client.ts";

const base: LeaseStatus = {
  holder: "gha/session-7",
  fencing: 3,
  expiresAt: 1_800_000_000_000,
  live: true,
  referent: { kind: "pr", id: "bounded-systems/front-desk-scheduler#103" },
};

test("a live pr-bound lease is probed with the fencing+referent from the same snapshot", () => {
  const plan = planReap(base);
  assert.equal(plan.action, "probe-pr");
  if (plan.action !== "probe-pr") return;
  assert.deepEqual(plan.pr, { owner: "bounded-systems", repo: "front-desk-scheduler", number: 103 });
  assert.equal(plan.fencing, 3, "the fencing presented to /reap is the one /status reported");
  assert.deepEqual(plan.referent, base.referent);
});

test("a free lease and a referent-less lease are both skips — the second is the backstop's corpse", () => {
  assert.deepEqual(planReap({ ...base, live: false }), { action: "skip", reason: "not-live" });
  // #105 objection 1: the session died before anything materialized. There is
  // nothing to collect, and the SHORT claim TTL is what bounds this lease.
  assert.deepEqual(planReap({ ...base, referent: null }), { action: "skip", reason: "no-referent" });
});

test("an unrecognised kind is skipped and NAMED — never treated as immortal, never guessed at", () => {
  const plan = planReap({ ...base, referent: { kind: "guest-room", id: "room-42" } });
  assert.deepEqual(plan, { action: "skip", reason: "unrecognized-kind", kind: "guest-room" });
});

test("a malformed pr id is a named skip, not a probe of garbage", () => {
  const plan = planReap({ ...base, referent: { kind: "pr", id: "not-a-pr-ref" } });
  assert.deepEqual(plan, { action: "skip", reason: "malformed-referent", id: "not-a-pr-ref" });
});

test("parsePrReferent accepts owner/repo#number and nothing else", () => {
  assert.deepEqual(parsePrReferent("bounded-systems/infra#7"), {
    owner: "bounded-systems", repo: "infra", number: 7,
  });
  for (const bad of ["", "infra#7", "a/b", "a/b#0", "a/b#-1", "a/b#1.5", "a/b/c#1", "a/b#1x", "#1"]) {
    assert.equal(parsePrReferent(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test("merged and closed PRs collect, and the verdict says which", () => {
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 200, state: "closed", merged: true }),
    { collect: true, why: "merged" });
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 200, state: "closed", merged: false }),
    { collect: true, why: "closed" });
});

test("an open PR is alive — the lease stays held however long the work takes", () => {
  // The too-short half of the TTL's failure: a 3600s lease on a three-hour task
  // lapsed mid-flight. Pinned to the PR, the lease lives as long as the work.
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 200, state: "open" }),
    { collect: false, why: "alive" });
});

test("a 404 collects ONLY when the repo answers — GitHub 404s 'missing' and 'not yours' identically", () => {
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 404, repoHttpStatus: 200 }),
    { collect: true, why: "gone" });
  // #105 objection 2: unobservable is not closed. A token that cannot see the
  // repo must not free the lease of a holder whose PR is doing fine.
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 404, repoHttpStatus: 404 }),
    { collect: false, why: "unobservable" });
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 404 }),
    { collect: false, why: "unobservable" });
});

test("every other oracle failure is unobservable and releases nothing", () => {
  for (const status of [401, 403, 429, 500, 502]) {
    assert.deepEqual(verdictFromPrProbe({ prHttpStatus: status }),
      { collect: false, why: "unobservable" }, `HTTP ${status} must not collect`);
  }
  // A 200 whose body did not carry a recognisable state is equally unusable.
  assert.deepEqual(verdictFromPrProbe({ prHttpStatus: 200 }), { collect: false, why: "unobservable" });
});

test("the candidate union is one definition, deduped — the expiry monitor (#113) shares it", () => {
  // Extracted from the runner so the monitor enumerates the SAME set: its blind
  // spot is then this sweep's blind spot by construction, not by coincidence.
  const answers: Record<string, { item_id: string }[]> = {
    [CANDIDATE_SQL.schedulable]: [{ item_id: "A" }, { item_id: "B" }],
    [CANDIDATE_SQL.recentlyClosed]: [{ item_id: "B" }, { item_id: "C" }],
    [CANDIDATE_SQL.projectedActive]: [{ item_id: "C" }, { item_id: "D" }],
  };
  return candidateIds((sql) => Promise.resolve(answers[sql] ?? [])).then((ids) => {
    assert.deepEqual([...ids].sort(), ["A", "B", "C", "D"], "the union over-approximates but never repeats");
  });
});

test("a mirror with no claims table degrades to empty — but only for THAT named absence", async () => {
  const missing = (sql: string) =>
    sql === CANDIDATE_SQL.projectedActive
      ? Promise.reject(new Error("table not found: claims"))
      : Promise.resolve([{ item_id: "A" }]);
  assert.deepEqual(await candidateIds(missing), ["A"]);

  // Any other failure must propagate: silently shrinking the candidate set is
  // how a sweep reports a clean pass over items it never looked at.
  const broken = (sql: string) =>
    sql === CANDIDATE_SQL.projectedActive
      ? Promise.reject(new Error("DoltHub HTTP 503"))
      : Promise.resolve([{ item_id: "A" }]);
  await assert.rejects(() => candidateIds(broken), /503/);
});
