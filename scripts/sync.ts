/**
 * front-desk sync — the ONE GitHub read in the architecture.
 *
 * Pulls the live board into the Dolt mirror as a single commit, metering actual
 * GraphQL cost (measured, not guessed) and fail-closing through budgetGate when
 * the hourly API budget can't afford it.
 *
 *   node scripts/sync.ts
 */

import { syncPull } from "../src/mirror.ts";

const res = await syncPull();
if (res.gated) {
  console.error(
    `sync GATED: ${res.reason} — ${res.remaining}/${res.limit} GraphQL points remaining, ` +
      `need ~${res.estimatePoints} (budget resets ${res.resetAt})`,
  );
  process.exit(3);
}
console.log(`synced ${res.items} items → ${res.commit}`);
console.log(`GraphQL cost: ${res.costPoints} points (${res.remaining} remaining this hour)`);
for (const f of res.shapeFindings) {
  console.log(`shape ${f.id} [${f.severity}]: ${f.message}`);
}
// Hard shape violations (e.g. a dependency cycle) fail the run so the workflow
// goes red — the data is still committed for inspection; the alarm is the point.
if (res.shapeFindings.some((f) => f.severity === "hard")) {
  console.error("hard shape violation — board data breaks a scheduler invariant");
  process.exit(4);
}
