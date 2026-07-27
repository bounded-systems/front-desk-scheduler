/**
 * Leases — the regression test for S1 (mutual exclusion) at the SQL layer.
 *
 * specs/tla and specs/rust prove that an ATOMIC compare-and-swap upholds S1.
 * Neither says anything about whether the mirror's SQL actually performs one.
 * That gap is what these tests cover: they model the two claim designs at
 * statement granularity and interleave two agents at the worst possible point.
 *
 * The modelling assumption is the honest one — a single SQL statement is atomic
 * with respect to a PRIMARY KEY, and nothing else is. That is precisely what a
 * unique index buys you in any MySQL-compatible engine, and precisely what the
 * old predicate-guarded INSERT had no right to assume.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { SQL } from "../src/scheduling.ts";

const ITEM = "prx#119";

// ── the pre-2026-07-27 design: append-only log, no unique index ──────────────
// INSERT INTO claims ... SELECT ... WHERE NOT EXISTS (<live claim>)
// The guard is a predicate evaluated against a snapshot, so the check and the
// insert are separable — which is the entire problem.

interface ClaimRow {
  item_id: string;
  agent: string;
}

class ClaimsLogTable {
  rows: ClaimRow[] = [];
  /** The WHERE NOT EXISTS guard — a read. */
  guardPasses(itemId: string): boolean {
    return !this.rows.some((r) => r.item_id === itemId);
  }
  /** The INSERT — a write, unconstrained. */
  insert(itemId: string, agent: string): void {
    this.rows.push({ item_id: itemId, agent });
  }
  /** claimNext's old confirmation: "is there a live claim naming ME?" */
  confirms(itemId: string, agent: string): boolean {
    return this.rows.some((r) => r.item_id === itemId && r.agent === agent);
  }
}

// ── the current design: one row per item, PRIMARY KEY (item_id) ──────────────
// INSERT IGNORE INTO leases ... — one statement, adjudicated by the engine.

class LeasesTable {
  private byItem = new Map<string, string>();
  /** INSERT IGNORE: creates the row or collides. Atomic — this is the PK. */
  insertIgnore(itemId: string, agent: string): void {
    if (!this.byItem.has(itemId)) this.byItem.set(itemId, agent);
  }
  /** Read back the single row the PK guarantees. */
  holder(itemId: string): string | undefined {
    return this.byItem.get(itemId);
  }
  get rowCount(): number {
    return this.byItem.size;
  }
}

test("old design: two agents racing one item BOTH win (the S1 violation)", () => {
  const claims = new ClaimsLogTable();

  // The interleaving: both guards evaluate before either insert lands.
  const aliceGuard = claims.guardPasses(ITEM); // A: check
  const bobGuard = claims.guardPasses(ITEM); // B: check
  assert.equal(aliceGuard, true);
  assert.equal(bobGuard, true, "both agents observe the item as unclaimed");

  claims.insert(ITEM, "alice"); // A: act
  claims.insert(ITEM, "bob"); // B: act

  // Two live claims for one item — S1 is violated in the data.
  assert.equal(claims.rows.length, 2, "the schema admits a second live claim");

  // And the failure is SILENT: each agent's confirmation filtered on its own
  // name, so both read back their own row and both returned won=true.
  assert.equal(claims.confirms(ITEM, "alice"), true);
  assert.equal(claims.confirms(ITEM, "bob"), true);
});

test("current design: the PK admits exactly one winner", () => {
  const leases = new LeasesTable();

  // Same interleaving, no guard to race — the engine adjudicates the write.
  leases.insertIgnore(ITEM, "alice");
  leases.insertIgnore(ITEM, "bob");

  assert.equal(leases.rowCount, 1, "PRIMARY KEY (item_id) permits one row");
  assert.equal(leases.holder(ITEM), "alice", "first writer wins; the second collides");

  // Read-back is race-free BECAUSE it is unique: it cannot name two agents.
  assert.equal(leases.holder(ITEM) === "bob", false, "the loser cannot confirm a win");
});

test("current design: order does not matter, only that one row survives", () => {
  for (const [first, second] of [["alice", "bob"], ["bob", "alice"]] as const) {
    const leases = new LeasesTable();
    leases.insertIgnore(ITEM, first);
    leases.insertIgnore(ITEM, second);
    assert.equal(leases.rowCount, 1);
    assert.equal(leases.holder(ITEM), first);
  }
});

test("re-latching your own lease is idempotent, not a race", () => {
  const leases = new LeasesTable();
  leases.insertIgnore(ITEM, "alice");
  leases.insertIgnore(ITEM, "alice"); // a restarted worker reclaiming its own hold
  assert.equal(leases.rowCount, 1);
  assert.equal(leases.holder(ITEM), "alice", "the holder reclaims rather than losing");
});

// ── schema + query guards (cheap, and they catch a regression at the source) ──

/** The DDL with `--` commentary stripped, so these guards read statements only. */
const DDL = readFileSync(new URL("../schema/mirror.sql", import.meta.url), "utf8")
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

/** The body of one CREATE TABLE, up to its ENGINE= clause. */
function ddlFor(table: string): string {
  const start = DDL.indexOf(`CREATE TABLE IF NOT EXISTS \`${table}\``);
  assert.notEqual(start, -1, `schema/mirror.sql must declare \`${table}\``);
  const block = DDL.slice(start);
  return block.slice(0, block.indexOf("ENGINE="));
}

test("schema declares the leases PK — the invariant is structural, not conventional", () => {
  assert.match(ddlFor("leases"), /PRIMARY KEY \(`item_id`\)/, "leases must be keyed on item_id alone");
});

test("the read plane derives the held set from leases, not from the claims log", () => {
  assert.match(SQL.leases, /FROM leases/, "ready-queue exclusion reads the lease table");
  assert.doesNotMatch(SQL.leases, /claims/, "claims is history; it must not gate scheduling");
});

test("claims stays an append-only record and carries a close-out column", () => {
  const body = ddlFor("claims");
  assert.match(body, /`released_at` datetime/, "a claim row must record a complete interval");
  assert.doesNotMatch(body, /UNIQUE/, "claims is a log — uniqueness lives in leases");
});
