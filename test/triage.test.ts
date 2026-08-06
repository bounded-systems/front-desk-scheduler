// Tests for the triage window's decisions (`src/triage.ts`).
//
// Two properties carry the whole design, and both are about NOT writing:
//
//   1. The claim is the guard — a refusal, of any flavour, writes nothing.
//   2. A failed close releases `released`, never `completed`.
//
// The rest is rendering. These are the ones that would let a bad dispatch close
// a live issue, or record a corpse-retirement that never happened.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  type ClaimVerdict,
  type TriageInput,
  DEFAULT_ORG,
  parseItemSelector,
  planTriage,
  releaseStatusFor,
  renderTriageComment,
  stateReasonFor,
} from "../src/triage.ts";

const input: TriageInput = {
  item: "prx#931",
  reason: "superseded",
  evidence: "All three changes are on `main` at df5ab25.",
  supersededBy: "#747",
  agentLabel: "session-7",
};

const granted: ClaimVerdict = {
  won: true,
  verdict: "granted",
  itemId: "PVTI_lADOabc",
  number: 931,
  repository: "prx",
  title: "fix(keeperd): pass repo to importAndPush",
  fencing: 1,
  reason: "leased 600s (fencing 1)",
};

test("a granted claim plans a write against the item the LEASE named", () => {
  const plan = planTriage(granted, input);
  assert.equal(plan.action, "act");
  if (plan.action !== "act") return;
  assert.deepEqual(plan.target, {
    owner: DEFAULT_ORG,
    repo: "prx",
    number: 931,
    itemId: "PVTI_lADOabc",
    fencing: 1,
  });
});

// The whole point of running the claim first. Each of these is a DIFFERENT
// reaction for the caller, so they must stay distinguishable — but all three
// agree on the thing that matters: nothing is written.
for (
  const [verdict, why] of [
    ["not-granted", "not-granted"],
    ["not-eligible", "not-eligible"],
    ["not-in-mirror", "not-in-mirror"],
  ] as const
) {
  test(`a ${verdict} claim writes nothing`, () => {
    const plan = planTriage({ won: false, verdict, reason: verdict }, input);
    assert.equal(plan.action, "abort");
    if (plan.action !== "abort") return;
    assert.equal(plan.why, why);
  });
}

test("a refusal with no verdict field still aborts (pre-#127 payloads)", () => {
  // `verdict` did not exist before #127; `won` carried it alone. A payload
  // without it must not fall through to a write.
  const plan = planTriage({ won: false, reason: "someone else holds it" }, input);
  assert.equal(plan.action, "abort");
  if (plan.action !== "abort") return;
  assert.equal(plan.why, "not-granted");
});

test("a granted verdict missing fencing is unusable, not actionable", () => {
  // #114's shape: the workflow-visible JSON lacking a field the caller needs.
  // Guessing the target from the input selector instead would write to an item
  // the lease plane never named.
  const plan = planTriage({ ...granted, fencing: undefined }, input);
  assert.equal(plan.action, "abort");
  if (plan.action !== "abort") return;
  assert.equal(plan.why, "unusable-verdict");
});

test("fencing 0 is a real token, not a missing one", () => {
  // Guarding with `!claim.fencing` would treat a legitimate 0 as absent.
  const plan = planTriage({ ...granted, fencing: 0 }, input);
  assert.equal(plan.action, "act");
});

// The release-status property. `completed` is a claim about the ITEM being
// finished; anything less hands it back so a later session can retry.
test("a failed close releases `released`, never `completed`", () => {
  assert.equal(releaseStatusFor({ commented: true, closed: false }), "released");
  assert.equal(releaseStatusFor({ commented: false, closed: false }), "released");
  assert.equal(releaseStatusFor({ commented: true, closed: true }), "completed");
});

test("state_reason splits on whether THIS item produced the change", () => {
  // `superseded` closes as not_planned because the change came from elsewhere —
  // marking it `completed` would credit this item with work it did not do.
  assert.equal(stateReasonFor("superseded"), "not_planned");
  assert.equal(stateReasonFor("not-planned"), "not_planned");
  assert.equal(stateReasonFor("resolved"), "completed");
});

test("selectors accept repo#n and owner/repo#n, and reject the rest", () => {
  assert.deepEqual(parseItemSelector("prx#931"), {
    owner: DEFAULT_ORG,
    repo: "prx",
    number: 931,
  });
  assert.deepEqual(parseItemSelector("bounded-systems/prx#931"), {
    owner: "bounded-systems",
    repo: "prx",
    number: 931,
  });
  // A bare number is the front-desk-scheduler#93 trap: numbers repeat across
  // repos, so this must not resolve to anything.
  assert.equal(parseItemSelector("#931"), null);
  assert.equal(parseItemSelector("prx#0"), null);
  assert.equal(parseItemSelector("nonsense"), null);
});

test("the comment carries the evidence and names the lease", () => {
  const body = renderTriageComment(input, granted);
  assert.match(body, /superseded by #747/);
  assert.match(body, /All three changes are on `main` at df5ab25\./);
  // The provenance line is what answers "did whoever closed this hold it?".
  assert.match(body, /gha\/session-7/);
  assert.match(body, /fencing 1/);
});

test("the headline degrades without a cross-reference", () => {
  const body = renderTriageComment({ ...input, supersededBy: undefined }, granted);
  assert.match(body, /\*\*superseded\*\*/);
  assert.doesNotMatch(body, /by undefined/);
});
