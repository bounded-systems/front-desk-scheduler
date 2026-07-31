import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assembleGraph, type RawTypedEdge, type SchedulingItem } from "../src/scheduling.ts";
import { graphVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";

function item(over: Partial<SchedulingItem> & { id: string; number: number }): SchedulingItem {
  return {
    id: over.id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "prx",
    status: over.status ?? "Todo",
    kind: (over.kind ?? "task") as SchedulingItem["kind"],
    effort: over.effort ?? 1,
    value: over.value ?? 1,
    dependsOn: over.dependsOn ?? [],
    needs: over.needs ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: over.ageDays ?? 0,
    leased: over.leased ?? false,
  };
}

// ── assembleGraph (pure) ──────────────────────────────────────────────────────

test("assembleGraph: a 'blocks' edge to an open dep is an open blocker", () => {
  const items = [
    item({ id: "a", number: 1 }),
    item({ id: "b", number: 2 }),
  ];
  const edges: RawTypedEdge[] = [{ item_id: "a", dep_item_id: "b", edge_type: "blocks" }];
  const g = assembleGraph(items, edges);
  assert.deepEqual(g.blockedBy.get("a"), [{ number: 2, repository: "prx" }]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.edges[0], { from: { number: 1, repository: "prx" }, to: { number: 2, repository: "prx" }, kind: "blocks" });
});

test("assembleGraph: a dep OUTSIDE the non-Done set (Done) is dropped — no blocker, no edge", () => {
  const items = [item({ id: "a", number: 1 })]; // b is Done ⇒ absent from the set
  const edges: RawTypedEdge[] = [{ item_id: "a", dep_item_id: "b", edge_type: "blocks" }];
  const g = assembleGraph(items, edges);
  assert.equal(g.blockedBy.has("a"), false);
  assert.equal(g.edges.length, 0);
});

test("assembleGraph: 'parent-child' blocks, 'closes' does NOT", () => {
  const items = [item({ id: "a", number: 1 }), item({ id: "b", number: 2 }), item({ id: "c", number: 3 })];
  const edges: RawTypedEdge[] = [
    { item_id: "a", dep_item_id: "b", edge_type: "parent-child" },
    { item_id: "a", dep_item_id: "c", edge_type: "closes" },
  ];
  const g = assembleGraph(items, edges);
  assert.deepEqual(g.blockedBy.get("a"), [{ number: 2, repository: "prx" }]); // parent-child only
  assert.equal(g.edges.length, 2); // both edges still listed
});

// ── graph verb (mock reads) ───────────────────────────────────────────────────

function mockReads(items: SchedulingItem[], edges: RawTypedEdge[]): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => ({ items, at: "v0110csl2jph0aeeij7rhhurrbjcft6g" }),
    readTypedEdges: async () => edges,
    readAllItems: async () => ({ items: [], at: null }),
    meta: async () => ({ syncedAt: "2026-07-26T00:00:00Z", commit: "abc", source: "server" }),
  };
}

test("graph verb: classifies ready vs blocked and carries blocker IDs", async () => {
  const items = [
    item({ id: "a", number: 1, value: 5, effort: 1 }), // blocked by b
    item({ id: "b", number: 2, value: 3, effort: 1, openBlockers: 0 }), // ready
  ];
  const edges: RawTypedEdge[] = [{ item_id: "a", dep_item_id: "b", edge_type: "blocks" }];
  // reflect the blocker in the input openBlockers so prioritize marks a ineligible
  items[0].openBlockers = 1;

  const out = await graphVerb.run({ repo: "prx" }, { reads: mockReads(items, edges) });
  assert.equal(out.source, "server");
  assert.deepEqual(out.ready.map((r) => r.number), [2]);
  assert.equal(out.blocked.length, 1);
  assert.equal(out.blocked[0].number, 1);
  assert.deepEqual(out.blocked[0].blockedBy, [{ number: 2, repository: "prx" }]);
  assert.equal(out.edges.length, 1);
});

test("graph verb: --repo scopes to one repository", async () => {
  const items = [
    item({ id: "a", number: 1, repository: "prx" }),
    item({ id: "z", number: 1, repository: "other" }),
  ];
  const out = await graphVerb.run({ repo: "prx" }, { reads: mockReads(items, []) });
  assert.equal(out.ready.length + out.blocked.length >= 1, true);
  assert.equal(out.ready.every((r) => r.repository === "prx"), true);
  assert.equal(out.blocked.every((b) => b.repository === "prx"), true);
});
