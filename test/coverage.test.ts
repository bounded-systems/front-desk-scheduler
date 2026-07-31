// Tests for the coverage declaration (#86 item 2).
//
// The bug this closes is not a wrong number — `ready: N` is correct for what the
// board can see. It is that the number reads as complete when it isn't, and a
// caller has no way to tell. So the properties worth pinning are about the
// NOTICE being present and actionable, not about the count.

import { test } from "node:test";
import assert from "node:assert/strict";

import { COVERAGE_GAPS, type CoverageGap, renderCoverage } from "../src/coverage.ts";

test("infra is declared out of scope, with where its ranking lives", () => {
  const infra = COVERAGE_GAPS.find((g) => g.repo === "infra");
  assert.ok(infra, "infra must be declared — it is private and invisible to the board");
  assert.match(infra.reason, /private/);
  assert.match(infra.ranking, /infra#101/);
});

test("every gap names a ranking, or the notice is a dead end", () => {
  // A notice that says "this is not covered" without saying where to look is
  // worse than none: it tells a caller they are missing something and then
  // strands them.
  for (const g of COVERAGE_GAPS) {
    assert.ok(g.repo.trim(), "a gap must name a repo");
    assert.ok(g.reason.trim(), `${g.repo} must say WHY it is out of scope`);
    assert.ok(g.ranking.trim(), `${g.repo} must say where its ranking lives`);
  }
});

test("the infra entry warns that the tracking issue's body goes stale", () => {
  // Learned the hard way: #101's body listed a discharged item as open, and the
  // live state was in its fourth comment.
  const infra = COVERAGE_GAPS.find((g) => g.repo === "infra");
  assert.match(infra!.ranking, /latest comment supersedes/i);
});

// ── Rendering ────────────────────────────────────────────────────────────────

test("the notice says the count is bounded by visibility, not by reality", () => {
  const out = renderCoverage().join("\n");
  assert.match(out, /only what Front Desk can see/);
  assert.match(out, /infra/);
  assert.match(out, /infra#101/);
});

test("a board that covers everything renders nothing", () => {
  // No standing noise once the gap closes — the notice has to be able to go away,
  // or it becomes furniture callers stop reading.
  assert.deepEqual(renderCoverage([]), []);
});

test("multiple gaps each get their own line", () => {
  const gaps: CoverageGap[] = [
    { repo: "a", reason: "r1", ranking: "a#1" },
    { repo: "b", reason: "r2", ranking: "b#2" },
  ];
  const out = renderCoverage(gaps);
  assert.equal(out.length, 3); // header + one per gap
  assert.match(out[1], /^ {2}a — r1/);
  assert.match(out[2], /^ {2}b — r2/);
});
