/** The heuristic estimator — relative properties, not brittle exact numbers. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimate } from "../src/estimate.ts";

test("chores/docs are small effort and low value", () => {
  const e = estimate("task", "chore: add a top-of-file doc comment to intake-source.ts");
  assert.ok(e.effort <= 2, `expected small effort, got ${e.effort}`);
  assert.ok(e.value <= 40, `expected low value, got ${e.value}`);
});

test("security/correctness bugs are high value", () => {
  const bug = estimate("task", "bug: credential proxy leaks secret on stale ref");
  const chore = estimate("task", "chore: rename a variable");
  assert.ok(bug.value > chore.value + 20, `security bug should outrank chore: ${bug.value} vs ${chore.value}`);
});

test("epics/productionization are large effort", () => {
  const epic = estimate("epic", "productionize fleet hosting — scaling, multi-tenant isolation");
  const task = estimate("task", "add a flag");
  assert.ok(epic.effort > task.effort, `epic should be heavier: ${epic.effort} vs ${task.effort}`);
});

test("estimates stay within clamps", () => {
  for (const kind of ["epic", "room", "door", "task"] as const) {
    const e = estimate(kind, "security auth deadlock overspend blocker critical harden migrate spike");
    assert.ok(e.effort >= 1 && e.effort <= 10, `effort in range: ${e.effort}`);
    assert.ok(e.value >= 0 && e.value <= 100, `value in range: ${e.value}`);
  }
});

test("a bugfix reduces effort but raises value vs a plain task of same kind", () => {
  const plain = estimate("task", "implement the widget");
  const bug = estimate("task", "fix the broken widget regression");
  assert.ok(bug.effort <= plain.effort, "bugfix should not be heavier");
  assert.ok(bug.value >= plain.value, "bugfix should not be less valuable");
});
