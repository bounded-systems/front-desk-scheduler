/**
 * The deploy request a ceremony lane signs, and the gate it is not allowed to
 * fall back to (infra#538).
 *
 * `lease-deploy.yml` moved off the `await-approval` comment gate onto the Face
 * ID ceremony. Two things about that are worth a check rather than a reading,
 * and both are here because THIS REPO IS OUTSIDE infra's `gate-strength` check
 * — that check discovers workflows by file, in infra's own tree, so a lane
 * living here is invisible to it. A rule that only holds where someone
 * remembered to apply it is the exact defect infra#538 was opened for, so the
 * rule is restated where it can actually run.
 *
 * 1. THE REQUEST IS COPIED BETWEEN REPOS AND ITS FIELDS NAME THE SOURCE.
 *    The ceremony block came from desk's deploy.yml, which builds
 *    `{repo:"desk",workflow:"deploy.yml",…}`. Those two strings are what the
 *    approval page renders — they are literally what the human reads before
 *    touching the sensor. A copy that kept `repo:"desk"` would still start a
 *    ceremony, still digest, still redeem: nothing downstream disagrees,
 *    because nothing downstream knows which repo asked. The only symptom is
 *    that the phone names the wrong deploy, which is the one failure mode a
 *    human-in-the-loop gate cannot absorb.
 *
 * 2. THE CHARSETS ARE THE KEEPER'S, AND IT REFUSES LATE.
 *    `deploy-digest.mjs` validates before it digests, and an invalid field is a
 *    422 from `/authorize/start` — i.e. after the run has started, after the
 *    tripwire has passed, and (in the notification shape) after somebody has
 *    been told to expect a tap. Charset drift is cheap to catch here and
 *    expensive to catch there. The regexes are duplicated deliberately: the
 *    keeper is private and this repo is public, so importing them is not
 *    available, and a copy that must not drift is exactly what a test is for.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/** The repository these workflows live in — the value their requests must name. */
const THIS_REPO = "front-desk-scheduler";

const WORKFLOW_DIR = new URL("../.github/workflows/", import.meta.url).pathname;

// deploy-digest.mjs CHECKS, verbatim. If the keeper's ever loosen, these may
// follow; if they tighten, this fails first, which is the right order.
const REPO_RE = /^[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/;

const DEPLOY_REQUEST_V1 = "bounded.deploy-request.v1";

type Lane = { file: string; text: string };

function workflows(): Lane[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => ({ file: f, text: readFileSync(join(WORKFLOW_DIR, f), "utf8") }));
}

/** Lanes that open a ceremony — found by the request type, not by a list. */
function ceremonyLanes(): Lane[] {
  return workflows().filter((l) => l.text.includes(`v:"${DEPLOY_REQUEST_V1}"`));
}

test("discovery finds the ceremony lane at all", () => {
  // Without this the two tests below pass vacuously over an empty set — the
  // "green from a job that did nothing" shape this org keeps meeting. If the
  // request literal is ever reformatted (whitespace inside the jq object, say)
  // this is what says so, rather than the suite quietly measuring nothing.
  const lanes = ceremonyLanes();
  assert.ok(
    lanes.length > 0,
    `no workflow builds a ${DEPLOY_REQUEST_V1}. Either the ceremony was removed ` +
      `(then delete this test and say why in the diff) or the literal changed shape ` +
      `and this discovery no longer matches it.`,
  );
  assert.deepEqual(lanes.map((l) => l.file).sort(), ["lease-deploy.yml"]);
});

test("every ceremony request names ITS OWN repo and ITS OWN file", () => {
  for (const { file, text } of ceremonyLanes()) {
    const repo = /repo:"([^"]*)"/.exec(text)?.[1];
    const workflow = /workflow:"([^"]*)"/.exec(text)?.[1];

    assert.equal(
      repo,
      THIS_REPO,
      `${file}: the request says repo:"${repo}". The approval page renders that ` +
        `string, so a human would be asked to authorize a deploy of ${repo}.`,
    );
    assert.equal(
      workflow,
      basename(file),
      `${file}: the request says workflow:"${workflow}" — the approval page would ` +
        `name a workflow that is not the one asking.`,
    );

    assert.match(repo!, REPO_RE, `${file}: repo would 422 at /authorize/start`);
    assert.match(workflow!, WORKFLOW_RE, `${file}: workflow would 422 at /authorize/start`);
  }
});

test("no lane keeps the retired comment gate, with or without a ceremony", () => {
  // infra#235: `await-approval` cannot tell the dispatcher from the approver,
  // so it gates nothing against the party it exists to constrain. infra#480
  // retired it and infra#18 removed even the break-glass fallback to it —
  // "a single-boolean bypass to a mechanism known not to work".
  //
  // Matched on `uses:` rather than the name, so the comments explaining the
  // migration (which must keep naming it) do not trip their own rule. This is
  // infra's `gate-strength.sh` predicate, restated where it can see this repo.
  for (const { file, text } of workflows()) {
    const offending = text
      .split("\n")
      .filter((line) => /uses:.*await-approval/.test(line));
    assert.deepEqual(
      offending,
      [],
      `${file} still gates on await-approval:\n  ${offending.join("\n  ")}`,
    );
  }
});
