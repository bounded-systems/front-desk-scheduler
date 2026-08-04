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
    [{ item_id: `${REPO}#10`, dep_item_id: `${REPO}#11` }],
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
    [{ item_id: `${REPO}#10`, dep_item_id: `${REPO}#11` }],
    [card(10, "Todo"), card(11, "Done")],
    NONE_HELD,
  );

  assert.equal(plan.writes.filter((w) => w.ref === `${REPO}#10`).length, 0);
});

test("#5's live shape — Blocked with no recorded dependency is planned to Todo", () => {
  // Measured on the mirror 2026-08-04: card="Blocked", depends_on empty, zero
  // item_deps rows — a D2 violation. The derivation CHANGES it, and that change
  // is the point: either the block is real and belongs in the graph, or the card
  // was asserting something no other authority knew. This test exists so the
  // behaviour change is deliberate and visible rather than a surprise in prod.
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
