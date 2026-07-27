/**
 * triage-coverage — how much of the schedulable board is actually triaged.
 *
 *   node scripts/triage-coverage.ts          # human table
 *   node scripts/triage-coverage.ts --json   # machine
 *
 * The prioritizer is only as honest as its inputs: an item without declared
 * effort/value ranks by the kind+unblocks+age fallback, and a queue that is
 * mostly fallback is near-FIFO wearing a scoring function. This prints the
 * coverage number so triage debt is a metric that moves, not a vibe.
 *
 * REPORT, DON'T FAIL — deliberately. This runs in CI (schema-drift.yml) as an
 * informational step: a red build over an unfilled estimate teaches people to
 * fill in garbage, which is worse than a visible gap. Same projection habit as
 * the schema gate (make the live property visible on every run), softer verb.
 *
 * Reads the public DoltHub API: no credential, no GitHub budget, aggregate
 * queries only (immune to the 1000-row cap).
 */

import { query } from "../src/dolthub.ts";

interface Row {
  repository: string;
  total: number | string;
  declared: number | string;
  with_deps: number | string;
}

const rows = await query<Row>(
  `SELECT repository,
          COUNT(*) AS total,
          SUM(CASE WHEN effort > 0 AND value > 0 THEN 1 ELSE 0 END) AS declared,
          SUM(CASE WHEN EXISTS (SELECT 1 FROM item_deps d WHERE d.item_id = items.item_id) THEN 1 ELSE 0 END) AS with_deps
   FROM items WHERE status <> 'Done'
   GROUP BY repository ORDER BY total DESC`,
);

const n = (v: number | string) => Number(v);
const repos = rows.map((r) => ({
  repository: r.repository,
  total: n(r.total),
  declared: n(r.declared),
  withDeps: n(r.with_deps),
}));
const total = repos.reduce((s, r) => s + r.total, 0);
const declared = repos.reduce((s, r) => s + r.declared, 0);
const withDeps = repos.reduce((s, r) => s + r.withDeps, 0);
const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ total, declared, withDeps, repos }, null, 2));
} else {
  const w = (s: string, k: number) => s.padEnd(k).slice(0, k);
  console.log(`Front Desk — triage coverage (non-Done items; declared = effort AND value set)\n`);
  console.log(`  ${w("repo", 22)} ${w("items", 6)} ${w("declared", 9)} ${w("cov", 5)} deps`);
  for (const r of repos) {
    console.log(
      `  ${w(r.repository, 22)} ${w(String(r.total), 6)} ${w(String(r.declared), 9)} ${w(pct(r.declared, r.total), 5)} ${r.withDeps}`,
    );
  }
  console.log(`\n  org: ${declared}/${total} declared (${pct(declared, total)}); ${withDeps} items carry dep edges.`);
  if (declared < total) {
    console.log(
      `  Undeclared items rank by the fallback (near-FIFO). Frontmatter in the issue body\n` +
        `  declares them — templates in .github/ISSUE_TEMPLATE/ carry the block pre-filled.`,
    );
  }
}
