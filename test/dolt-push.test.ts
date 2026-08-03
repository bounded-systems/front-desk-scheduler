/**
 * The convergent push (#129).
 *
 * The load-bearing test here is the LAST one: every workflow that pushes the
 * mirror must go through scripts/dolt-push.sh. That is the property that
 * decays — a new writer added six months from now with a bare `dolt push` is
 * the same defect returning, and nothing else would notice, because a race
 * only shows up when two jobs happen to overlap.
 *
 * The rest pin the distinctions the script draws, all of which are the same
 * shape as the claim window's: contention is retried, everything else is an
 * error, and a case nobody can adjudicate safely fails loudly instead of
 * picking a winner.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";

const SCRIPT = readFileSync(new URL("../scripts/dolt-push.sh", import.meta.url), "utf8");
const WF_DIR = new URL("../.github/workflows/", import.meta.url);

test("only a non-fast-forward is retried — anything else fails immediately", () => {
  // The claim window's refusal-vs-error distinction, one layer down. Retrying
  // an auth failure or an unreachable remote turns a broken remote into a slow
  // failure that reads like contention.
  assert.match(SCRIPT, /non-fast-forward/, "the race is recognised by its own message");
  assert.match(
    SCRIPT,
    /if ! printf '%s' "\$out" \| grep -qiE '[^']*non-fast-forward[^']*'/,
    "the retry is GATED on that match, not attempted for every failure",
  );
  assert.match(SCRIPT, /not retrying/, "and the non-race path says so");
});

test("a merge conflict is refused, never resolved", () => {
  // Picking a winner would silently discard one writer's committed work. The
  // writers are supposed to own disjoint tables, so a conflict means that
  // assumption broke — which is a fact for a human, not a case to auto-handle.
  assert.match(SCRIPT, /dolt_conflicts/, "conflicts are detected after the merge");
  assert.match(SCRIPT, /refusing to resolve automatically/);
  assert.doesNotMatch(SCRIPT, /--force|-f\b/, "never force-push over a concurrent writer");
});

test("retries are bounded, and exhaustion is named as starvation rather than a lost race", () => {
  assert.match(SCRIPT, /ATTEMPTS="\$\{DOLT_PUSH_ATTEMPTS:-\d+\}"/, "bounded, and overridable for tests");
  assert.match(SCRIPT, /starvation, not a lost race/, "the difference is operationally real");
});

test("the failure modes are distinguishable in the log (#129 done-when 3)", () => {
  // A red lane that says only "non-fast-forward" cannot be told apart from any
  // other push failure, which is what made this defect cheap to ignore.
  const errors = SCRIPT.match(/::error::dolt-push: [^"]+/g) ?? [];
  assert.ok(errors.length >= 3, `expected distinct named failures, got ${errors.length}`);
  const distinct = new Set(errors.map((e) => e.slice(0, 60)));
  assert.equal(distinct.size, errors.length, "each failure mode names itself differently");
});

test("EVERY workflow that pushes the mirror goes through the convergent push", () => {
  // The anti-decay property. A new mirror writer with a bare `dolt push` is
  // #129 returning, and it would be invisible until two jobs overlapped.
  const offenders: string[] = [];
  for (const name of readdirSync(WF_DIR)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const path = new URL(name, WF_DIR);
    if (!statSync(path).isFile()) continue;
    const body = readFileSync(path, "utf8");
    for (const line of body.split("\n")) {
      // A bare `dolt push` not routed through the script.
      if (/\bdolt push\b/.test(line) && !/dolt-push\.sh/.test(line)) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these workflows push the mirror directly and would die on a concurrent writer (#129):\n  ${offenders.join("\n  ")}`,
  );
});

test("the script is executable — a workflow calls it as a program", () => {
  const mode = statSync(new URL("../scripts/dolt-push.sh", import.meta.url)).mode;
  assert.ok(mode & 0o111, "missing the executable bit; the workflow step would fail with EACCES");
});
