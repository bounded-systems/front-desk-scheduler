/**
 * Live lease exclusion for the pick and the top N (#135).
 *
 * The defect: on the lease plane `leases` is empty by design, so the `leased`
 * flag excluded nothing and held items ranked as ready. Measured on the live
 * mirror — `SELECT COUNT(*) FROM leases → 0` — and observed by accident, when a
 * session held #127 from 01:18 to 01:43 and `next` ranked it FIRST at 01:31.
 *
 * The properties worth pinning are less about "does it filter" than about the
 * two ways this could go wrong quietly:
 *
 *   1. it must FAIL OPEN, and say that it did. Hiding available work because a
 *      probe hiccuped is worse than the status quo; degrading to the old
 *      behaviour *silently* is worse than either, because the caller keeps
 *      trusting an exclusion that stopped running.
 *   2. it must stay OFF when the lease plane is not configured, and reach no
 *      network at all — the read plane's zero-credential, works-anywhere
 *      property is the thing #43 was most careful not to spend.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { nextVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";
import { ROLLING_5H_BUDGET } from "../src/policy.ts";
import { NO_EXCLUSION, renderExclusion, type StatusProbe, verifyHeld } from "../src/held.ts";

// Same reason as next.test.ts: nothing here may touch the real Worker. Every
// test below that exercises the exclusion injects its own probe.
delete process.env.FDS_CLAIM_ENDPOINT;

function item(over: Partial<SchedulingItem> & { id: string; number: number }): SchedulingItem {
  return {
    id: over.id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "front-desk-scheduler",
    status: over.status ?? "Todo",
    kind: over.kind ?? "task",
    effort: over.effort ?? 2,
    value: over.value ?? 50,
    dependsOn: [],
    needs: over.needs ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: 0,
    leased: over.leased ?? false,
  };
}

function mockReads(items: SchedulingItem[]): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => ({ items, at: "lt5lpmo3tp7pfv5an1310ll649leqret" }),
    readTypedEdges: async () => [] as RawTypedEdge[],
    readAllItems: async () => ({ items: [], at: null }),
    meta: async () => ({ syncedAt: "2026-08-04T02:17:38Z", commit: "abc", source: "server" }),
  };
}

type NextInput = Parameters<typeof nextVerb.run>[0];
const input = (over: Partial<NextInput> = {}): NextInput => ({
  budget: ROLLING_5H_BUDGET.id, top: 10, consumed: 0, ...over,
});

const free = { holder: null, live: false, referent: null };
const heldBy = (holder: string, referent: { kind: string; id: string } | null) => ({ holder, live: true, referent });

/** A probe that answers from a table and records what it was asked. */
function probeOf(table: Record<string, Awaited<ReturnType<StatusProbe>>>, seen: string[] = []): StatusProbe & { seen: string[] } {
  const fn = async (id: string) => {
    seen.push(id);
    return table[id] ?? free;
  };
  return Object.assign(fn, { seen });
}

// ── the unit ────────────────────────────────────────────────────────────────

test("an unconfigured lease plane probes nothing and claims nothing", async () => {
  const x = await verifyHeld(["a", "b"]);
  assert.equal(x.configured, false, "FDS_CLAIM_ENDPOINT is unset in this suite");
  assert.equal(x.checked, 0, "must not fan out when there is nowhere to ask");
  assert.equal(x.held.size, 0);
  assert.deepEqual(x, { ...NO_EXCLUSION, configured: false });
});

test("an injected probe IS the configuration — it does not also need the env var", async () => {
  // The signature that made this true is the one that stopped `next`'s tests
  // from probing production. Asserting it so the coupling cannot come back.
  const x = await verifyHeld(["a"], probeOf({ a: heldBy("gha/s1", null) }));
  assert.equal(x.configured, true);
  assert.equal(x.held.size, 1);
});

test("only LIVE holds are excluded — a lapsed lease is not a hold", async () => {
  // `live` is the DO's own verdict on expiry. Re-deriving it from expiresAt here
  // would be a second definition that could disagree with the adjudicator.
  const x = await verifyHeld(["a", "b"], probeOf({ a: heldBy("gha/s1", null), b: free }));
  assert.deepEqual([...x.held.keys()], ["a"]);
  assert.equal(x.checked, 2);
});

test("a failing probe FAILS OPEN and is counted, never silently dropped", async () => {
  const flaky: StatusProbe = async (id) => {
    if (id === "b") throw new Error("lease endpoint unreachable");
    return heldBy("gha/s1", null);
  };
  const x = await verifyHeld(["a", "b"], flaky);
  assert.equal(x.held.size, 1, "a is held");
  assert.equal(x.held.has("b"), false, "b stays in the queue — fail open");
  assert.equal(x.unobserved, 1, "and the failure is COUNTED, or the degradation is invisible");
});

test("one bad probe does not poison the others", async () => {
  // Promise.allSettled, not Promise.all: a single unreachable item must not
  // discard the verdicts that did come back.
  const x = await verifyHeld(
    ["a", "b", "c"],
    async (id) => {
      if (id === "a") throw new Error("boom");
      return heldBy("gha/s1", null);
    },
  );
  assert.equal(x.unobserved, 1);
  assert.deepEqual([...x.held.keys()].sort(), ["b", "c"]);
});

