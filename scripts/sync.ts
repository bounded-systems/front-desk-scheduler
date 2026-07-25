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
  console.error(`sync GATED: ${res.reason} (budget resets ${res.resetAt})`);
  process.exit(3);
}
console.log(`synced ${res.items} items → ${res.commit}`);
console.log(`GraphQL cost: ${res.costPoints} points (${res.remaining} remaining this hour)`);
