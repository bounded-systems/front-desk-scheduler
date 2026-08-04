/**
 * Claiming a NAMED item (#127).
 *
 * Two sessions worked #118 at once on 2026-08-03 with the entire lease
 * apparatus — fencing tokens, the reaper, the contention properties proven in
 * `specs/lean/` — sitting unused, because `claim-ticket.yml` latches the
 * top-ranked pick and there was no way to say "I intend to work #118". These
 * tests pin the three properties that make the selector safe to add:
 *
 *   1. the ready rule still decides. Naming an item chooses which one is asked
 *      about; it does not exempt it. This is the one that matters — an
 *      unchecked `item_id` would be a lease-plane bypass of the rule #59 spent
 *      effort making single-definition.
 *   2. a refusal never reaches the CAS. The Worker refuses a bad claim in the
 *      router, before the Durable Object is touched, so a failed claim writes
 *      nothing; a refusal decided HERE must have the same property.
 *   3. "not yet in the mirror" and "someone holds it" stay distinguishable.
 *      They want opposite reactions — retry later vs. do not retry — and
 *      collapsing them is the same error `docs/claiming-from-a-session.md`
 *      already warns about for not-granted vs. error.
 *
 * Per #114, these assert the VERB's rendered output — the shape a workflow
 * caller actually receives — not the internals of `claimLease()`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RawItem, RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { claimVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";
import { parseItemSelector, SelectorError } from "../src/selector.ts";

const AT = "lt5lpmo3tp7pfv5an1310ll649leqret";

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
    dependsOn: over.dependsOn ?? [],
    needs: over.needs ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: over.ageDays ?? 0,
    leased: over.leased ?? false,
  };
}

/** A row as `readAllItems` returns it — the whole board, Done included. */
function raw(over: Partial<RawItem> & { item_id: string; number: number }): RawItem {
  return {
    item_id: over.item_id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "front-desk-scheduler",
    status: over.status ?? "Done",
    kind: over.kind ?? "task",
    effort: over.effort ?? 2,
    value: over.value ?? 50,
    depends_on: over.depends_on ?? "",
    needs: over.needs ?? "",
    age_days: over.age_days ?? 0,
  };
}

function mockReads(schedulable: SchedulingItem[], all: RawItem[] = []): SchedulerReads {
  return {
    source: "server",
    readScheduling: async () => ({ items: schedulable, at: AT }),
    readTypedEdges: async () => [] as RawTypedEdge[],
    readAllItems: async () => ({ items: all, at: AT }),
    meta: async () => ({ syncedAt: "2026-08-04T00:50:53Z", commit: AT, source: "server" }),
  };
}

type ClaimInput = Parameters<typeof claimVerb.run>[0];
type ClaimOutput = Awaited<ReturnType<typeof claimVerb.run>>;

function input(over: Partial<ClaimInput> = {}): ClaimInput {
  return { agent: "session-7", ttl: 3600, ...over };
}

/** A CAS that always grants, and records what it was asked about. */
function grantingCas(seen: string[][] = []) {
  const fn = async (_agent: string, ids: readonly string[]) => {
    seen.push([...ids]);
    return { won: true, itemId: ids[0], fencing: 1, plane: "lease" as const, reason: "leased 3600s (fencing 1)" };
  };
  return Object.assign(fn as never as typeof import("../src/mirror.ts").claimNext, { seen });
}

/** A CAS that always refuses — the item is held by someone else. */
const refusingCas = (async (_agent: string, ids: readonly string[]) => {
  assert.equal(ids.length, 1, "the named path must ask about exactly one item");
  return { won: false, plane: "lease" as const, reason: "no unleased eligible item" };
}) as never as typeof import("../src/mirror.ts").claimNext;

/** A CAS that must never be called. Property 2. */
const forbiddenCas = (async () => {
  throw new Error("a refusal must be decided before the CAS — nothing may be written");
}) as never as typeof import("../src/mirror.ts").claimNext;

/**
 * `VerbSpec.run` is declared `T | Promise<T>` — a verb is allowed to be sync.
 * `claim` is not, but the declared type is what a caller has to program
 * against, so awaiting here is what makes this file typecheck as well as pass
 * (the distinction next.test.ts records: tests that work at runtime and do not
 * typecheck are why the repo's own type gate could not be turned on).
 */
