/**
 * The writeback selection rule (#148): which drifting cards a machine may move.
 *
 * The property under test is asymmetry. `status-drift` reports two kinds of
 * disagreement and this module must act on exactly one of them, so most of these
 * tests are about what is NOT written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { BoardItem } from "../src/board.ts";
import { DONE, planWriteback } from "../src/writeback.ts";

/** A board item with the fields the plan reads; the rest are ranking noise. */
function card(
  repository: string,
  number: number,
  status: string,
  id = `PVTI_${repository}_${number}`,
): BoardItem {
  return {
    id,
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

const CLOSED = "2026-08-03 16:13:00";

test("a closed issue whose card is not Done is planned, targeting its project-item id", () => {
  const plan = planWriteback(
    [{ repository: "front-desk-scheduler", number: 93, status: "In Progress", closed_at: CLOSED }],
    [card("front-desk-scheduler", 93, "In Progress", "PVTI_kwHOA")],
  );

  assert.equal(plan.writes.length, 1);
  assert.deepEqual(plan.writes[0], {
    ref: "front-desk-scheduler#93",
    itemId: "PVTI_kwHOA",
    from: "In Progress",
    closedAt: CLOSED,
  });
  assert.equal(plan.skipped.length, 0);
});

test("the OTHER direction is never written — an open issue with a Done card is a human claim", () => {
  // The whole reason this module exists as a filter rather than a loop over
  // SQL.statusDrift. Resolving this one means either closing the issue or
  // moving the card back, and nothing here can know which.
  const plan = planWriteback(
    [{ repository: "front-desk-scheduler", number: 42, status: DONE, closed_at: null }],
    [card("front-desk-scheduler", 42, DONE)],
  );

  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /OPEN/);
});

test("a card the board already reads Done is skipped as a stale mirror row, not rewritten", () => {
  // The mirror lags its webhook by seconds-to-minutes, so a card dragged by hand
  // a moment ago still appears in statusDrift. Writing it again would be
  // harmless but would report work that did not happen.
  const plan = planWriteback(
    [{ repository: "front-desk-scheduler", number: 112, status: "Todo", closed_at: CLOSED }],
    [card("front-desk-scheduler", 112, DONE)],
  );

  assert.equal(plan.writes.length, 0);
  assert.match(plan.skipped[0].reason, /already reads "Done"/);
});

test("re-running against the board the previous run produced plans nothing", () => {
  // Idempotence stated end-to-end: the guard is the live status, so success is
  // self-limiting. A window that is safe to dispatch twice is one nobody has to
  // reason about before dispatching.
  const rows = [
    { repository: "front-desk-scheduler", number: 93, status: "In Progress", closed_at: CLOSED },
  ];
  const before = [card("front-desk-scheduler", 93, "In Progress")];

  const first = planWriteback(rows, before);
  assert.equal(first.writes.length, 1);

  // The board after the mutation lands; the mirror has not caught up yet.
  const after = [card("front-desk-scheduler", 93, DONE)];
  assert.equal(planWriteback(rows, after).writes.length, 0);
});

test("a drift row with no card on the board is reported, not silently dropped", () => {
  const plan = planWriteback(
    [{ repository: "front-desk-scheduler", number: 999, status: "Todo", closed_at: CLOSED }],
    [card("front-desk-scheduler", 93, "Todo")],
  );

  assert.equal(plan.writes.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].reason, /not found on the live board/);
});

test("a DoltHub string `number` matches the board's real number (#101)", () => {
  // The HTTP read plane returns every column as a JSON string. Keying the board
  // map on the raw value would miss every row over MCP while passing on the CLI,
  // which is exactly the shape #101 shipped.
  const plan = planWriteback(
    [{ repository: "front-desk-scheduler", number: "93", status: "Todo", closed_at: CLOSED }],
    [card("front-desk-scheduler", 93, "Todo")],
  );

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].ref, "front-desk-scheduler#93");
});

test("cards are matched per repository, so the same number in two repos cannot collide", () => {
  const plan = planWriteback(
    [{ repository: "infra", number: 93, status: "Todo", closed_at: CLOSED }],
    [card("front-desk-scheduler", 93, "Todo"), card("infra", 93, "Todo", "PVTI_infra93")],
  );

  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].itemId, "PVTI_infra93");
});

test("a mixed batch splits into exactly the derivable half", () => {
  const plan = planWriteback(
    [
      { repository: "front-desk-scheduler", number: 93, status: "In Progress", closed_at: CLOSED },
      { repository: "front-desk-scheduler", number: 112, status: "Todo", closed_at: CLOSED },
      { repository: "front-desk-scheduler", number: 42, status: DONE, closed_at: null },
    ],
    [
      card("front-desk-scheduler", 93, "In Progress"),
      card("front-desk-scheduler", 112, "Todo"),
      card("front-desk-scheduler", 42, DONE),
    ],
  );

  assert.deepEqual(plan.writes.map((w) => w.ref), [
    "front-desk-scheduler#93",
    "front-desk-scheduler#112",
  ]);
  assert.equal(plan.skipped.length, 1);
});
