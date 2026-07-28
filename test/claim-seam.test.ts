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

// ── snapshot-consistent reads (the head SHA as identity) ─────────────────────
// readScheduling assembles the queue from three queries. Unpinned, they race
// the syncer: a delta landing between the item read and the edge read hands
// assembly two different board states. The Dolt head SHA makes "one board
// state" a checkable identity: resolve it once, pin every query with AS OF.

import { pinTables } from "../src/dolthub.ts";

test("pinTables pins every mirror-table FROM to one commit", () => {
  const h = "v0110csl2jph0aeeij7rhhurrbjcft6g";
  assert.equal(
    pinTables("SELECT x FROM items WHERE status <> 'Done'", h),
    `SELECT x FROM items AS OF '${h}' WHERE status <> 'Done'`,
  );
  assert.equal(pinTables("SELECT a FROM item_deps", h), `SELECT a FROM item_deps AS OF '${h}'`);
  // the legacy fallback reads claims — it must pin too, or the fallback tears
  assert.match(pinTables("SELECT DISTINCT item_id FROM claims WHERE 1", h), /FROM claims AS OF/);
  // non-mirror identifiers are untouched
  assert.equal(pinTables("SELECT * FROM dolt_log", h), "SELECT * FROM dolt_log");
});

test("dolthub readScheduling resolves a head and pins with it", () => {
  const src = readFileSync(new URL("../src/dolthub.ts", import.meta.url), "utf8");
  const fn = /export async function readScheduling[\s\S]*?\n}/.exec(src)?.[0] ?? "";
  assert.match(fn, /resolveHead\(/, "must resolve the snapshot identity once");
  assert.match(fn, /pinTables/, "and pin every query with it");
});

test("server readScheduling wraps its reads in one transaction", () => {
  const fn = /export async function readScheduling[\s\S]*?\n}/.exec(server)?.[0] ?? "";
  assert.match(fn, /START TRANSACTION/, "reads must share one snapshot");
  assert.match(fn, /COMMIT/, "and release it");
});

// ── decided_at_commit: the claim records what it was looking at ──────────────
// The ranking is a pure function of the board, so a claim without its board
// state is unreproducible — a bad pick cannot be told apart from stale data.

test("the claim path reads through the seam, not the local clone", () => {
  // Until 2026-07-28 orderedReadyIds called readMirrorScheduling() directly:
  // the claim RANKED off a local clone while (post-A2) it LATCHED on the shared
  // server — two databases, one decision — and `fds claim` died on
  // `spawn dolt ENOENT` anywhere without a clone (e.g. a cloud session).
  const verbs = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
  const fn = /const orderedReadyIds[\s\S]*?\n};/.exec(verbs)?.[0] ?? "";
  assert.match(fn, /resolveReads\(\)\.readScheduling\(\)/, "must read through the seam");
  assert.doesNotMatch(fn, /readMirrorScheduling\(\)/, "must not bypass it to the local clone");
  assert.match(fn, /at: read\.at/, "and must carry the pin out for the claim to record");
});

test("claimNext records decided_at_commit, shape-checked, NULL when unpinnable", () => {
  const fn = /export async function claimNext[\s\S]*?\n}/.exec(mirror)?.[0] ?? "";
  assert.match(fn, /decidedAtCommit/, "must accept the commit");
  assert.match(fn, /decided_at_commit/, "and write it into the claims row");
  // Interpolated into SQL — must be shape-checked, and must degrade to NULL
  // rather than inventing a value when the adapter could not pin.
  assert.match(fn, /\[a-z0-9\]\{32\}/, "must validate the hash shape before interpolating");
  assert.match(fn, /"NULL"/, "must write NULL when there is no pin");
});

test("the migration adds the column and the schema of record documents it", () => {
  const mig = readFileSync(
    new URL("../schema/migrations/2026-07-28-decided-at-commit.sql", import.meta.url), "utf8");
  assert.match(mig, /ALTER TABLE `claims` ADD COLUMN `decided_at_commit`/);
  // Check the STATEMENTS, not the prose — the header explains *why* IF NOT
  // EXISTS is unusable, so matching the whole file would match its own rationale.
  const statements = mig.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  assert.doesNotMatch(statements, /IF NOT EXISTS/, "Dolt rejects conditional ADD COLUMN; the ledger handles idempotency");
  const ddl = readFileSync(new URL("../schema/mirror.sql", import.meta.url), "utf8");
  assert.match(ddl, /`decided_at_commit` varchar\(32\)/, "schema of record must carry the column");
});

test("a claim degrades rather than failing when the mirror predates the column", () => {
  // The migration needs a dispatch + human approval, so there is always a window
  // where merged code runs against an unmigrated mirror. Verified empirically:
  // without this, every claim dies on `Unknown column 'decided_at_commit'`.
  const fn = /export async function claimNext[\s\S]*?\n}/.exec(mirror)?.[0] ?? "";
  assert.match(fn, /Unknown column 'decided_at_commit'/, "must recognise the pre-migration error");
  assert.match(fn, /warnNoDecidedAtColumn\(\)/, "and say so rather than degrading silently");
  // Legitimate here, unlike the leases case: omitting provenance costs
  // reconstructibility, it cannot weaken S1.
  assert.match(fn, /INSERT INTO claims \(item_id, agent, claimed_at/, "retries without the column");
});