const run = async (
  inp: ClaimInput,
  reads: SchedulerReads,
  claim: typeof import("../src/mirror.ts").claimNext,
): Promise<ClaimOutput> => await claimVerb.run(inp, { reads, claim });

// ── the selector grammar ─────────────────────────────────────────────────────

test("a bare number is refused without a repo — numbers repeat across repos", () => {
  // front-desk#93: a bare `#number` on a multi-repo board cost real triage time.
  assert.throws(() => parseItemSelector("127"), SelectorError);
  assert.throws(() => parseItemSelector("#127"), SelectorError);
  assert.deepEqual(parseItemSelector("127", "prx"), { number: 127, repository: "prx" });
});

test("repo#number is the canonical form, and owner/repo#number is accepted", () => {
  const want = { number: 127, repository: "front-desk-scheduler" };
  assert.deepEqual(parseItemSelector("front-desk-scheduler#127"), want);
  // The shape bind-ticket.yml takes for its referent — a caller who has learned
  // that one should not be punished for typing it here.
  assert.deepEqual(parseItemSelector("bounded-systems/front-desk-scheduler#127"), want);
});

test("a node id round-trips — it is what a claim verdict hands back", () => {
  assert.deepEqual(parseItemSelector("PVTI_lADOESuYO84BawOLzg1JjKY"), { id: "PVTI_lADOESuYO84BawOLzg1JjKY" });
});

test("a selector that contradicts --repo is refused rather than resolved", () => {
  // Silently preferring either side would claim an item the caller did not name.
  assert.throws(() => parseItemSelector("prx#931", "hooksmith"), SelectorError);
  assert.doesNotThrow(() => parseItemSelector("prx#931", "prx"));
});

test("unparseable text is an ERROR, not a verdict — it is not a fact about the board", async () => {
  await assert.rejects(
    () => run(input({ item: "not an item" }), mockReads([]), forbiddenCas),
    SelectorError,
  );
});

// ── property 1: the ready rule still decides ─────────────────────────────────

test("a named BLOCKED item is refused — naming it does not exempt it from the rule", async () => {
  const out = await run(
    input({ item: "front-desk-scheduler#5" }),
    mockReads([item({ id: "a", number: 5, openBlockers: 2 })]),
    forbiddenCas,
  );
  assert.equal(out.verdict, "not-eligible");
  assert.equal(out.won, false);
  assert.match(out.reason, /2 open blockers/);
  // It still identifies the item — a refusal that cannot say what it refused is
  // no more useful than a silent one.
  assert.equal(out.number, 5);
  assert.equal(out.repository, "front-desk-scheduler");
});

test("a named item whose card is not live is refused with the status named", async () => {
  const out = await run(
    input({ item: "front-desk-scheduler#5" }),
    mockReads([item({ id: "a", number: 5, status: "Blocked" })]),
    forbiddenCas,
  );
  assert.equal(out.verdict, "not-eligible");
  assert.match(out.reason, /"Blocked"/);
});

test("a named item that IS ready reaches the CAS — and only it", async () => {
  const cas = grantingCas();
  const out = await run(
    input({ item: "front-desk-scheduler#127" }),
    mockReads([
      item({ id: "top", number: 60, value: 99 }), // outranks it
      item({ id: "named", number: 127 }),
    ]),
    cas,
  );
  assert.equal(out.verdict, "granted");
  assert.equal(out.won, true);
  assert.equal(out.number, 127, "must latch the item that was NAMED, not the top-ranked one");
  assert.equal(out.fencing, 1);
  assert.deepEqual(cas.seen, [["named"]], "the candidate list is exactly the named item");
});

// ── property 3: the two refusals stay distinguishable ────────────────────────

test("an item absent from the whole board is not-in-mirror, not not-granted", async () => {
  // The #127 case: #118 was created at 21:45:52Z and the 21:59:28Z sync still
  // did not contain it. That is "I cannot see it yet", and retrying later helps.
  const out = await run(
    input({ item: "front-desk-scheduler#118" }),
    mockReads([item({ id: "a", number: 127 })], []),
    forbiddenCas,
  );
  assert.equal(out.verdict, "not-in-mirror");
  assert.equal(out.number, 118, "the verdict must echo what was asked for");
  assert.equal(out.repository, "front-desk-scheduler");
  assert.match(out.reason, /not in the mirror/);
  assert.doesNotMatch(out.reason, /held/, "must not read as contention");
});

