/**
 * claim-race — the empirical A1/A2 test: real agents race a real dolt sql-server.
 *
 *   DOLT_HOST=127.0.0.1 DOLT_PORT=3311 DOLT_DB=mirror node scripts/claim-race.ts
 *
 * specs/tla proves an atomic CAS upholds S1; specs/rust proves it over real
 * atomics; specs/lean proves it over all schedules. All three ASSUME the engine
 * makes `INSERT IGNORE` atomic against the PRIMARY KEY (assumption A1 in
 * Leases.lean). Nothing had ever tested that assumption against a running
 * dolt sql-server under genuine concurrency — and "a proof whose precondition
 * the implementation quietly fails to satisfy" is exactly how the original S1
 * bug happened. This script is the missing experiment. It exits non-zero on any
 * violation, so CI can gate on it.
 *
 * Three phases, each aimed at a specific way the claim path could be wrong:
 *
 *   1. RACE     — N agents claim the same item concurrently through the seam.
 *                 Exactly one may win; the table must hold exactly one row.
 *   2. HANDOFF  — the winner releases; N agents race again. Exactly one new
 *                 winner (freeing works; no stale exclusion).
 *   3. ZOMBIE   — a short-TTL lease lapses while its holder is "working"; a new
 *                 agent claims; the old holder's renewLease must return false.
 *                 That false is the queue-side half of fencing: the signal a
 *                 lapsed holder gets to STOP. (The effect-side half — the sink
 *                 refusing a stale token — is keeperd's, proven in Leases.lean
 *                 as fencing_excludes, implemented separately.)
 *
 * Requires DOLT_HOST — running this against the local-clone fallback would test
 * nothing (single process, single clone). It refuses rather than green-washing.
 */

import { claimNext, releaseClaim, renewLease } from "../src/mirror.ts";
import { writeAndCommit } from "../src/dolt-server.ts";

const ITEM = process.env.RACE_ITEM ?? "race#1";
const AGENTS = Number(process.env.RACE_AGENTS ?? 16);

if (!process.env.DOLT_HOST) {
  console.error("claim-race: DOLT_HOST is unset — this test only means something against a real sql-server.");
  process.exit(2);
}

// Clean slate: a previous run (or crashed run) may have left a live lease on
// the item. Zero winners against a held item is S1 WORKING, not failing — so
// the test must start from a known-free item to measure anything.
await writeAndCommit(
  [`DELETE FROM leases WHERE item_id = '${ITEM.replaceAll("'", "''")}'`],
  "claim-race: reset item",
  "claim-race <race@front-desk>",
);

let failures = 0;
let s1Violation = false;
function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function race(tag: string, ttlSec: number): Promise<string | null> {
  const results = await Promise.all(
    Array.from({ length: AGENTS }, (_, i) => claimNext(`${tag}-${i}`, [ITEM], ttlSec)),
  );
  const winners = results.filter((r) => r.won);
  if (winners.length > 1) s1Violation = true; // >1 = double-claim; 0 = setup problem, not S1
  check(winners.length === 1, `${tag}: exactly one of ${AGENTS} concurrent claimants won (got ${winners.length}${winners.length === 0 ? " — item already held? setup issue, not an S1 violation" : ""})`);
  const losers = results.filter((r) => !r.won);
  check(losers.length === AGENTS - 1, `${tag}: every other claimant observed a loss`);
  return winners[0]?.itemId ? `${tag}-${results.findIndex((r) => r.won)}` : null;
}

console.log(`claim-race: ${AGENTS} agents, item ${ITEM}, server ${process.env.DOLT_HOST}:${process.env.DOLT_PORT ?? "3307"}`);

console.log("phase 1 — RACE (cold item)");
const w1 = await race("r1", 60);
check(w1 !== null, "r1: a winner exists");

console.log("phase 2 — HANDOFF (release, race again)");
if (w1) await releaseClaim(ITEM, w1, "completed");
const w2 = await race("r2", 60);
check(w2 !== null, "r2: a winner exists after release");
check(w2 === null || !w2.startsWith("r1"), "r2: the new winner is from the second wave");

console.log("phase 3 — ZOMBIE (lapsed holder must learn it lost)");
if (w2) await releaseClaim(ITEM, w2, "completed");
const zomb = await claimNext("zombie", [ITEM], 1); // 1s TTL — lapses immediately
check(zomb.won, "zombie: claimed with a 1s lease");
await new Promise((r) => setTimeout(r, 2500)); // let the lease lapse
const taker = await claimNext("taker", [ITEM], 60); // reaps the corpse, latches
check(taker.won, "taker: claimed the item after the zombie's lease lapsed");
const renewed = await renewLease(ITEM, "zombie");
check(renewed === false, "zombie: renewLease returns false — the stop signal a lapsed holder must get");
const takerStill = await renewLease(ITEM, "taker");
check(takerStill === true, "taker: still holds and can heartbeat");
await releaseClaim(ITEM, "taker", "completed"); // leave the item free for the next run

if (failures > 0) {
  console.error(
    s1Violation
      ? `\nclaim-race: ${failures} FAILURE(S) — INCLUDING A DOUBLE-CLAIM. S1 is not holding on this server.`
      : `\nclaim-race: ${failures} failure(s) — no double-claim observed; likely test-setup or liveness, inspect above.`,
  );
  process.exit(1);
}
console.log("\nclaim-race: all checks passed — A1 holds empirically on this server.");