test("the referent rides along, so bound and referent-less are distinguishable", async () => {
  // #105/#115: a bound lease is someone working; a referent-less one is on the
  // short ttl and about to lapse. Same probe, no second round trip.
  const x = await verifyHeld(
    ["a", "b"],
    probeOf({
      a: heldBy("gha/s1", { kind: "pr", id: "bounded-systems/front-desk-scheduler#133" }),
      b: heldBy("gha/s2", null),
    }),
  );
  assert.deepEqual(x.held.get("a")?.referent, { kind: "pr", id: "bounded-systems/front-desk-scheduler#133" });
  assert.equal(x.held.get("b")?.referent, null);
});

// ── the notice ──────────────────────────────────────────────────────────────

test("the notice is SILENT when nothing is held and nothing failed", () => {
  // A line on every call becomes furniture — the failure renderCoverage avoids.
  assert.equal(renderExclusion({ checked: 10, unobserved: 0, configured: true, heldCount: 0 }), null);
  assert.equal(renderExclusion({ checked: 0, unobserved: 0, configured: false, heldCount: 0 }), null);
});

test("an unobserved probe always speaks, because the queue may be wrong", () => {
  const s = renderExclusion({ checked: 10, unobserved: 3, configured: true, heldCount: 0 });
  assert.ok(s);
  assert.match(s, /could not be checked/);
  assert.match(s, /may already be held/, "must say what the caller might be looking at");
});

// ── the verb ────────────────────────────────────────────────────────────────

test("a held item is dropped from the queue and from `eligible`", async () => {
  const out = await nextVerb.run(input(), {
    reads: mockReads([item({ id: "held", number: 127, value: 99 }), item({ id: "free", number: 60 })]),
    probe: probeOf({ held: heldBy("gha/session-7", null) }),
  });
  assert.deepEqual(out.queue.map((q) => q.number), [60], "the held item must not be offered");
  assert.equal(out.pick?.number, 60, "and must not be the pick");
  assert.equal(out.eligible, 1, "`eligible` counts work you can actually take");
});

test("the dropped item is REPORTED, not silently vanished", async () => {
  // Without this a caller cannot tell "nobody is on it" from "you can't see who".
  const out = await nextVerb.run(input(), {
    reads: mockReads([item({ id: "held", number: 127, value: 99 }), item({ id: "free", number: 60 })]),
    probe: probeOf({ held: heldBy("gha/session-7", { kind: "pr", id: "bounded-systems/front-desk-scheduler#133" }) }),
  });
  assert.equal(out.liveExclusion.held.length, 1);
  const h = out.liveExclusion.held[0];
  assert.equal(h.number, 127);
  assert.equal(h.holder, "gha/session-7");
  assert.equal(h.boundTo, "pr:bounded-systems/front-desk-scheduler#133");

  const render = nextVerb.render;
  assert.ok(render);
  const text = render(out, input());
  assert.match(text, /held right now, excluded/);
  assert.match(text, /bound to pr:bounded-systems\/front-desk-scheduler#133/);
});

test("a held-but-UNBOUND item says it may lapse back into the queue", async () => {
  const out = await nextVerb.run(input(), {
    reads: mockReads([item({ id: "held", number: 127 })]),
    probe: probeOf({ held: heldBy("gha/session-7", null) }),
  });
  assert.equal(out.liveExclusion.held[0].boundTo, null);
  const text = nextVerb.render!(out, input());
  assert.match(text, /NOT bound/);
  assert.match(text, /may lapse/, "the caller's real question is whether to wait");
});

test("only the top N are probed — the fan-out is bounded", async () => {
  // There is no batch route (the DO namespace cannot be enumerated), so an
  // unbounded probe would be one request per board item on every `next`.
  const items = Array.from({ length: 25 }, (_, i) => item({ id: `i${i}`, number: i, value: 100 - i }));
  const p = probeOf({});
  await nextVerb.run(input({ top: 5 }), { reads: mockReads(items), probe: p });
  assert.equal(p.seen.length, 5, `probed ${p.seen.length}, expected the top 5 only`);
});

test("with no probe and no endpoint, the verb behaves exactly as before", async () => {
  const out = await nextVerb.run(input(), {
    reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2 })]),
  });
  assert.equal(out.liveExclusion.configured, false);
  assert.equal(out.liveExclusion.checked, 0);
  assert.deepEqual(out.queue.map((q) => q.number), [1, 2]);
});

test("an unreachable lease plane leaves the queue intact and says so", async () => {
  // The whole point of failing open: a Worker outage must not empty the queue.
  const out = await nextVerb.run(input(), {
    reads: mockReads([item({ id: "a", number: 1 }), item({ id: "b", number: 2 })]),
    probe: async () => { throw new Error("lease endpoint unreachable"); },
  });
  assert.deepEqual(out.queue.map((q) => q.number), [1, 2], "no work may disappear on an outage");
  assert.equal(out.liveExclusion.unobserved, 2);
  assert.match(nextVerb.render!(out, input()), /could not be checked/);
});
