// Tests for the claim-ticket verdict renderer (#61).
//
// The property that matters most here is not formatting: it is that a REFUSAL
// and an ERROR never render as each other. A lost race is a fact about who holds
// the item; an error means the holder is unknown. A session that confuses them
// either retries into a lease it already lost, or gives up on an item nobody
// holds.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type ClaimVerdict,
  RESULT_MARKER,
  renderError,
  renderVerdict,
  resultLine,
} from "../scripts/claim-ticket-summary.ts";

const granted: ClaimVerdict = {
  won: true,
  itemId: "i_kwDOabc123",
  number: 58,
  repository: "front-desk-scheduler",
  title: "Confirm the board query's real cost",
  reason: "claimed",
};

const refused: ClaimVerdict = {
  won: false,
  itemId: null,
  number: null,
  repository: null,
  title: null,
  reason: "held by gha/session-3 until 2026-07-31T14:00:00Z",
};

// ── Refusal is an answer; an error is not ────────────────────────────────────

test("a refusal is reported as a normal outcome, not a failure", () => {
  const out = renderVerdict(refused, "session-7");
  assert.match(out, /NOT GRANTED/);
  assert.match(out, /normal outcome, not a failure/);
  assert.match(out, /held by gha\/session-3/);
  assert.doesNotMatch(out, /ERROR/);
  assert.doesNotMatch(out, /UNKNOWN/);
});

test("an error never claims to know the holder", () => {
  const out = renderError("lease endpoint unreachable at https://…", 1);
  assert.match(out, /ERROR/);
  assert.match(out, /holder is \*\*UNKNOWN\*\*/);
  assert.match(out, /not a lost race/);
  // The failure modes a caller must not read as contention.
  assert.doesNotMatch(out, /NOT GRANTED/);
  assert.doesNotMatch(out, /normal outcome/);
});

test("an error with no diagnostic still says something", () => {
  assert.match(renderError("   ", 2), /\(no diagnostic output\)/);
  assert.match(renderError("", 2), /exit 2/);
});

// ── The grant ────────────────────────────────────────────────────────────────

test("a grant names the item, the repo and the issue number", () => {
  const out = renderVerdict(granted, "session-7");
  assert.match(out, /GRANTED/);
  assert.match(out, /\*\*#58\*\* \[front-desk-scheduler\]/);
  assert.match(out, /Confirm the board query's real cost/);
  assert.match(out, /i_kwDOabc123/);
});

test("a grant reports the NAMESPACED agent, not just the caller's label", () => {
  // The alias a caller passes is not the identity recorded: the Worker binds it
  // under the verified identity. Echoing only the raw label would let a caller
  // mis-attribute their own lease.
  const out = renderVerdict(granted, "session-7");
  assert.match(out, /gha\/session-7/);
});

test("a grant says the lease expires on its own", () => {
  assert.match(renderVerdict(granted, "a"), /EXPIRES on its own/);
});

test("a missing title does not render as 'undefined'", () => {
  const out = renderVerdict({ ...granted, title: null }, "a");
  assert.doesNotMatch(out, /undefined/);
});

// ── The machine-readable line ────────────────────────────────────────────────

test("the result line is one line and round-trips", () => {
  const line = resultLine(granted);
  assert.equal(line.split("\n").length, 1);
  assert.ok(line.startsWith(`${RESULT_MARKER} `));
  assert.deepEqual(JSON.parse(line.slice(RESULT_MARKER.length + 1)), granted);
});

test("a refusal round-trips too — a session reads both from the same marker", () => {
  const parsed = JSON.parse(resultLine(refused).slice(RESULT_MARKER.length + 1));
  assert.equal(parsed.won, false);
  assert.equal(parsed.reason, refused.reason);
});

// ── Both summaries carry the raw payload for anything not rendered ───────────

test("the verdict summary embeds the raw JSON", () => {
  for (const v of [granted, refused]) {
    const out = renderVerdict(v, "a");
    const json = out.slice(out.indexOf("```json") + 7, out.lastIndexOf("```")).trim();
    assert.deepEqual(JSON.parse(json), v);
  }
});