test("a Done item is not-eligible, not not-in-mirror — the board does know it", async () => {
  // Absent from the SCHEDULABLE set is two different facts; the whole-board read
  // is what tells them apart.
  const out = await run(
    input({ item: "front-desk-scheduler#95" }),
    mockReads([item({ id: "a", number: 127 })], [raw({ item_id: "done", number: 95, status: "Done" })]),
    forbiddenCas,
  );
  assert.equal(out.verdict, "not-eligible");
  assert.equal(out.itemId, "done");
  assert.match(out.reason, /finished/);
});

test("a held item is not-granted — the CAS is the authority on who holds it", async () => {
  const out = await run(
    input({ item: "front-desk-scheduler#127" }),
    // `leased` on the mirror row is a derived projection and may be stale, so
    // the named path does not pre-refuse on it: it asks the lease plane.
    mockReads([item({ id: "named", number: 127, leased: true })]),
    refusingCas,
  );
  assert.equal(out.verdict, "not-granted");
  assert.equal(out.won, false);
  assert.match(out.reason, /held by another agent/);
  assert.doesNotMatch(
    out.reason,
    /no unleased eligible item/,
    "the ranked path's wording describes a search that did not happen",
  );
});

// ── the ranked path is unchanged ─────────────────────────────────────────────

test("without --item, the top-ranked pick is latched exactly as before", async () => {
  const cas = grantingCas();
  const out = await run(
    input(),
    mockReads([item({ id: "low", number: 5, value: 10 }), item({ id: "top", number: 60, value: 99 })]),
    cas,
  );
  assert.equal(out.verdict, "granted");
  assert.equal(out.number, 60);
  assert.equal(cas.seen[0][0], "top", "the whole ranked list is still the candidate list");
  assert.ok(cas.seen[0].length > 1, "and it is still a LIST — the walk to the next candidate matters");
});

const refusingCasEmpty = (async () => ({
  won: false,
  plane: "lease" as const,
  reason: "no unleased eligible item",
})) as never as typeof import("../src/mirror.ts").claimNext;

test("a ranked claim with nothing eligible is not-granted, and never not-in-mirror", async () => {
  const out = await run(input(), mockReads([]), refusingCasEmpty);
  assert.equal(out.verdict, "not-granted");
});

// ── the output contract (#114) ───────────────────────────────────────────────

test("every verdict validates against the verb's declared output schema", async () => {
  const cases: Array<[ClaimInput, SchedulerReads, typeof import("../src/mirror.ts").claimNext]> = [
    [input({ item: "front-desk-scheduler#127" }), mockReads([item({ id: "n", number: 127 })]), grantingCas()],
    [input({ item: "front-desk-scheduler#127" }), mockReads([item({ id: "n", number: 127 })]), refusingCas],
    [input({ item: "front-desk-scheduler#5" }), mockReads([item({ id: "n", number: 5, openBlockers: 1 })]), forbiddenCas],
    [input({ item: "front-desk-scheduler#118" }), mockReads([]), forbiddenCas],
  ];
  const seen = new Set<string>();
  for (const [inp, reads, cas] of cases) {
    const out: ClaimOutput = await run(inp, reads, cas);
    // The shape a WORKFLOW caller receives is the rendered JSON, which is what
    // no test exercised when #114 shipped a documented-but-absent field.
    const parsed = claimVerb.output.parse(JSON.parse(JSON.stringify(out)));
    assert.equal(parsed.won, parsed.verdict === "granted", "`won` must stay the granted/not split");
    seen.add(parsed.verdict);
  }
  assert.deepEqual([...seen].sort(), ["granted", "not-eligible", "not-granted", "not-in-mirror"]);
});

test("the renderer names the verdict, so an unretryable refusal does not read like a retryable one", () => {
  const render = claimVerb.render;
  assert.ok(render, "claim must define a renderer");
  const base = {
    won: false, itemId: null, number: 118, repository: "front-desk-scheduler",
    title: null, fencing: null,
  };
  for (const verdict of ["not-granted", "not-eligible", "not-in-mirror"] as const) {
    assert.match(render({ ...base, verdict, reason: "r" }, input()), new RegExp(verdict));
  }
});
