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

/** Records what the verb asked the read plane for — the scope and the edge pin
 *  are now part of the contract (#88), so they have to be observable. */
interface Seen {
  scope?: { repo?: string };
  edgePin?: string | null;
}

function mockReads(
  items: RawItem[],
  edges: RawTypedEdge[],
  opts: { at?: string | null; seen?: Seen } = {},
): SchedulerReads {
  const at = opts.at ?? null;
  return {
    source: "server",
    readScheduling: async () => ({ items: [] as SchedulingItem[], at: null }),
    readTypedEdges: async (pin) => {
      if (opts.seen) opts.seen.edgePin = pin ?? null;
      return edges;
    },
    // Narrows like the real plane does: in the QUERY, before returning rows.
    readAllItems: async (scope = {}) => {
      if (opts.seen) opts.seen.scope = scope;
      return {
        items: scope.repo ? items.filter((i) => i.repository === scope.repo) : items,
        at,
      };
    },
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

// ── #88: the scope must reach the QUERY, and the two reads must agree ────────

test("list verb: --repo is pushed to the read plane, not applied afterwards", async () => {
  const seen: Seen = {};
  const items = [
    raw({ item_id: "a", number: 1, repository: "prx" }),
    raw({ item_id: "z", number: 9, repository: "other" }),
  ];
  await listVerb.run({ repo: "prx" }, { reads: mockReads(items, [], { seen }) });
  // The point of #88: filtering after the read cannot lower the row count that
  // broke the read. The scope has to be an INPUT to it.
  assert.deepEqual(seen.scope, { repo: "prx" });
});

test("list verb: unscoped run asks the read plane for everything", async () => {
  const seen: Seen = {};
  const items = [
    raw({ item_id: "a", number: 1, repository: "prx" }),
    raw({ item_id: "z", number: 9, repository: "other" }),
  ];
  const out = await listVerb.run({}, { reads: mockReads(items, [], { seen }) });
  assert.deepEqual(seen.scope, { repo: undefined });
  assert.equal(out.items.length, 2);
});

test("list verb: edges are read at the same commit the items were", async () => {
  const seen: Seen = {};
  const items = [raw({ item_id: "a", number: 1 })];
  await listVerb.run({}, { reads: mockReads(items, [], { at: "deadbeef", seen }) });
  // Not just "a pin was passed" — the SAME pin. An independently resolved head
  // would let a sync land between the two reads and silently drop edges.
  assert.equal(seen.edgePin, "deadbeef");
});

test("list verb: reports the commit it derived from, like next", async () => {
  const items = [raw({ item_id: "a", number: 1 })];
  const out = await listVerb.run({}, { reads: mockReads(items, [], { at: "deadbeef" }) });
  assert.equal(out.derivedFrom, "deadbeef");
  assert.match(listVerb.render!(out), /AS OF 'deadbeef'/);
});

test("list verb: derivedFrom is null on a plane that cannot pin", async () => {
  const items = [raw({ item_id: "a", number: 1 })];
  const out = await listVerb.run({}, { reads: mockReads(items, []) });
  // Honest "cannot say" rather than a fabricated stamp — same as localDoltReads.
  assert.equal(out.derivedFrom, null);
  assert.doesNotMatch(listVerb.render!(out), /AS OF/);
});
