/**
 * The A2 seam: claim writes must reach ONE database.
 *
 * `leases.item_id` is a PRIMARY KEY, so at most one lease row per item can exist
 * — within one database. The pre-seam claim path shelled out to `dolt sql -q`
 * against a LOCAL CLONE, so two agents on two machines each latched their own
 * copy and both read back their own name. The PK was necessary and not
 * sufficient; assumption A2 in specs/lean/Leases.lean names exactly this.
 *
 * These tests pin the two properties that make the seam correct, without
 * requiring a running server:
 *
 *   1. write and read-back go to the SAME plane. Splitting them is the subtle
 *      failure — a server write confirmed by a local-clone read would report a
 *      win that no shared database agrees with.
 *   2. the local-clone fallback is NOT silent. It is correct for one agent and
 *      wrong for several, so it must announce itself.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const mirror = readFileSync(new URL("../src/mirror.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/dolt-server.ts", import.meta.url), "utf8");

/** The claim block: from the leases banner to the start of the push section. */
function claimBlock(): string {
  const from = mirror.indexOf("// --- leases (SQS-style");
  const to = mirror.indexOf("// --- push (dolt");
  assert.ok(from !== -1 && to > from, "claim block markers must exist");
  return mirror.slice(from, to);
}

test("claim writes route through the seam, not straight to the local clone", () => {
  const block = claimBlock();
  // The ONLY permitted `dsql(` in the block is claimWrite's own fallback branch.
  const direct = [...block.matchAll(/await dsql\(/g)].length;
  assert.equal(
    direct,
    1,
    "claim path must call claimWrite/claimRows; the single allowed `await dsql(` is the fallback inside claimWrite",
  );
  // Allow a generic type argument: call sites read `claimRows<{...}>(sql)`.
  for (const fn of ["claimWrite", "claimRows"]) {
    assert.match(block, new RegExp(`await ${fn}(<|\\()`), `claim path must call ${fn}`);
  }
});

test("read-back uses the same plane as the write — never a different database", () => {
  // Both helpers must branch on the same predicate, or a server write could be
  // confirmed by a local read (or the reverse), reporting a win nothing agrees with.
  const writes = /async function claimWrite[\s\S]*?\n}/.exec(mirror)?.[0] ?? "";
  const reads = /async function claimRows[\s\S]*?\n}/.exec(mirror)?.[0] ?? "";
  assert.ok(writes.includes("writesGoToServer()"), "claimWrite must branch on writesGoToServer()");
  assert.ok(reads.includes("writesGoToServer()"), "claimRows must branch on the SAME predicate");
});

test("the unserialized fallback announces itself instead of failing silently", () => {
  assert.ok(mirror.includes("warnIfUnserialized"), "a warning helper must exist");
  assert.match(claimBlock(), /warnIfUnserialized\(\)/, "claimNext must call it");
  const warn = /function warnIfUnserialized[\s\S]*?\n}/.exec(mirror)?.[0] ?? "";
  assert.match(warn, /DOLT_HOST/, "the warning must name the variable that fixes it");
  assert.match(warn, /A2/, "and cite the assumption it violates");
});

test("server writes are committed, or claims would not be attributable", () => {
  // A write to a dolt sql-server lands in the working set. Without DOLT_COMMIT it
  // never becomes a commit, and `dolt log` can no longer answer "who claimed this"
  // — the specific property that justified putting the queue in Dolt.
  const fn = /export async function writeAndCommit[\s\S]*?\n}/.exec(server)?.[0] ?? "";
  assert.match(fn, /DOLT_ADD/, "must stage");
  assert.match(fn, /DOLT_COMMIT/, "must commit");
  assert.match(fn, /--author/, "must attribute the commit to the claiming agent");
  assert.match(fn, /dolt_status/, "must skip committing an empty diff (a lost latch changes nothing)");
});

test("only the claim path is routed — sync/push stays on the local clone", () => {
  // sync/push runs solely from Actions under the `mirror-write` concurrency
  // group, so it is already single-writer. Routing it here would add a
  // dependency for no correctness gain.
  const beforeLeases = mirror.slice(0, mirror.indexOf("// --- leases (SQS-style"));
  assert.ok(
    [...beforeLeases.matchAll(/await dsql\(/g)].length > 5,
    "sync/upsert writes should still use dsql directly",
  );
  assert.ok(!beforeLeases.includes("claimWrite("), "sync path must not use the claim seam");
});
