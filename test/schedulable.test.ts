/**
 * The schedulable set (#89): GitHub-closed items never reach the policy, and
 * the two completion authorities are reconciled toward `closed_at`.
 *
 * The clause lives in SQL (the set also drives dependency satisfaction, so
 * membership must be decided before assembly), which makes it invisible to a
 * behavioural test over assembled items — a closed row simply never arrives.
 * So this file asserts three things at the layers where each is real:
 *
 *   1. every scheduling query carries BOTH exclusions (the string is the
 *      artifact, same species as leases.test.ts's FROM-clause asserts);
 *   2. assembleScheduling treats out-of-set deps as satisfied — the property
 *      that makes SQL-level exclusion the correct layer;
 *   3. the drift query sees both directions of disagreement and only
 *      github-origin rows (dolt-origin planning items have no issue to
 *      disagree with).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { asBlockingEdges, assembleScheduling, SQL } from "../src/scheduling.ts";
import type { RawItem, RawTypedEdge } from "../src/scheduling.ts";

test("every scheduling query excludes card-Done AND GitHub-closed (#89)", () => {
  for (const q of [SQL.items, SQL.itemsLegacy] as const) {
    assert.match(q, /status <> 'Done'/, "card-Done exclusion");
    assert.match(q, /closed_at IS NULL/, "GitHub-closed exclusion (#89 — the card cannot resurrect a closed item)");
  }
});

test("the ready rule itself is NOT restated in SQL (#59)", () => {
  // The set may be defined in SQL; the ready rule may not. If either of these
  // ever appears, someone has moved `isEligible` into the data plane.
  for (const q of [SQL.items, SQL.itemsLegacy] as const) {
    assert.doesNotMatch(q, /blocker/i, "openBlockers is derived in assembly, never in SQL");
    assert.doesNotMatch(q, /in_progress|In Progress/, "liveness mapping stays in statusToState");
  }
});

test("a dep outside the schedulable set is satisfied, not blocking", () => {
  // Two rows arrive (the set), one dep points at an item that did NOT arrive —
  // exactly what a GitHub-closed (or Done) dependency now looks like. It must
  // count as complete: zero open blockers for the dependent.
  const raw = (over: Partial<RawItem> & { item_id: string }): RawItem => ({
    number: 1,
    title: "t",
    repository: "r",
    status: "Todo",
    kind: "task",
    effort: 1,
    value: 1,
    depends_on: "",
    age_days: 0,
    ...over,
  });
  const items = [raw({ item_id: "a", number: 1 }), raw({ item_id: "b", number: 2 })];
  const edges: RawTypedEdge[] = [
    { item_id: "a", dep_item_id: "closed-and-absent", edge_type: "blocks" }, // satisfied — outside the set
    { item_id: "a", dep_item_id: "b", edge_type: "blocks" }, // open — inside the set
  ];
  const [a] = assembleScheduling(items, edges, []);
  assert.equal(a.openBlockers, 1, "only the in-set dep blocks; the absent (closed) one is satisfied");
});

const mk = (item_id: string, number: number): RawItem => ({
  item_id,
  number,
  title: "t",
  repository: "r",
  status: "Todo",
  kind: "task",
  effort: 1,
  value: 1,
  depends_on: "",
  age_days: 0,
});

// ── edge kinds in the RANKING path (#156 — the #155 fix, applied to next/claim) ─
//
// `closes` is mined PR→issue provenance. Counting it as a blocker manufactures
// blockers for exactly the items with an open closing PR — the ones in active
// delivery — so prx#972 sat un-rankable while its card (fixed by #155's
// writeback) said Todo. Both directions are pinned, same as the writeback
// tests: provenance never gates, and the filter is BY KIND, not a blanket drop.

test("a closes edge neither blocks nor credits unblocks — provenance, not a gate", () => {
  const items = [mk("pr", 1), mk("issue", 2)];
  const edges: RawTypedEdge[] = [{ item_id: "issue", dep_item_id: "pr", edge_type: "closes" }];
  const [pr, issue] = assembleScheduling(items, edges, []);
  assert.equal(issue.openBlockers, 0, "an open closing PR means in-delivery, not blocked (prx#972)");
  assert.equal(pr.unblocks, 0, "merging a PR unblocks nothing — crediting it inflates the score");
});

test("blocks and parent-child still gate — a kind filter, not a blanket exclusion", () => {
  const items = [mk("dep", 1), mk("blocked", 2), mk("child", 3)];
  const edges: RawTypedEdge[] = [
    { item_id: "blocked", dep_item_id: "dep", edge_type: "blocks" },
    { item_id: "child", dep_item_id: "dep", edge_type: "parent-child" },
  ];
  const [dep, blocked, child] = assembleScheduling(items, edges, []);
  assert.equal(blocked.openBlockers, 1);
  assert.equal(child.openBlockers, 1, "epic children still gate on the parent");
  assert.equal(dep.unblocks, 2, "both gating kinds credit the dependency");
});

test("asBlockingEdges: pre-edge_type historical rows gate, as they did then", () => {
  // A read pinned before 2026-07-26 has untyped item_deps rows; every edge of
  // that era was a declared dependency, so the shim must preserve the old
  // behaviour — not silently drop history's blockers through the kind filter.
  const items = [mk("a", 1), mk("b", 2)];
  const [a] = assembleScheduling(items, asBlockingEdges([{ item_id: "a", dep_item_id: "b" }]), []);
  assert.equal(a.openBlockers, 1, "legacy untyped edge still blocks");
});

test("the drift query detects both directions, github-origin only", () => {
  assert.match(SQL.statusDrift, /closed_at IS NOT NULL AND status <> 'Done'/, "dead work wearing a live card (#55's shape)");
  assert.match(SQL.statusDrift, /closed_at IS NULL AND status = 'Done'/, "card claims completion GitHub has not recorded");
  assert.match(SQL.statusDrift, /origin = 'github'/, "dolt-origin rows have no GitHub issue to disagree with");
});

test("every numeric field survives a read plane that returns strings (#101)", () => {
  // The DoltHub HTTP plane returns every column as a JSON string ("931", "2");
  // `dolt sql -r json` on a local clone returns real numbers. Assembly is the
  // seam where the two planes are made to agree, and `number` was the one field
  // that had no `Number()` — so it reached the MCP output schema, which DOES
  // validate, as a string:
  //
  //   MCP error -32602: Output validation error: Invalid structured content for
  //   tool next: expected number, received string at queue[0].number
  //
  // `next`, `graph` and `list` all failed over MCP on the default read plane
  // while `node scripts/fds.ts next` printed a correct queue, because the CLI
  // validates nothing. That gap is why this asserts on TYPES, not just values —
  // `assert.equal("931", 931)` would have passed throughout the outage.
  const stringy = {
    item_id: "a",
    number: "931",
    title: "t",
    repository: "r",
    status: "Todo",
    kind: "task",
    effort: "2",
    value: "65",
    depends_on: "",
    age_days: "7",
  } as unknown as RawItem;

  const [a] = assembleScheduling([stringy], [], []);
  for (const [field, want] of [["number", 931], ["effort", 2], ["value", 65], ["ageDays", 7]] as const) {
    assert.equal(typeof a[field], "number", `${field} must be coerced, not passed through as a string`);
    assert.equal(a[field], want);
  }
});

test("a row with no issue number still assembles (#101 must not break the null case)", () => {
  const noNumber = {
    item_id: "a",
    number: null,
    title: "t",
    repository: "r",
    status: "Todo",
    kind: "task",
    effort: 1,
    value: 1,
    depends_on: "",
    age_days: null,
  } as unknown as RawItem;

  const [a] = assembleScheduling([noNumber], [], []);
  assert.equal(a.number, 0, "a dolt-origin row with no GitHub issue is 0, not NaN");
  assert.equal(a.ageDays, 0);
});
