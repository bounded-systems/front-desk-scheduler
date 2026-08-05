/**
 * The writeback plan (#148): rendering the derived Status onto the live board.
 *
 * `deriveStatus` owns the rule and is tested in derive-status.test.ts. What is
 * tested HERE is the plumbing around it — blocker counting, which authority the
 * "current" value is read from, and every case where a plan declines to write.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BoardItem } from "../src/board.ts";
import { planWriteback } from "../src/writeback.ts";
import type { DepEdge, DerivationRow } from "../src/writeback.ts";

const CLOSED = "2026-08-03 16:13:03";
const REPO = "front-desk-scheduler";

function row(number: number, over: Partial<DerivationRow> = {}): DerivationRow {
  return {
    item_id: `${REPO}#${number}`,
    number,
    repository: REPO,
    status: "Todo",
    origin: "github",
    closed_at: null,
    ...over,
  };
}

function card(number: number, status: string, repository = REPO): BoardItem {
  return {
    id: `PVTI_${repository}_${number}`,
    number,
    title: `#${number}`,
    repository,
    status,
    kind: "task",
    effort: 1,
    value: 1,
    dependsOn: [],
    needs: [],
  };
}

const NO_EDGES: DepEdge[] = [];
const NONE_HELD = new Set<string>();

test("a closed issue is planned to Done, targeting its project-item id", () => {
  const plan = planWriteback(
    [row(93, { status: "In Progress", closed_at: CLOSED })],
    NO_EDGES,
    [card(93, "In Progress")],
    NONE_HELD,
  );

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].to, "Done");
  assert.equal(plan.writes[0].from, "In Progress");
  assert.equal(plan.writes[0].itemId, `PVTI_${REPO}_93`);
  assert.match(plan.writes[0].because, /issue closed/);
});

test("an item with an open dependency is planned to Blocked (D3)", () => {
  const plan = planWriteback(
    [row(10), row(11)],
    [{ item_id: `${REPO}#10`, dep_item_id: `${REPO}#11`, edge_type: "blocks" }],
    [card(10, "Todo"), card(11, "Todo")],
    NONE_HELD,
  );

  const w = plan.writes.find((x) => x.ref === `${REPO}#10`);
  assert.ok(w, "the dependent item should be planned");
  assert.equal(w.to, "Blocked");
  assert.match(w.because, /1 open dependency/);
});

test("a dependency that is complete does not count as a blocker", () => {
  // Same rule assembleScheduling uses: a dep OUTSIDE the open set is satisfied.
  const plan = planWriteback(
    [row(10), row(11, { status: "Done", closed_at: CLOSED })],
    [{ item_id: `${REPO}#10`, dep_item_id: `${REPO}#11`, edge_type: "blocks" }],
    [card(10, "Todo"), card(11, "Done")],
    NONE_HELD,
  );

  assert.equal(plan.writes.filter((w) => w.ref === `${REPO}#10`).length, 0);
});

test("a Blocked card with no recorded dependency is planned to Todo", () => {
  // The D2 case: Blocked asserted with nothing in the graph to justify it.
  //
  // This test once claimed to be "#5's live shape", citing zero item_deps rows
  // measured on 2026-08-04. That measurement was wrong — the query keyed
  // `item_deps.item_id` on a constructed `repo#number` instead of the ProjectV2
  // node id, so it returned [] for an item that has one `blocks` edge to #1.
  // #5 derives to Blocked and always did. The RULE below is real; the example
  // attached to it was not, and CLAUDE.md carries the correction.
  const plan = planWriteback([row(5, { status: "Blocked" })], NO_EDGES, [card(5, "Blocked")], NONE_HELD);

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].to, "Todo");
});

test("a held, unblocked item is planned to In Progress", () => {
  const plan = planWriteback([row(20)], NO_EDGES, [card(20, "Todo")], new Set([`${REPO}#20`]));
  assert.equal(plan.writes[0].to, "In Progress");
  assert.match(plan.writes[0].because, /lease/);
});

test("an UNREADABLE lease plane preserves In Progress and says so (#84)", () => {
  // null, not an empty Set. The distinction is the whole point: an empty Set is
  // an answer ("nothing is held"); null is the absence of one.
  const plan = planWriteback([row(21, { status: "In Progress" })], NO_EDGES, [card(21, "In Progress")], null);

  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /lease plane unreadable/);
});

test("an unreadable lease plane still writes Done and Blocked", () => {
  const plan = planWriteback(
    [row(22, { status: "In Progress", closed_at: CLOSED })],
    NO_EDGES,
    [card(22, "In Progress")],
    null,
  );
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].to, "Done");
});

test("a KNOWN-unheld In Progress card is downgraded to Todo", () => {
  const plan = planWriteback([row(23, { status: "In Progress" })], NO_EDGES, [card(23, "In Progress")], NONE_HELD);
  assert.equal(plan.writes[0].to, "Todo");
});

test("dolt-origin rows are never written, and never reported as skips either", () => {
  // They have no second authority — their card IS the record. Reporting them
  // would make every run print noise proportional to the planning backlog.
  const plan = planWriteback(
    [row(30, { origin: "dolt", status: "Blocked" })],
    NO_EDGES,
    [card(30, "Blocked")],
    NONE_HELD,
  );
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test("the LIVE card, not the mirror row, decides whether a write is needed", () => {
  // The mirror lags a hand-drag. Someone dragged #93 to Done a minute ago; the
  // mirror still says In Progress. Reading the mirror would rewrite a card that
  // is already right and report work that did not happen.
  const plan = planWriteback(
    [row(93, { status: "In Progress", closed_at: CLOSED })],
    NO_EDGES,
    [card(93, "Done")],
    NONE_HELD,
  );
  assert.equal(plan.writes.length, 0);
});

test("re-planning against the board a successful run produced writes nothing", () => {
  const rows = [row(93, { status: "In Progress", closed_at: CLOSED })];
  assert.equal(planWriteback(rows, NO_EDGES, [card(93, "In Progress")], NONE_HELD).writes.length, 1);
  assert.equal(planWriteback(rows, NO_EDGES, [card(93, "Done")], NONE_HELD).writes.length, 0);
});

test("a row with no card on the board is reported, not silently dropped", () => {
  const plan = planWriteback([row(999, { closed_at: CLOSED })], NO_EDGES, [card(93, "Todo")], NONE_HELD);
  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped[0].reason, /not found on the live board/);
});

test("a DoltHub string `number` matches the board's real number (#101)", () => {
  const plan = planWriteback(
    [row(93, { number: "93", closed_at: CLOSED })],
    NO_EDGES,
    [card(93, "Todo")],
    NONE_HELD,
  );
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].ref, `${REPO}#93`);
});

test("cards are matched per repository, so the same number in two repos cannot collide", () => {
  const plan = planWriteback(
    [{ ...row(93, { closed_at: CLOSED }), item_id: "infra#93", repository: "infra" }],
    NO_EDGES,
    [card(93, "Todo"), card(93, "Todo", "infra")],
    NONE_HELD,
  );
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].itemId, "PVTI_infra_93");
});

test("an already-correct board produces an empty plan with no skip noise", () => {
  const plan = planWriteback(
    [row(93, { status: "Done", closed_at: CLOSED }), row(94, { status: "Todo" })],
    NO_EDGES,
    [card(93, "Done"), card(94, "Todo")],
    NONE_HELD,
  );
  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 0);
});

test("a `closes` edge does not block — it is provenance, not a dependency", () => {
  // The regression. prx#972 was written to "Blocked" off a single `closes`
  // edge (run 31020918592) because the plan read SQL.edges, which drops
  // edge_type, and counted every arrow as a blocker.
  //
  // BLOCKER_KINDS in scheduling.ts is exported precisely so nothing keeps a
  // second list, and it excludes `closes`: "mined PR→issue provenance. Never
  // gates anything." D3 agrees — an open closing-PR means the item is in
  // DELIVERY, so manufacturing a blocker from it inverts the meaning.
  const plan = planWriteback(
    [row(972), row(971)],
    [{ item_id: `${REPO}#972`, dep_item_id: `${REPO}#971`, edge_type: "closes" }],
    [card(972, "Todo"), card(971, "Todo")],
    NONE_HELD,
  );

  assert.equal(
    plan.writes.filter((w) => w.to === "Blocked").length,
    0,
    "a closes edge must never produce a Blocked derivation",
  );
});

test("`parent-child` DOES block, so the fix is a kind filter and not a blanket exclusion", () => {
  const plan = planWriteback(
    [row(20), row(21)],
    [{ item_id: `${REPO}#20`, dep_item_id: `${REPO}#21`, edge_type: "parent-child" }],
    [card(20, "Todo"), card(21, "Todo")],
    NONE_HELD,
  );

  const w = plan.writes.find((x) => x.ref === `${REPO}#20`);
  assert.ok(w, "an open parent-child dep should still gate");
  assert.equal(w.to, "Blocked");
});

test("a card already Blocked by a real edge is left alone, while a closes-only one is corrected", () => {
  // Both halves in one plan, because the bug was invisible precisely when the
  // two were not compared: every Blocked card looked justified.
  const plan = planWriteback(
    [row(30, { status: "Blocked" }), row(31), row(40, { status: "Blocked" }), row(41)],
    [
      { item_id: `${REPO}#30`, dep_item_id: `${REPO}#31`, edge_type: "blocks" },
      { item_id: `${REPO}#40`, dep_item_id: `${REPO}#41`, edge_type: "closes" },
    ],
    [card(30, "Blocked"), card(31, "Todo"), card(40, "Blocked"), card(41, "Todo")],
    NONE_HELD,
  );

  assert.equal(plan.writes.filter((w) => w.ref === `${REPO}#30`).length, 0, "#30 is justly Blocked");
  const w40 = plan.writes.find((w) => w.ref === `${REPO}#40`);
  assert.ok(w40, "#40's Blocked is unjustified and should be corrected");
  assert.equal(w40.to, "Todo");
});
