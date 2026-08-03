// Tests for the release-ticket verdict renderer (#104).
//
// Same governing property as the claim renderer's tests: the outcomes must not
// render as each other. The release side has one more of them, and the extra one
// is the dangerous one — `stale-fencing` means the caller has been superseded
// and may still be doing work, which is operationally nothing like "the lease
// had already lapsed" even though both are `released: false`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isZombie,
  type ReleaseVerdict,
  RESULT_MARKER,
  renderError,
  renderVerdict,
  resultLine,
} from "../scripts/release-ticket-summary.ts";

const released: ReleaseVerdict = {
  released: true,
  status: "completed",
  reason: "completed",
  holder: null,
};

const notHolder: ReleaseVerdict = {
  released: false,
  status: "released",
  reason: "not-holder",
  holder: "gha/session-3",
};

const notHeld: ReleaseVerdict = {
  released: false,
  status: "released",
  reason: "not-held",
  holder: null,
};

const zombie: ReleaseVerdict = {
  released: false,
  status: "released",
  reason: "stale-fencing",
  holder: "gha/session-9",
};

// ── The three outcomes never render as each other ────────────────────────────

test("a successful release does not read as a refusal", () => {
  const out = renderVerdict(released, "session-7", "PVTI_abc");
  assert.match(out, /COMPLETED/);
  assert.match(out, /item is free/);
  assert.doesNotMatch(out, /NOT RELEASED/);
  assert.doesNotMatch(out, /ERROR/);
  assert.doesNotMatch(out, /UNKNOWN/);
});

test("a refusal is a normal outcome, not an error", () => {
  const out = renderVerdict(notHolder, "session-7", "PVTI_abc");
  assert.match(out, /NOT RELEASED/);
  assert.match(out, /normal outcome, not a failure/);
  assert.match(out, /gha\/session-3/);
  assert.doesNotMatch(out, /ERROR/);
  assert.doesNotMatch(out, /UNKNOWN/);
});

test("an error never claims the item is free", () => {
  const out = renderError("lease endpoint unreachable", 1);
  assert.match(out, /ERROR/);
  assert.match(out, /state is \*\*UNKNOWN\*\*/);
  assert.match(out, /Do not assume the item is free/);
  assert.doesNotMatch(out, /NOT RELEASED/);
  assert.doesNotMatch(out, /normal outcome/);
});

// ── stale-fencing is not just another refusal ────────────────────────────────

test("a stale-fencing refusal tells the caller to STOP, and a plain refusal does not", () => {
  const z = renderVerdict(zombie, "session-7", "PVTI_abc");
  assert.match(z, /stale fencing/i);
  assert.match(z, /Stop working this item/);
  assert.match(z, /zombie/i);
  assert.match(z, /gha\/session-9/);

  // The ordinary refusal must NOT carry the stop signal — a caller that reads
  // "someone else holds it" as "you are a zombie" abandons work it still holds.
  const n = renderVerdict(notHolder, "session-7", "PVTI_abc");
  assert.doesNotMatch(n, /Stop working this item/);
  assert.doesNotMatch(n, /zombie/i);
});

test("isZombie is true only for stale-fencing", () => {
  assert.equal(isZombie(zombie), true);
  assert.equal(isZombie(notHolder), false);
  assert.equal(isZombie(notHeld), false);
  assert.equal(isZombie(released), false);
  // A *successful* release whose status happens to be the string is still not
  // a zombie — the flag is about the refusal, not the word.
  assert.equal(isZombie({ ...released, reason: "stale-fencing" }), false);
});

test("not-held and not-holder are distinguishable — lapsed is not contention", () => {
  const held = renderVerdict(notHolder, "a", "i");
  const lapsed = renderVerdict(notHeld, "a", "i");
  assert.match(lapsed, /already lapsed/);
  assert.match(held, /Another agent holds this item/);
  assert.doesNotMatch(lapsed, /Another agent holds this item/);
  assert.doesNotMatch(held, /already lapsed/);
});

// ── Rendering hygiene ────────────────────────────────────────────────────────

test("a null holder never renders as 'null' or 'undefined'", () => {
  for (const v of [released, notHeld]) {
    const out = renderVerdict(v, "a", "i");
    assert.doesNotMatch(out, /undefined/);
    assert.doesNotMatch(out, /holder.*`null`/);
  }
});

test("a release reports the NAMESPACED agent, not just the caller's label", () => {
  assert.match(renderVerdict(released, "session-7", "i"), /gha\/session-7/);
});

test("paragraphs stay separated — this renders as markdown, not one run-on block", () => {
  // Regression: an earlier version dropped every empty string to skip the
  // conditional holder line, which also ate the intentional blank lines and
  // collapsed the whole summary into a single paragraph.
  for (const v of [released, notHolder, notHeld, zombie]) {
    const out = renderVerdict(v, "a", "i");
    const heading = out.split("\n")[0];
    assert.match(heading, /^## release-ticket/);
    assert.equal(out.split("\n")[1], "", `no blank line after the heading for ${v.reason}`);
    assert.ok(out.includes("\n\n```json"), `no blank line before the payload for ${v.reason}`);
  }
});

test("an error with no diagnostic still says something", () => {
  assert.match(renderError("   ", 2), /\(no diagnostic output\)/);
  assert.match(renderError("", 2), /exit 2/);
});

// ── The machine-readable line ────────────────────────────────────────────────

test("the result line is one line and round-trips", () => {
  const line = resultLine(released);
  assert.equal(line.split("\n").length, 1);
  assert.ok(line.startsWith(`${RESULT_MARKER} `));
  assert.deepEqual(JSON.parse(line.slice(RESULT_MARKER.length + 1)), released);
});

test("every outcome round-trips from the same marker", () => {
  for (const v of [released, notHolder, notHeld, zombie]) {
    const parsed = JSON.parse(resultLine(v).slice(RESULT_MARKER.length + 1));
    assert.equal(parsed.released, v.released);
    assert.equal(parsed.reason, v.reason);
  }
});

test("the release marker is distinct from the claim's", () => {
  // A session greps one line out of a job log; if these collided, a release
  // verdict read from a claim run's log would parse into the wrong shape.
  assert.notEqual(RESULT_MARKER, "FDS-CLAIM-RESULT");
});

// ── Every summary carries the raw payload ────────────────────────────────────

test("the verdict summary embeds the raw JSON", () => {
  for (const v of [released, notHolder, notHeld, zombie]) {
    const out = renderVerdict(v, "a", "i");
    const json = out.slice(out.indexOf("```json") + 7, out.lastIndexOf("```")).trim();
    assert.deepEqual(JSON.parse(json), v);
  }
});
