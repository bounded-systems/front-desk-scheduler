/**
 * Status as a projection (#148): the card is output, not an authority.
 *
 * The tests worth having here are the ones that pin the REFUSALS — what the
 * derivation declines to decide is what keeps it from destroying signal it
 * cannot read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveStatus, isStatus, STATUSES } from "../src/status.ts";
import type { DerivationInput, Status } from "../src/status.ts";

function input(over: Partial<DerivationInput> = {}): DerivationInput {
  return { origin: "github", closedAt: null, openBlockers: 0, current: "Todo", ...over };
}

test("a closed issue derives Done", () => {
  assert.equal(deriveStatus(input({ closedAt: "2026-08-03 16:13:03" })), "Done");
});

test("Done wins over every other signal — closed_at is the completion ground truth", () => {
  const s = deriveStatus(input({
    closedAt: "2026-08-03 16:13:03",
    openBlockers: 3,
    leaseHeld: true,
    current: "In Progress",
  }));
  assert.equal(s, "Done");
});

test("an open item with open blockers derives Blocked (D3)", () => {
  assert.equal(deriveStatus(input({ openBlockers: 1 })), "Blocked");
});

test("Blocked outranks In Progress — the graph is structural, a lease is about a person", () => {
  // D2/D3 form the biconditional Blocked ⟺ openBlockers > 0 and admit no
  // exception for "someone is holding it". Who holds it is a lease-plane
  // question, answered by next/graph, not by overloading this enum.
  assert.equal(deriveStatus(input({ openBlockers: 2, leaseHeld: true })), "Blocked");
});

test("an open, unblocked, held item derives In Progress", () => {
  assert.equal(deriveStatus(input({ leaseHeld: true })), "In Progress");
});

test("an open, unblocked, unheld item derives Todo", () => {
  assert.equal(deriveStatus(input({ leaseHeld: false })), "Todo");
});

test("reopening walks the derivation back — the case a monotone join cannot express", () => {
  // closed_at going NULL is a DECREASE. A join/max over a status lattice is
  // monotone and would pin the card at Done forever; deriving re-reads the
  // authority each time and simply produces the lower value.
  const closed = deriveStatus(input({ closedAt: "2026-08-03 16:13:03", current: "In Progress" }));
  assert.equal(closed, "Done");

  const reopened = deriveStatus(input({ closedAt: null, current: "Done", leaseHeld: false }));
  assert.equal(reopened, "Todo");
});

test("a dolt-origin row is never derived — its card IS the record", () => {
  // Hidden/planning rows have no GitHub issue, so closed_at has nothing to say
  // about them. Same scoping SQL.statusDrift uses.
  for (const current of STATUSES) {
    assert.equal(deriveStatus(input({ origin: "dolt", current })), null);
  }
  assert.equal(deriveStatus(input({ origin: "dolt", closedAt: "2026-08-03 16:13:03" })), null);
});

test("an unreadable lease plane PRESERVES In Progress instead of downgrading it (#84)", () => {
  // The refusal that matters most. There is no batch route to the DO, so a
  // whole-board pass does not know who holds what. Deriving Todo anyway would
  // flip every held card and destroy exactly the signal it could not read.
  assert.equal(deriveStatus(input({ leaseHeld: undefined, current: "In Progress" })), null);
});

test("an unreadable lease plane still derives the components it CAN read", () => {
  // Not-derivable applies to the In Progress component alone. Done and Blocked
  // come from the mirror and are unaffected by the DO being unreachable.
  assert.equal(deriveStatus(input({ leaseHeld: undefined, current: "In Progress", closedAt: "2026-08-03 16:13:03" })), "Done");
  assert.equal(deriveStatus(input({ leaseHeld: undefined, current: "In Progress", openBlockers: 1 })), "Blocked");
});

test("a KNOWN-unheld item does downgrade from In Progress — undefined and false differ", () => {
  // The distinction the #124 lesson names: no data is not bad data. `false` is
  // an answer from the lease plane; `undefined` is the absence of one.
  assert.equal(deriveStatus(input({ leaseHeld: false, current: "In Progress" })), "Todo");
  assert.equal(deriveStatus(input({ leaseHeld: undefined, current: "In Progress" })), null);
});

test("the derivation is idempotent — re-deriving its own output changes nothing", () => {
  const cases: DerivationInput[] = [
    input({ closedAt: "2026-08-03 16:13:03" }),
    input({ openBlockers: 1 }),
    input({ leaseHeld: true }),
    input({ leaseHeld: false }),
  ];
  for (const c of cases) {
    const first = deriveStatus(c);
    assert.ok(first !== null);
    assert.equal(deriveStatus({ ...c, current: first as Status }), first);
  }
});

test("every derived value is a real board Status", () => {
  const cases: DerivationInput[] = [
    input({ closedAt: "2026-08-03 16:13:03" }),
    input({ openBlockers: 5 }),
    input({ leaseHeld: true }),
    input({ leaseHeld: false }),
  ];
  for (const c of cases) {
    const s = deriveStatus(c);
    assert.ok(s !== null && isStatus(s), `${s} is not a board Status`);
  }
});

test("#5's live shape: Blocked with no recorded dependency derives Todo", () => {
  // Measured on the mirror 2026-08-04: front-desk-scheduler#5 is card="Blocked"
  // with depends_on empty and zero item_deps rows — a D2 violation (Blocked
  // without a justified block). Deriving therefore CHANGES it, and that change
  // is the point: either the block is real and belongs in the graph, or the
  // card was asserting something nothing else knew.
  const s = deriveStatus(input({ current: "Blocked", openBlockers: 0, leaseHeld: false }));
  assert.equal(s, "Todo");
});
