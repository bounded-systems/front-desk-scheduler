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
  type ClaimResult,
  RESULT_MARKER,
  renderError,
  renderVerdict,
  resultLine,
} from "../scripts/claim-ticket-summary.ts";

const granted: ClaimResult = {
  won: true,
  itemId: "i_kwDOabc123",
  number: 58,
  repository: "front-desk-scheduler",
  title: "Confirm the board query's real cost",
  reason: "claimed",
};

const refused: ClaimResult = {
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

// ── the three refusals are not one refusal (#127) ────────────────────────────
// Same shape as the refusal/error split above, one level in: all three succeed
// and all three are answers, but only ONE of them can be turned into a grant by
// dispatching again. Rendering them identically would tell a caller to retry a
// blocked item forever, and would read a mirror gap as contention.

test("a not-eligible refusal does not tell the caller to dispatch again", () => {
  const out = renderVerdict(
    { ...refused, verdict: "not-eligible", reason: "front-desk-scheduler#5 is not ready: it has 2 open blockers" },
    "session-7",
  );
  assert.match(out, /NOT ELIGIBLE/);
  assert.match(out, /normal outcome, not a failure/);
  assert.match(out, /ready rule refuses it/);
  assert.match(out, /Re-dispatching cannot change that/);
  assert.doesNotMatch(out, /Another claimant holds it/, "must not read as contention");
});

test("a not-in-mirror refusal says nothing about who holds the item", () => {
  const out = renderVerdict(
    { ...refused, verdict: "not-in-mirror", reason: "front-desk-scheduler#118 is not in the mirror" },
    "session-7",
  );
  assert.match(out, /NOT IN MIRROR/);
  assert.match(out, /never heard of this item/);
  assert.match(out, /CAN succeed/, "this is the one refusal a later retry can fix");
  assert.doesNotMatch(
    out,
    /Another claimant holds it/,
    "the mirror's ignorance of an item is not evidence about the lease plane",
  );
});

test("a payload predating #127 still renders — absent verdict falls back to not-granted", () => {
  // Same reason `fencing` is optional in this interface: a run recorded before
  // the field existed must render rather than crash the summary step.
  const out = renderVerdict(refused, "session-7");
  assert.match(out, /NOT GRANTED/);
  assert.match(out, /Another claimant holds it/);
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

test("a grant tells the caller to BIND, not to wait for the clock", () => {
  // Pre-#105 this said "the lease EXPIRES on its own", which was the whole
  // guidance. It is now the fallback: the primary release path is the reaper
  // observing the bound PR close, and the ttl is a referent-less grace window.
  const out = renderVerdict(granted, "a");
  assert.match(out, /Bind it now/);
  assert.match(out, /bind-ticket\.yml/);
  assert.match(out, /never binds lapses/);
});

// ── the fencing token (#114) ─────────────────────────────────────────────────
// It used to live ONLY inside `reason`, while the docs promised a field and both
// bind-ticket and release-ticket require one as input. Nothing caught it because
// every test called claimLease() directly and saw the client's typed token — the
// shape a WORKFLOW caller gets is the verb's JSON, which nothing exercised.

test("a grant surfaces the fencing token as an input to the next dispatch", () => {
  const out = renderVerdict({ ...granted, fencing: 7 }, "a");
  assert.match(out, /fencing/);
  assert.match(out, /`7`/, "the token itself must be readable, not buried in prose");
  assert.match(out, /bind-ticket/, "and named as the thing it is FOR");
});

test("the token round-trips through the greppable line", () => {
  const parsed = JSON.parse(resultLine({ ...granted, fencing: 7 }).slice(RESULT_MARKER.length + 1));
  assert.equal(parsed.fencing, 7, "a session greps this line and needs the token from it");
});

test("a verdict predating #114 renders honestly instead of printing null", () => {
  // Old runs recorded no such field. The summary must say so and point at the
  // reason string, rather than rendering "- fencing: null" as if that were the
  // token — which is the failure mode of treating absent as zero.
  for (const v of [{ ...granted }, { ...granted, fencing: null }]) {
    const out = renderVerdict(v as ClaimResult, "a");
    assert.match(out, /not reported/);
    assert.doesNotMatch(out, /fencing: `null`/);
  }
});

test("a null token on a refusal does not claim a lease was fenced", () => {
  const out = renderVerdict({ ...refused, fencing: null }, "a");
  assert.match(out, /NOT GRANTED/);
  assert.doesNotMatch(out, /bind-ticket/, "nothing to bind when nothing was granted");
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

// ── the verb's OUTPUT CONTRACT (#114) ────────────────────────────────────────
// The gap that hid the bug was one of altitude: the client returns a typed
// LeaseGrant carrying `fencing`, so every claimLease() test saw the token —
// while the verb quietly dropped it on the way out. Asserting the schema here
// means a future refactor that stops returning it fails validation rather than
// silently reintroducing "read a field that does not exist".

import { claimVerb } from "../src/verbs.ts";

const grantedOutput = {
  won: true,
  verdict: "granted" as const,
  itemId: "i_kwDOabc123",
  number: 58,
  repository: "front-desk-scheduler",
  title: "t",
  reason: "leased 3600s (fencing 7)",
  fencing: 7,
};

test("the claim verb's output REQUIRES a fencing field", () => {
  const { fencing: _dropped, ...withoutToken } = grantedOutput;
  assert.throws(
    () => claimVerb.output.parse(withoutToken),
    "dropping the token must fail the output contract, not pass silently",
  );
  assert.equal(claimVerb.output.parse(grantedOutput).fencing, 7);
});

test("the token may be null — the Dolt planes have no ordinal to offer", () => {
  // Null is information (no total order on that plane), not an omission. The
  // schema must admit it without admitting a missing field.
  assert.equal(claimVerb.output.parse({ ...grantedOutput, fencing: null }).fencing, null);
});

test("a non-integer token is refused rather than coerced", () => {
  for (const bad of [1.5, "7", true, {}]) {
    assert.throws(() => claimVerb.output.parse({ ...grantedOutput, fencing: bad }));
  }
});
