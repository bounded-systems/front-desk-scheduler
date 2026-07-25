/**
 * The model's claim, as executable tests:
 *   - with `racy` ops, a seed reproduces each race (S1 double-claim, S2 overspend,
 *     lost-wakeup starvation);
 *   - with `safe` ops, the same scenarios hold the invariants across many seeds;
 *   - a blocks-cycle is caught as deadlock (L1) on a snapshot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { World, WorkItem } from "../src/contract.ts";
import { depsSatisfied, itemById } from "../src/contract.ts";
import { assertInvariants } from "../src/invariants.ts";
import { runSim, findViolatingSeed } from "../src/sim.ts";

function item(partial: Partial<WorkItem> & { number: number }): WorkItem {
  return {
    title: `#${partial.number}`,
    kind: "task",
    phase: "Ready",
    effort: 2,
    value: 50,
    ageDays: 0,
    edges: [],
    ownerId: null,
    ...partial,
  };
}

function world(items: WorkItem[], agents: number, cap: number, consumed = 0): World {
  return {
    items,
    agents: Array.from({ length: agents }, (_, i) => ({
      id: `agent-${i + 1}`,
      phase: "Idle" as const,
      currentItem: null,
      capacity: 10,
    })),
    budget: { id: "test", capacityPoints: cap, consumed },
    clock: 0,
  };
}

test("S1 double-claim: racy ops let two agents own the same item; safe ops never do", () => {
  const scenario = () => world([item({ number: 1, effort: 2 })], 2, 100);

  const racy = findViolatingSeed(scenario(), "racy", 300, "S1");
  assert.ok(racy, "expected a seed where racy ops double-claim");

  const safe = findViolatingSeed(scenario(), "safe", 300);
  assert.equal(safe, null, "safe ops must never violate an invariant");
});

test("S2 overspend: racy ops let concurrent spends exceed the cap; safe ops hold the line", () => {
  // cap 10, consumed 6, two items of effort 3: each gates OK against consumed=6
  // (6+3=9<10), but both applying racy → 6+3+3=12 > 10.
  const scenario = () =>
    world([item({ number: 1, effort: 3 }), item({ number: 2, effort: 3 })], 2, 10, 6);

  const racy = findViolatingSeed(scenario(), "racy", 500, "S2");
  assert.ok(racy, "expected a seed where racy ops overspend");
  assert.ok(racy.consumed > 10, `expected consumed>cap, got ${racy.consumed}`);

  const safe = findViolatingSeed(scenario(), "safe", 500);
  assert.equal(safe, null, "safe reserve-then-commit must never overspend");
});

test("safe ops keep every invariant across 1000 seeds on a mixed workload", () => {
  const scenario = () =>
    world(
      [
        item({ number: 1, effort: 2, value: 80 }),
        item({ number: 2, effort: 4, value: 40 }),
        item({ number: 3, effort: 1, value: 60, phase: "Blocked", edges: [{ type: "blocks", targetNumber: 1 }] }),
      ],
      3,
      20,
    );
  for (let seed = 1; seed <= 1000; seed++) {
    const r = runSim(scenario(), { seed, mode: "safe" });
    assert.equal(r.violation, null, `safe seed ${seed} violated: ${JSON.stringify(r.violation)}`);
  }
});

test("lost wakeup: racy complete strands a now-unblocked item; safe complete wakes it", () => {
  // #2 is blocked by #1. Finish #1, then #2 should become Ready.
  const scenario = () =>
    world(
      [
        item({ number: 1, effort: 2 }),
        item({ number: 2, effort: 2, phase: "Blocked", edges: [{ type: "blocks", targetNumber: 1 }] }),
      ],
      1,
      100,
    );

  const racy = runSim(scenario(), { seed: 1, mode: "racy" });
  assert.equal(racy.finished, false, "racy complete should strand #2 (lost wakeup)");

  const safe = runSim(scenario(), { seed: 1, mode: "safe" });
  assert.equal(safe.finished, true, "safe complete should wake #2 and finish all work");
});

test("L1 deadlock: a blocks-cycle with an idle agent is flagged on the snapshot", () => {
  const cyclic = world(
    [
      item({ number: 1, phase: "Blocked", edges: [{ type: "blocks", targetNumber: 2 }] }),
      item({ number: 2, phase: "Blocked", edges: [{ type: "blocks", targetNumber: 1 }] }),
    ],
    1,
    100,
  );
  const report = assertInvariants(cyclic);
  assert.ok(!report.valid, "cyclic deps must be invalid");
  assert.ok(
    report.findings.some((f) => f.id === "L1"),
    `expected an L1 deadlock finding, got: ${report.findings.map((f) => f.id)}`,
  );
  // sanity: neither item's deps are satisfiable
  assert.equal(depsSatisfied(cyclic, itemById(cyclic, 1)!), false);
});
