/**
 * front-desk sync-delta — the cheap incremental refresh (#1).
 *
 * Uses the Search API (a separate rate-limit budget, NOT GraphQL) to refresh
 * only issues changed since the last sync. Routine cadence runs this; the full
 * scripts/sync.ts stays the weekly drift backstop (and the only thing that adds
 * brand-new items + rebuilds the relation/frontmatter graph).
 *
 *   node scripts/sync-delta.ts
 */

import { syncPullDelta } from "../src/mirror.ts";

const res = await syncPullDelta();
console.log(`delta: refreshed ${res.changed} changed item(s) since ${res.since} (0 GraphQL points).`);
if (res.newSeen > 0) {
  console.log(`  ${res.newSeen} newly-changed issue(s) not yet on the mirror — the weekly full sync will add them.`);
}
