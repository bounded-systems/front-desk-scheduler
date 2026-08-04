import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { nextVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";
import { ROLLING_5H_BUDGET } from "../src/policy.ts";
import { readFileSync } from "node:fs";

// ── calling the verb from a test ─────────────────────────────────────────────
// `run` receives the PARSED input: Zod has already applied every default, so at
// the type level nothing is optional. A test that passes `{}` is relying on a
// parse step that never happens here. These helpers supply the same defaults
// explicitly, which is why `deno check` was red on this file — the tests worked
// at runtime and did not typecheck, so the repo's own type gate could not be
// turned on.

type NextInput = Parameters<typeof nextVerb.run>[0];
type NextOutput = Awaited<ReturnType<typeof nextVerb.run>>;

function input(over: Partial<NextInput> = {}): NextInput {
  // Mirrors NextInput's defaults in src/verbs.ts. The budget id is imported
  // rather than spelled out, so a rename cannot silently desync this from it.
  return { budget: ROLLING_5H_BUDGET.id, top: 10, consumed: 0, ...over };
}

/** `render` is optional on VerbSpec and takes (output, input) — both were wrong here. */
function render(out: NextOutput, inp: NextInput = input()): string {
  const r = nextVerb.render;
  assert.ok(r, "next must define a renderer");
  return r(out, inp);
}

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
    needs: over.needs ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: over.ageDays ?? 0,
    leased: over.leased ?? false,
  };
}

// A TEST MUST NOT REACH THE NETWORK. `next` now verifies the top N against the
// lease plane (#135), and that path is configured by `FDS_CLAIM_ENDPOINT` —
// which is set in a cloud session's environment. Without this line these tests
// probed the REAL deployed Worker for fixture ids like "a" and "b": 0.70s with
// the variable set, 0.32s without. Ambient env deciding whether a suite makes
// live requests is the same class as #101 (a green run that exercised a
// different path than the one you thought). The exclusion path is covered
// deliberately, with an injected probe, in test/held.test.ts.
delete process.env.FDS_CLAIM_ENDPOINT;

function mockReads(items: SchedulingItem[]): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => ({ items, at: "v0110csl2jph0aeeij7rhhurrbjcft6g" }),
    readTypedEdges: async () => [] as RawTypedEdge[],
    readAllItems: async () => ({ items: [], at: null }),
    meta: async () => ({ syncedAt: "2026-07-27T00:00:00Z", commit: "abc", source: "server" }),
  };
}

test("next: an item with no declared effort/value is flagged untriaged", async () => {
  const out = await nextVerb.run(
    input(),
    { reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  const byNumber = new Map(out.queue.map((q) => [q.number, q.untriaged]));
  assert.equal(byNumber.get(1), true, "0/0 item ranks on the fallback → untriaged");
  assert.equal(byNumber.get(2), false, "declared item is triaged");
  assert.equal(out.untriagedCount, 1);
});

test("next: untriagedCount counts the whole ready set, not just the shown page", async () => {
  const items = Array.from({ length: 5 }, (_, i) => item({ id: `i${i}`, number: i + 1 }));
  const out = await nextVerb.run(input({ top: 2 }), { reads: mockReads(items) });
  assert.equal(out.queue.length, 2, "page is capped by --top");
  assert.equal(out.untriagedCount, 5, "count spans all eligible items");
});

test("next: render marks untriaged rows and prints the summary line", async () => {
  const out = await nextVerb.run(
    input(),
    { reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  const text = render(out);
  assert.match(text, /1\/2 ready items are untriaged/);
  assert.match(text, /ISSUE_TEMPLATE/, "points at where to declare the fields");
});

test("next: fully declared queue renders no untriaged warning", async () => {
  const out = await nextVerb.run(
    input(),
    { reads: mockReads([item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  assert.equal(out.untriagedCount, 0);
  const text = render(out);
  assert.doesNotMatch(text, /untriaged/);
});

test("next stamps the commit the read was PINNED to, not a second lookup", () => {
  // The stamp must come from the read itself. meta() resolves the head with its
  // own query; in `next` both run concurrently in a Promise.all, so a sync
  // landing between them would make an independently-resolved stamp describe a
  // board the ranking never saw.
  const src = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
  const fn = /id: "next"[\s\S]*?^\}\);/m.exec(src)?.[0] ?? "";
  assert.match(fn, /derivedFrom: read\.at/, "the stamp must be the read's own pin");
  assert.doesNotMatch(fn, /derivedFrom: meta/, "never a second resolution of the head");
});

test("next surfaces the pin and how to reproduce from it", async () => {
  const out = await nextVerb.run(
    input(),
    { reads: mockReads([item({ id: "b", number: 2, effort: 3, value: 70 })]) },
  );
  assert.equal(out.derivedFrom, "v0110csl2jph0aeeij7rhhurrbjcft6g");
  const text = render(out);
  assert.match(text, /derived from commit v0110csl/);
  assert.match(text, /AS OF/, "tells the reader how to re-derive it");
});

test("an adapter that cannot pin reports null rather than fabricating a stamp", async () => {
  const unpinnable = { ...mockReads([item({ id: "a", number: 1 })]), readScheduling: async () => ({ items: [item({ id: "a", number: 1 })], at: null }) };
  const out = await nextVerb.run(input(), { reads: unpinnable });
  assert.equal(out.derivedFrom, null);
  assert.doesNotMatch(render(out), /derived from commit/);
});
