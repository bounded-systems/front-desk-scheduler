/** Pure board→policy mapping (no gh needed). */

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalize, parseDependsOn, statusToState, toPriorityInputs } from "../src/board.ts";

test("parseDependsOn extracts issue numbers from free text", () => {
  assert.deepEqual(parseDependsOn("#6, #7"), [6, 7]);
  assert.deepEqual(parseDependsOn("blocked by #42 and #43!"), [42, 43]);
  assert.deepEqual(parseDependsOn(undefined), []);
  assert.deepEqual(parseDependsOn(""), []);
});

test("statusToState maps Front Desk Status to bead state", () => {
  assert.equal(statusToState("Todo"), "open");
  assert.equal(statusToState("In Progress"), "in_progress");
  assert.equal(statusToState("Blocked"), "blocked");
  assert.equal(statusToState("Done"), "closed");
});

test("normalize tolerates missing custom fields (the live-board reality)", () => {
  const item = normalize({ content: { number: 21 }, title: "x", repository: "org/prx", status: "Todo" });
  assert.ok(item);
  assert.equal(item.number, 21);
  assert.equal(item.repository, "prx");
  assert.equal(item.kind, "task"); // defaulted
  assert.equal(item.effort, 0); // unpopulated → 0 (triggers degenerate fallback)
  assert.deepEqual(item.dependsOn, []);
  assert.equal(normalize({ title: "no number" }), null);
});

test("toPriorityInputs derives openBlockers and unblocks from the Depends-on graph", () => {
  const items = [
    normalize({ content: { number: 1 }, status: "Done", repository: "o/r" })!,
    normalize({ content: { number: 2 }, status: "Todo", repository: "o/r", "depends on": "#1, #3" })!,
    normalize({ content: { number: 3 }, status: "Todo", repository: "o/r" })!,
  ];
  const inputs = toPriorityInputs(items);
  const byNum = new Map(inputs.map((i) => [i.number, i]));

  // #2 depends on #1 (Done → satisfied) and #3 (Todo → open blocker) ⇒ 1 open blocker.
  assert.equal(byNum.get(2)!.openBlockers, 1);
  // #3 is depended on by #2 ⇒ unblocks 1; #1 likewise.
  assert.equal(byNum.get(3)!.unblocks, 1);
  assert.equal(byNum.get(1)!.unblocks, 1);
  // #1 is closed → not eligible; #3 is open with no blockers → eligible.
  assert.equal(byNum.get(3)!.openBlockers, 0);
});
