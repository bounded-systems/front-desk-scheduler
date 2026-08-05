/**
 * board-writeback.yml's reporting must survive a non-zero script exit.
 *
 * THE REGRESSION THIS PINS
 * -----------------------
 * Actions runs `run:` blocks as `bash -e {0}`. Every line after the script call
 * in the writeback step exists to REPORT what the script did — echo the output,
 * emit FDS-WRITEBACK-RESULT if the script did not, write the job summary — so
 * inheriting `-e` means a failing run reports nothing at all.
 *
 * That happened: run 31020918592, the first `apply=true` dispatch, exited 1 and
 * logged no output, no verdict and no summary, because `out="$(...)"` tripped
 * `-e` before the first `echo`. A partial write had occurred and the job log
 * could not say which cards moved — recovering it needed a second dry run.
 *
 * The no-verdict fallback was written for precisely that case and could not run,
 * because it sits DOWNSTREAM of the failure it guards. Hence a test rather than
 * a comment: the property is invisible in review (it is about a shell flag the
 * file does not mention) and one tidying edit removes it.
 *
 * These assertions are deliberately about the STEP, not the whole file — the
 * mint step above it SHOULD keep `-e`, since a missing token must stop the run
 * before anything is written.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const WORKFLOW = new URL("../.github/workflows/board-writeback.yml", import.meta.url);

/** The `Status writeback` step, from its name to the end of the file. */
function writebackStep(): string {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const start = yaml.indexOf("- name: Status writeback");
  assert.ok(start !== -1, "the Status writeback step should exist");
  return yaml.slice(start);
}

test("the writeback step does not inherit the runner's `-e`", () => {
  const step = writebackStep();
  const overridesShell = /^\s*shell:\s*bash \{0\}\s*$/m.test(step);
  const disablesInline = /^\s*set \+e\s*$/m.test(step);

  assert.ok(
    overridesShell || disablesInline,
    "the step must either override the shell (`shell: bash {0}`) or `set +e`, " +
      "or a non-zero script exit aborts before the verdict is printed (run 31020918592)",
  );
});

test("the step still reports the script's exit code rather than swallowing it", () => {
  // Not inheriting `-e` must not become "the run is always green". The step
  // captures rc and exits with it, so a failed write still fails the job — it
  // just prints why first.
  const step = writebackStep();
  assert.match(step, /rc=\$\?/, "the step should capture the script's exit code");
  assert.match(step, /exit \$rc/, "the step should exit with the script's code");
});

test("the no-verdict fallback is still present", () => {
  // It was unreachable in 31020918592, not absent. With `-e` cleared it becomes
  // live, and it is the only thing standing between a crash and a silent pass.
  const step = writebackStep();
  assert.match(step, /FDS-WRITEBACK-RESULT/, "the fallback verdict line should exist");
  assert.match(step, /no verdict/, "the fallback should mark itself as a missing verdict");
});

test("the mint step above it DOES keep -e — this is not a blanket relaxation", () => {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const mintStart = yaml.indexOf("- name: Mint Front Desk App token");
  const mintEnd = yaml.indexOf("- name: Status writeback");
  assert.ok(mintStart !== -1 && mintEnd > mintStart, "the mint step should precede the writeback step");

  const mint = yaml.slice(mintStart, mintEnd);
  assert.match(mint, /set -euo pipefail/, "the mint step should keep -e: no token must stop the run");
  assert.ok(
    !/^\s*shell:\s*bash \{0\}\s*$/m.test(mint),
    "the mint step should NOT override the shell — a failed mint must abort before any write",
  );
});
