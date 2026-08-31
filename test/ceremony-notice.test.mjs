// Every lane that opens a keeper ceremony must also announce it (infra#553).
//
// The failure this pins is not a broken notice — it is a lane that never had
// one. infra#552 gave seven lanes a push; this repo was not in that scope, so
// lease-deploy announced only via a GitHub notification issue: batched, routed
// wherever GitHub decides, and no use against a window that can be as short as
// two minutes. Nothing was red, because nothing was checked.
//
// Reads the workflow FILES, not a list of lane names, so a new ceremony lane is
// covered the day it is added rather than the day someone remembers this test.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = ".github/workflows";
const ceremonyLanes = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .filter((f) => readFileSync(join(DIR, f), "utf8").includes("authorize/start"));

test("there is at least one ceremony lane to check", () => {
  // Without this the three tests below pass vacuously the day the glob breaks.
  assert.ok(ceremonyLanes.length > 0, "no lane contains authorize/start — the filter is wrong");
});

test("every ceremony lane pushes an approval notice before waiting", () => {
  for (const f of ceremonyLanes) {
    const src = readFileSync(join(DIR, f), "utf8");
    const notice = src.indexOf("desk.bounded.tools/approval");
    const wait = src.indexOf("Wait for the Face ID");
    assert.notEqual(notice, -1, `${f}: opens a ceremony and never notifies`);
    // `wait === -1` is a FAILURE, not a reason to skip: a ceremony lane always
    // waits, and a missing marker would silently disable the ordering check.
    assert.notEqual(wait, -1, `${f}: no wait step found — the marker moved`);
    assert.ok(notice < wait, `${f}: notifies AFTER the wait, which is too late`);
  }
});

test("the ceremony step publishes the approve URL the notice reads", () => {
  for (const f of ceremonyLanes) {
    const src = readFileSync(join(DIR, f), "utf8");
    assert.ok(
      src.includes('echo "approve_url=$approve_url" >> "$GITHUB_OUTPUT"'),
      `${f}: approve_url stays a local shell variable, so the notice sends an empty URL`,
    );
  }
});

test("a notifying lane can mint the OIDC token the notice is authorized by", () => {
  for (const f of ceremonyLanes) {
    const src = readFileSync(join(DIR, f), "utf8");
    if (!src.includes("desk.bounded.tools/approval")) continue;
    assert.ok(src.includes("id-token: write"), `${f}: cannot mint for desk`);
  }
});
