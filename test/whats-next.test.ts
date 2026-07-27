import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { whatsNextVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";

function item(over: Partial<SchedulingItem> & { id: string; number: number }): SchedulingItem {
  return {
    id: over.id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "prx",
    status: over.status ?? "Todo",
    kind: over.kind ?? "task",
    effort: over.effort ?? 0,
    value: over.value ?? 0,
    dependsOn: over.dependsOn ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: over.ageDays ?? 0,
    leased: over.leased ?? false,
  };
}

function mockReads(items: SchedulingItem[]): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => items,
    readTypedEdges: async () => [] as RawTypedEdge[],
    readAllItems: async () => [],
    meta: async () => ({ syncedAt: "2026-07-27T00:00:00Z", commit: "abc", source: "server" }),
  };
}

test("whats-next: an item with no declared effort/value is flagged untriaged", async () => {
  const out = await whatsNextVerb.run(
    {},
    { reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  const byNumber = new Map(out.queue.map((q) => [q.number, q.untriaged]));
  assert.equal(byNumber.get(1), true, "0/0 item ranks on the fallback → untriaged");
  assert.equal(byNumber.get(2), false, "declared item is triaged");
  assert.equal(out.untriagedCount, 1);
});

test("whats-next: untriagedCount counts the whole ready set, not just the shown page", async () => {
  const items = Array.from({ length: 5 }, (_, i) => item({ id: `i${i}`, number: i + 1 }));
  const out = await whatsNextVerb.run({ top: 2 }, { reads: mockReads(items) });
  assert.equal(out.queue.length, 2, "page is capped by --top");
  assert.equal(out.untriagedCount, 5, "count spans all eligible items");
});

test("whats-next: render marks untriaged rows and prints the summary line", async () => {
  const out = await whatsNextVerb.run(
    {},
    { reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  const text = whatsNextVerb.render(out);
  assert.match(text, /1\/2 ready items are untriaged/);
  assert.match(text, /ISSUE_TEMPLATE/, "points at where to declare the fields");
});

test("whats-next: fully declared queue renders no untriaged warning", async () => {
  const out = await whatsNextVerb.run(
    {},
    { reads: mockReads([item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  assert.equal(out.untriagedCount, 0);
  const text = whatsNextVerb.render(out);
  assert.doesNotMatch(text, /untriaged/);
});
