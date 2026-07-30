/** The cheap board query's node→RawBoardItem mapping (no gh needed). */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BOARD_FIELDS, cheapNodeToRaw, normalize } from "../src/board.ts";

const full = {
  id: "PVTI_abc",
  content: { __typename: "Issue", number: 21, title: "Fix the thing", repository: { name: "prx" } },
  status: { name: "In Progress" },
  kind: { name: "task" },
  effort: { number: 3 },
  value: { number: 8 },
  dependsOn: { text: "#6, #7" },
};

test("a fully-populated node maps to the same shape gh project item-list produces", () => {
  const item = normalize(cheapNodeToRaw(full));
  assert.ok(item);
  assert.equal(item.id, "PVTI_abc");
  assert.equal(item.number, 21);
  assert.equal(item.title, "Fix the thing");
  assert.equal(item.repository, "prx");
  assert.equal(item.status, "In Progress");
  assert.equal(item.kind, "task");
  assert.equal(item.effort, 3);
  assert.equal(item.value, 8);
  assert.deepEqual(item.dependsOn, [6, 7]);
});

test("a renamed field arrives as null and defaults — never as a wrong value", () => {
  // fieldValueByName returns null for a name the project doesn't have. The item
  // must still normalize, with the same defaults an unpopulated field gets, so a
  // rename degrades to "unset" rather than silently corrupting scheduling inputs.
  const item = normalize(cheapNodeToRaw({ ...full, effort: null, kind: null, dependsOn: null }));
  assert.ok(item);
  assert.equal(item.effort, 0);
  assert.equal(item.kind, "task"); // toKind's default
  assert.deepEqual(item.dependsOn, []);
  assert.equal(item.value, 8); // untouched fields survive
});

test("an item with no content (draft issue) is dropped, as on the legacy path", () => {
  assert.equal(normalize(cheapNodeToRaw({ id: "PVTI_x", content: null })), null);
});

test("an item without a project-item id is dropped — the id is the mirror's key", () => {
  assert.equal(normalize(cheapNodeToRaw({ ...full, id: undefined })), null);
});

test("effort/value of 0 survive as 0, not as missing", () => {
  // ?? vs || matters here: a real 0 must not be re-defaulted through the same
  // path as an absent field, or a deliberately-zeroed estimate reads as unset.
  const raw = cheapNodeToRaw({ ...full, effort: { number: 0 }, value: { number: 0 } });
  assert.equal(raw.effort, 0);
  assert.equal(raw.value, 0);
  const item = normalize(raw);
  assert.ok(item);
  assert.equal(item.effort, 0);
  assert.equal(item.value, 0);
});

test("a PullRequest node maps like an Issue", () => {
  const item = normalize(cheapNodeToRaw({
    ...full,
    content: { __typename: "PullRequest", number: 99, title: "PR", repository: { name: "prx" } },
  }));
  assert.ok(item);
  assert.equal(item.number, 99);
  assert.equal(item.repository, "prx");
});

test("BOARD_FIELDS names the fields the mirror actually consumes", () => {
  // The cheap query is only cheap because these are enumerated. If a field is
  // added to the scheduling model, it must be added here too or it reads as null.
  assert.deepEqual(Object.keys(BOARD_FIELDS).sort(), ["dependsOn", "effort", "kind", "status", "value"]);
});
