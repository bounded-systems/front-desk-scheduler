/**
 * Prints the reproduced race traces. Run: `node scripts/demo.ts`
 * Shows, side by side, a racy interleaving that violates an invariant and the
 * safe run that doesn't — the whole point of the model, on stdout.
 */

import type { World, WorkItem } from "../src/contract.ts";
import { findViolatingSeed, runSim } from "../src/sim.ts";

function item(p: Partial<WorkItem> & { number: number }): WorkItem {
  return { title: `#${p.number}`, kind: "task", phase: "Ready", effort: 2, value: 50, ageDays: 0, edges: [], ownerId: null, ...p };
}
function world(items: WorkItem[], agents: number, cap: number, consumed = 0): World {
  return {
    items,
    agents: Array.from({ length: agents }, (_, i) => ({ id: `agent-${i + 1}`, phase: "Idle" as const, currentItem: null, capacity: 10 })),
    budget: { id: "demo", capacityPoints: cap, consumed },
    clock: 0,
  };
}

function show(title: string, r: ReturnType<typeof runSim> | null) {
  console.log(`\n=== ${title} ===`);
  if (!r) return console.log("  (no violating seed found)");
  console.log(`  seed=${r.seed} mode=${r.mode} steps=${r.steps} consumed=${r.consumed} finished=${r.finished}`);
  for (const line of r.trace) console.log("   " + line);
}

// S1 — double-claim
show("S1 double-claim (racy)", findViolatingSeed(world([item({ number: 1 })], 2, 100), "racy", 300, "S1"));

// S2 — overspend
show(
  "S2 overspend (racy)",
  findViolatingSeed(world([item({ number: 1, effort: 3 }), item({ number: 2, effort: 3 })], 2, 10, 6), "racy", 500, "S2"),
);

// Safe run of the same S2 scenario — no violation, budget respected.
show("S2 scenario under safe ops", runSim(world([item({ number: 1, effort: 3 }), item({ number: 2, effort: 3 })], 2, 10, 6), { seed: 1, mode: "safe", stopOnViolation: false }));
