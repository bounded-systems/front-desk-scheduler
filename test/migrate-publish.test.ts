/**
 * How mirror-migrate publishes the regenerated projection.
 *
 * The publication logic no longer lives here. It is the org composite action
 * bounded-systems/.github/.github/actions/signed-commit, pinned by SHA — derive,
 * not copy. That move is the point of these tests: the ~100 lines this file used
 * to assert on were a COPY of the action's ancestor, and the duplication was not
 * theoretical. The "treat every branch-create failure as 'already exists'" bug
 * had to be found once and fixed twice — here and in the action extracted from
 * this very code (#31, .github#62).
 *
 * So what is pinned now is the CONTRACT between workflow and action, plus the
 * things a caller can still get wrong on its own:
 *
 *   1. the unsignable path stays gone — no `git commit` on the runner, which
 *      cannot be signed because a job gets a token, not a signing key (#27)
 *   2. the action is pinned to a SHA, not a moving ref
 *   3. the CALLER owns failure policy, because by the time this step runs the
 *      migration has already applied and pushed
 *   4. the outcome is REPORTED — including "published nothing", which has twice
 *      looked exactly like success here
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const wf = readFileSync(
  new URL("../.github/workflows/mirror-migrate.yml", import.meta.url),
  "utf8",
);

/** A step, from its `- name:` to the start of the next one. */
function step(nameStartsWith: string): string {
  const from = wf.indexOf(`      - name: ${nameStartsWith}`);
  assert.notEqual(from, -1, `step "${nameStartsWith}" must exist`);
  const to = wf.indexOf("\n      - name: ", from + 1);
  return wf.slice(from, to === -1 ? undefined : to);
}

test("the projection commit is not built by git on the runner", () => {
  assert.doesNotMatch(wf, /^\s*git commit/m, "must not create the commit locally — it would be unsigned");
  assert.doesNotMatch(wf, /^\s*git push/m, "must not push a locally-built commit either");
});

test("publication is delegated to the org action, pinned to a SHA", () => {
  const s = step("Publish the projection");
  assert.match(
    s,
    /uses: bounded-systems\/\.github\/\.github\/actions\/signed-commit@[0-9a-f]{40}\b/,
    "must use the shared action at a full 40-char SHA — not a branch or tag",
  );
  // The inline copy is what made one bug need two fixes.
  assert.doesNotMatch(s, /gh api -X PUT/, "the inline Contents API write must be gone");
  assert.doesNotMatch(s, /git\/refs/, "and the inline branch-create with it");
});

test("the caller owns the failure policy, not the action", () => {
  // The action fails honestly. Here a failure must NOT fail the job: the
  // migration has already applied and pushed, so a red run would misreport work
  // that succeeded. Putting this policy inside the action is how its ancestor
  // produced a green run that had published nothing.
  const s = step("Publish the projection");
  assert.match(s, /continue-on-error: true/, "must not fail an already-applied migration");
  assert.match(s, /id: publish/, "and must be addressable, or its outcome cannot be reported");
});

test("what publication did is reported — including doing nothing", () => {
  // Twice this workflow has produced a green run that published nothing: once
  // from a guard that read a FAILING `dolt diff` as an empty one, once from a
  // branch-create failure reported as "already exists". Silence is the bug.
  const s = step("Report what publication did");
  assert.match(s, /steps\.publish\.outcome/, "must branch on whether the action failed");
  assert.match(s, /CHANGED/, "must distinguish 'published nothing' from 'published'");
  assert.match(
    s,
    /THE MIGRATION APPLIED AND PUSHED SUCCESSFULLY/,
    "a publication failure must say what DID succeed, or it reads as a failed migration",
  );
  assert.match(s, /schema-drift/, "and must name the consequence");
});

test("the signature is reported, not assumed — even though the endpoint guarantees it", () => {
  // createCommitOnBranch is documented to produce signed commits, so this should
  // always be true. Checked anyway: a guarantee is a claim about someone else's
  // system, and the identity here — a broker-minted App token — is one nothing
  // has exercised. An unsigned result would be real information, not noise.
  const s = step("Report what publication did");
  assert.match(s, /VERIFIED/, "must read the action's verified output");
  assert.match(s, /REASON/, "and the reason");
  assert.match(s, /::warning::.*NOT verified/, "an unsigned commit must be loud");
});

test("the PR body's backticks are escaped inside the heredoc", () => {
  // Unescaped, a backtick in a double-quoted string is COMMAND SUBSTITUTION:
  // bash runs the migration filename and substitutes its output, so the line
  // renders as "Migration:" with the value silently gone. Valid syntax, wrong
  // semantics — `bash -n` cannot catch it, and `set -e` does not fire because
  // echo succeeds regardless. Caught exactly this way on 2026-07-28.
  const s = step("Build the PR body");
  assert.match(s, /echo "Migration: \\`/, "the backtick must be escaped");
  assert.doesNotMatch(s, /echo "Migration: [^\\]`/, "an unescaped backtick would execute the value");
});
