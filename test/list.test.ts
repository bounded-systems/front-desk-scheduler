import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RawItem, RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { listVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";

function raw(over: Partial<RawItem> & { item_id: string; number: number }): RawItem {
  return {
    item_id: over.item_id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "prx",
    status: over.status ?? "Todo",
    kind: over.kind ?? "task",
    effort: over.effort ?? 1,
    value: over.value ?? 1,
    depends_on: over.depends_on ?? "",
    age_days: over.age_days ?? 0,
  };
}

function mockReads(items: RawItem[], edges: RawTypedEdge[]): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => [] as SchedulingItem[],
    readTypedEdges: async () => edges,
    readAllItems: async () => items,
    meta: async () => ({ syncedAt: "2026-07-26T00:00:00Z", commit: "abc", source: "server" }),
  };
}

test("list verb: includes Done items (unlike graph)", async () => {
  const items = [
    raw({ item_id: "a", number: 1, status: "Todo" }),
    raw({ item_id: "b", number: 2, status: "Done" }),
  ];
  const out = await listVerb.run({ repo: "prx" }, { reads: mockReads(items, []) });
  assert.deepEqual(out.items.map((i) => `${i.number}:${i.status}`).sort(), ["1:Todo", "2:Done"]);
});

test("list verb: keeps edges to Done items (both endpoints in the full set)", async () => {
  const items = [
    raw({ item_id: "a", number: 1, status: "Todo" }),
    raw({ item_id: "b", number: 2, status: "Done" }),
  ];
  const edges: RawTypedEdge[] = [{ item_id: "a", dep_item_id: "b", edge_type: "parent-child" }];
  const out = await listVerb.run({ repo: "prx" }, { reads: mockReads(items, edges) });
  assert.equal(out.edges.length, 1);
  assert.deepEqual(out.edges[0], {
    from: { number: 1, repository: "prx" },
    to: { number: 2, repository: "prx" },
    kind: "parent-child",
  });
});

test("list verb: --repo scopes items and edges", async () => {
  const items = [
    raw({ item_id: "a", number: 1, repository: "prx" }),
    raw({ item_id: "z", number: 9, repository: "other" }),
  ];
  const out = await listVerb.run({ repo: "prx" }, { reads: mockReads(items, []) });
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0]!.repository, "prx");
});

test("list verb: dependsOn parsed from the depends_on column", async () => {
  const items = [raw({ item_id: "a", number: 1, depends_on: "2,3" })];
  const out = await listVerb.run({ repo: "prx" }, { reads: mockReads(items, []) });
  assert.deepEqual(out.items[0]!.dependsOn, [2, 3]);
});
