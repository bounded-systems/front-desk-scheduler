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
import { resolveClaimPlane } from "../src/claim-plane.ts";

const ITEM = process.env.RACE_ITEM ?? "race#1";
const AGENTS = Number(process.env.RACE_AGENTS ?? 16);

// WHICH PLANE IS BEING MEASURED. The whole point of this script is that the
// answer is not assumed: it refuses on `local`, where there is nothing to
// measure (one process, one clone), and reports the plane it is about to race
// so a green result cannot be read as being about a topology it never touched.
const PLANE = resolveClaimPlane();
if (PLANE.name === "local") {
  console.error(
    "claim-race: the LOCAL plane is selected, and racing it would measure nothing —\n" +
      "  one process against one clone. Set FDS_CLAIM_ENDPOINT (a deployed worker/lease)\n" +
      "  or DOLT_HOST (a shared dolt sql-server).",
  );
  process.exit(2);
}

// Clean slate: a previous run (or a crashed one) may have left a live lease.
// Zero winners against a held item is S1 WORKING, not failing, so the test must
// start from a known-free item to measure anything.
if (PLANE.name === "server") {
  const { writeAndCommit } = await import("../src/dolt-server.ts");
  await writeAndCommit(
    [`DELETE FROM leases WHERE item_id = '${ITEM.replaceAll("'", "''")}'`],
    "claim-race: reset item",
    "claim-race <race@front-desk>",
  );
} else {
  // The DO has no bulk delete, and forcing one would mean an endpoint whose
  // only purpose is to break exclusion on demand. Wait the lease out instead —
  // slower, and it exercises expiry rather than bypassing it.
  const { claimLease, releaseLeaseRemote } = await import("../src/lease-client.ts");
  const probe = await claimLease(ITEM, "claim-race-reset", 1);
  if (probe.granted) await releaseLeaseRemote(ITEM, "claim-race-reset", probe.fencing);
  else {
    console.error(`claim-race: ${ITEM} is held by ${probe.holder ?? "someone"}; waiting for it to lapse`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

let failures = 0;
let s1Violation = false;
function check(cond: boolean, label: string): void {
  console.log(`  ${cond ? "ok " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

/** Winner agent → the fencing token it was granted (null on the Dolt planes). */
const fenceOf = new Map<string, number | null>();

async function race(tag: string, ttlSec: number): Promise<string | null> {
  const results = await Promise.all(
    Array.from({ length: AGENTS }, (_, i) => claimNext(`${tag}-${i}`, [ITEM], ttlSec)),
  );
  results.forEach((r, i) => { if (r.won) fenceOf.set(`${tag}-${i}`, r.fencing ?? null); });
  // Fencing tokens must be UNIQUE across grants. On a fenced plane two winners
  // sharing a token would mean the counter is not doing its job even if
  // exclusion happened to hold — a distinct failure from a double-claim.
  if (PLANE.fenced) {
    const granted = results.filter((r) => r.won).map((r) => r.fencing);
    check(granted.every((f) => typeof f === "number" && f > 0), `${tag}: every grant carried a fencing token`);
    check(new Set(granted).size === granted.length, `${tag}: no two grants shared a token`);
  }
  const winners = results.filter((r) => r.won);
  if (winners.length > 1) s1Violation = true; // >1 = double-claim; 0 = setup problem, not S1
  check(winners.length === 1, `${tag}: exactly one of ${AGENTS} concurrent claimants won (got ${winners.length}${winners.length === 0 ? " — item already held? setup issue, not an S1 violation" : ""})`);
  const losers = results.filter((r) => !r.won);
  check(losers.length === AGENTS - 1, `${tag}: every other claimant observed a loss`);
  return winners[0]?.itemId ? `${tag}-${results.findIndex((r) => r.won)}` : null;
}

const where = PLANE.name === "lease"
  ? (process.env.FDS_CLAIM_ENDPOINT ?? "?")
  : `${process.env.DOLT_HOST}:${process.env.DOLT_PORT ?? "3307"}`;
console.log(`claim-race: ${AGENTS} agents, item ${ITEM}, plane ${PLANE.name} @ ${where}`);
console.log(`  guarantee: ${PLANE.guarantee}`);

console.log("phase 1 — RACE (cold item)");
const w1 = await race("r1", 60);
check(w1 !== null, "r1: a winner exists");

console.log("phase 2 — HANDOFF (release, race again)");
if (w1) await releaseClaim(ITEM, w1, "completed", fenceOf.get(w1));
const w2 = await race("r2", 60);
check(w2 !== null, "r2: a winner exists after release");
check(w2 === null || !w2.startsWith("r1"), "r2: the new winner is from the second wave");

console.log("phase 3 — ZOMBIE (lapsed holder must learn it lost)");
if (w2) await releaseClaim(ITEM, w2, "completed", fenceOf.get(w2));
const zomb = await claimNext("zombie", [ITEM], 1); // 1s TTL — lapses immediately
fenceOf.set("zombie", zomb.fencing ?? null);
check(zomb.won, "zombie: claimed with a 1s lease");
await new Promise((r) => setTimeout(r, 2500)); // let the lease lapse
const taker = await claimNext("taker", [ITEM], 60); // reaps the corpse, latches
fenceOf.set("taker", taker.fencing ?? null);
check(taker.won, "taker: claimed the item after the zombie's lease lapsed");
const renewed = await renewLease(ITEM, "zombie", undefined, fenceOf.get("zombie"));
check(renewed === false, "zombie: renewLease returns false — the stop signal a lapsed holder must get");
const takerStill = await renewLease(ITEM, "taker", undefined, fenceOf.get("taker"));
check(takerStill === true, "taker: still holds and can heartbeat");
await releaseClaim(ITEM, "taker", "completed", fenceOf.get("taker")); // leave the item free
if (PLANE.fenced) {
  const zf = fenceOf.get("zombie"), tf = fenceOf.get("taker");
  // The takeover must OUT-FENCE the corpse, or a sink cannot tell them apart.
  check(typeof zf === "number" && typeof tf === "number" && tf > zf,
    `fencing: the taker out-fences the zombie (${zf} → ${tf})`);

  console.log("phase 4 — AUDIT (history must agree with the grants this race observed)");
  // The projection derives from the DO's history, so history disagreeing with
  // what the racers experienced would mean the audit trail lies at the source
  // — a defect no downstream idempotency could repair.
  const { fetchLeaseHistory } = await import("../src/lease-client.ts");
  const { records } = await fetchLeaseHistory(ITEM);
  const byFencing = new Map(records.map((r) => [r.fencing, r]));
  check(new Set(records.map((r) => r.fencing)).size === records.length,
    "audit: no fencing ordinal appears twice in history");
  let matched = 0;
  for (const [agent, f] of fenceOf) {
    if (typeof f !== "number") continue;
    const rec = byFencing.get(f);
    // On an authenticated worker the recorded agent is NAMESPACED under the
    // verified identity ("login/alias") — the alias this race asserted is the
    // suffix. Accept either exact (mode none) or namespaced (mode github);
    // anything else is a misattribution.
    if (rec && (rec.agent === agent || rec.agent.endsWith(`/${agent}`))) matched++;
    else check(false, `audit: grant ${f} (${agent}) missing or misattributed in history (got ${rec?.agent})`);
  }
  check(matched === [...fenceOf.values()].filter((f) => typeof f === "number").length,
    `audit: every observed grant appears in history exactly as granted (${matched} matched)`);
  const zrec = typeof zf === "number" ? byFencing.get(zf) : undefined;
  check(zrec?.status === "expired",
    `audit: the zombie's interval is closed as expired (got ${zrec?.status})`);
  const trec = typeof tf === "number" ? byFencing.get(tf) : undefined;
  check(trec?.status === "completed",
    `audit: the taker's interval is closed as completed (got ${trec?.status})`);
}

if (failures > 0) {
  console.error(
    s1Violation
      ? `\nclaim-race: ${failures} FAILURE(S) — INCLUDING A DOUBLE-CLAIM. S1 is not holding on this server.`
      : `\nclaim-race: ${failures} failure(s) — no double-claim observed; likely test-setup or liveness, inspect above.`,
  );
  process.exit(1);
}
console.log("\nclaim-race: all checks passed — A1 holds empirically on this server.");
