/**
 * status-drift — detect disagreement between the two completion authorities.
 *
 *   node scripts/status-drift.ts            # report, always exit 0
 *   node scripts/status-drift.ts --gate     # exit 1 if any disagreement exists
 *
 * WHY THIS EXISTS (front-desk-scheduler#89)
 * -----------------------------------------
 * An item's completion is recorded twice: the board card's Status column
 * ("Done"), and GitHub's open/close (`closed_at` — which authority.ts names
 * "realized completion (calibration ground truth)"). They usually agree. When
 * they don't, nothing said so: `.github#55` was closed on GitHub on 2026-07-08
 * with its card still reading "In Progress", and it ranked 8th in the ready
 * queue for 23 days before a session recognised it by eye.
 *
 * The queue itself no longer trusts the card for liveness — the schedulable
 * set (SCHEDULABLE in src/scheduling.ts) excludes any row with `closed_at`
 * set, so a dead item cannot rank however its card lies. But a resolved
 * disagreement is still a lying card on the live board, and a card that lies
 * one way today can lie the other way tomorrow. This script is the detector:
 * the same job env-check-drift does for the vendored script, done for the
 * board's two completion fields. It would have caught #55 in July.
 *
 * Both directions are drift:
 *   closed_at set, card ≠ Done   — dead work wearing a live card (#55's shape)
 *   card = Done, closed_at NULL  — board considers it complete; GitHub does not
 *
 * Scoped to origin='github': dolt-origin (hidden/planning) rows have no GitHub
 * issue for closed_at to disagree with.
 *
 * WHY REPORT AND GATE ARE SEPARATE MODES
 * --------------------------------------
 * The drift is a property of the DEPLOYED mirror, not of any tree. A PR
 * neither causes nor can fix it, so failing PRs on it would block unrelated
 * work on a card someone forgot to drag (schema-export --check gates PRs, but
 * there the tree CONTAINS the projection; here it contains nothing to fix).
 * The scheduled run is the one that gates — the way org-drift works — and its
 * red names the card to move.
 *
 * REMEDIATION IS NO LONGER ALWAYS BY HAND (#148)
 * ----------------------------------------------
 * This header used to end "which is the entire remediation", true only while
 * dragging was the sole way to move a card. `board-writeback.yml` now closes the
 * derivable half: a closed issue implies Done, so that direction is dispatched,
 * not dragged. The other direction stays manual on purpose — a Done card on an
 * open issue is a human claim, and no workflow should guess whether to close the
 * issue or move the card back. See src/writeback.ts for the asymmetry.
 *
 * Reads the public DoltHub SQL API via src/dolthub.ts: no credential, no
 * GitHub budget, no npm dependencies — safe in schema-drift.yml's no-install
 * job on every PR and on the daily schedule.
 */

import { query } from "../src/dolthub.ts";
import { SQL } from "../src/scheduling.ts";

interface DriftRow {
  repository: string;
  number: number | string | null;
  status: string;
  closed_at: string | null;
}

const gate = process.argv.includes("--gate");
const rows = await query<DriftRow>(SQL.statusDrift);

if (rows.length === 0) {
  console.log("status-drift: ✓ board Status and GitHub open/close agree on every item");
  process.exit(0);
}

console.log(`status-drift: ${rows.length} item(s) where the board card and GitHub disagree\n`);
for (const r of rows) {
  const ref = `${r.repository}#${r.number}`;
  if (r.closed_at) {
    console.log(`  ${ref}  card="${r.status}" but the issue CLOSED ${r.closed_at}`);
    console.log(`      → dispatch board-writeback.yml to move it to Done, or drag it by hand`);
    console.log(`        (derivable — the queue already refuses to rank it, see #89)`);
  } else {
    console.log(`  ${ref}  card="Done" but the issue is still OPEN on GitHub`);
    console.log(`      → close the issue, or move the card back if work remains`);
  }
}

if (gate) {
  console.log("\nstatus-drift: failing (--gate). The card is the thing to fix; the queue is already safe.");
  process.exit(1);
}
console.log("\nstatus-drift: report-only (no --gate) — the scheduled run is the one that fails on this.");
