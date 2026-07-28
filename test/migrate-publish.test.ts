/**
 * How mirror-migrate publishes the regenerated projection.
 *
 * Two separate failures shaped this step, and both are invisible in a green run:
 *
 *   1. `git commit` on the runner produces an UNSIGNED commit. Actions gives a
 *      job a token, not a signing key, so there is nothing to sign with. Once
 *      main required verified signatures, the projection PR (#27) could only be
 *      merged with a rule bypass. The fix is to have GitHub construct the commit
 *      server-side, via the Contents API.
 *
 *   2. "written through the API" does NOT imply "signed" — verified empirically
 *      on 2026-07-28, when a Contents API write came back with no signature at
 *      all. Signing depends on the authenticating identity. So the step must
 *      CHECK the result rather than trust the endpoint; assuming it is the same
 *      class of mistake as a proof whose precondition nothing establishes.
 *
 * These assertions are deliberately about the workflow's SHAPE. There is no way
 * to exercise a GitHub-signed commit from a test, so what is pinned is that the
 * unsignable path is gone and the check that would catch its return is present.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const wf = readFileSync(
  new URL("../.github/workflows/mirror-migrate.yml", import.meta.url),
  "utf8",
);

/** The publication step: from its `- name:` to the start of the next step. */
function publishStep(): string {
  const from = wf.indexOf("      - name: Publish the projection");
  assert.notEqual(from, -1, "the publication step must exist");
  const to = wf.indexOf("\n      - name: ", from + 1);
  return wf.slice(from, to === -1 ? undefined : to);
}

test("the projection commit is built by GitHub, not by git on the runner", () => {
  const step = publishStep();
  assert.match(step, /gh api -X PUT "repos\/\$REPO\/contents\/schema\/mirror\.live\.sql"/,
    "must write the projection through the Contents API");
  // `git commit` is the specific thing that cannot be signed here.
  assert.doesNotMatch(step, /^\s*git commit/m, "must not create the commit locally — it would be unsigned");
  assert.doesNotMatch(step, /^\s*git push/m, "must not push a locally-built commit either");
});

test("the resulting commit's signature is verified, not assumed", () => {
  const step = publishStep();
  assert.match(step, /\.commit\.verification\.verified/, "must read back whether GitHub signed it");
  assert.match(step, /\.commit\.verification\.reason/, "and surface WHY when it did not");
  assert.match(step, /::warning::.*NOT verified/, "an unsigned result must be loud, not silent");
});

test("the PR names its head and base explicitly", () => {
  // gh infers head from the checked-out branch. Since the commit is now written
  // through the API, this job never checks the branch out — it is still on the
  // commit actions/checkout left. Without --head, gh would target main.
  const step = publishStep();
  assert.match(step, /gh pr create[\s\S]*?--head "\$branch"/, "must state the head branch");
  assert.match(step, /gh pr create[\s\S]*?--base /, "and the base");
});

test("every publication failure degrades — the migration has already applied", () => {
  const step = publishStep();
  // `set -e` here would turn "the write succeeded but the PR did not open" into
  // a red run for work that actually landed in production.
  assert.match(step, /set -uo pipefail/, "must not use -e");
  assert.doesNotMatch(step, /set -euo/, "a failure here must not fail a migration that succeeded");
  assert.match(step, /degrade\(\)/, "must define the degrade path");
  // An empty-but-successful response is the failure shape this repo has already
  // been bitten by (the guard that read a failing `dolt diff` as an empty one).
  assert.match(step, /\[ -n "\$\{commit:-\}" \]/, "must reject a 2xx that returned no commit sha");
  assert.match(step, /\[ -n "\$\{blob:-\}" \]/, "and no blob sha");
});

test("a failed branch-create is not reported as 'already exists'", () => {
  // Run 30379222054: the create-ref POST failed, the step announced "branch
  // already exists — writing onto it", then 404'd reading a branch that had
  // never existed. The migration applied, the run went green, and the summary
  // named the wrong cause. Only the 422 is benign; everything else must degrade
  // carrying the REAL error, because a misdiagnosis sends the reader elsewhere.
  const step = publishStep();
  assert.match(step, /Reference already exists/,
    "must match on the specific 422 rather than on any failure");
  assert.match(step, /degrade "could not create branch/,
    "any other failure must degrade, not be swallowed");
  assert.match(step, /\$\{create_out/, "and must surface the API's own error text");
});
