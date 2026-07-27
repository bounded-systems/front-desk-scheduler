/**
 * triage-coverage — how much of the schedulable board is actually triaged.
 *
 *   node scripts/triage-coverage.ts          # human table
 *   node scripts/triage-coverage.ts --json   # machine
 *
 * The prioritizer is only as honest as its inputs, and there are TWO inputs that
 * can be missing independently:
 *
 *   scores  effort/value. Absent ⇒ the item ranks by the kind+unblocks+age
 *           fallback rather than a real WSJF density.
 *   edges   the dependency DAG. Absent ⇒ readiness gating is a no-op (everything
 *           is "ready") and the unblocks bonus contributes nothing, so the
 *           ranking degenerates toward value-density alone.
 *
 * Only GATING edges count toward the second. `item_deps` carries three kinds and
 * they are not interchangeable:
 *
 *   blocks, parent-child   gate readiness (src/scheduling.ts BLOCKER_KINDS)
 *   closes                 mined PR→issue PROVENANCE. Never gates anything.
 *
 * Counting all three together overstates DAG coverage badly — `closes` edges are
 * numerous and accrue automatically on completed work, so a board with zero real
 * dependencies still looks connected. They are reported separately here and
 * excluded from the coverage number.
 *
 * An edge also only gates if BOTH endpoints are still open: a dep on a Done item
 * is satisfied, so it constrains nothing. Hence the headline number is edges
 * between two non-Done items, plus the count of items they actually block.
 *
 * REPORT, DON'T FAIL — deliberately. This runs in CI (schema-drift.yml) as an
 * informational step: a red build over an unfilled estimate teaches people to
 * fill in garbage, which is worse than a visible gap.
 *
 * Reads the public DoltHub API: no credential, no GitHub budget, aggregate
 * queries only (immune to the 1000-row cap).
 */

import { query } from "../src/dolthub.ts";
import { BLOCKER_KINDS } from "../src/scheduling.ts";

/**
 * Edge kinds that gate readiness, taken FROM the scheduler rather than restated.
 * If BLOCKER_KINDS changes, this metric follows automatically — a second list
 * here would silently start measuring something the scheduler no longer does.
 */
const GATING = `(${[...BLOCKER_KINDS].map((k) => `'${k}'`).join(",")})`;
/** An edge constrains only while its target is still open. */
const LIVE_EDGE = (d = "d") =>
  `${d}.edge_type IN ${GATING} AND EXISTS (SELECT 1 FROM items t WHERE t.item_id = ${d}.dep_item_id AND t.status <> 'Done')`;

interface Row {
  repository: string;
  total: number | string;
  declared: number | string;
  blocked: number | string;
}

const n = (v: number | string | null) => Number(v ?? 0);

const [rows, edgeRows] = await Promise.all([
  query<Row>(
    `SELECT repository,
            COUNT(*) AS total,
            SUM(CASE WHEN effort > 0 AND value > 0 THEN 1 ELSE 0 END) AS declared,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM item_deps d WHERE d.item_id = items.item_id AND ${LIVE_EDGE()}
            ) THEN 1 ELSE 0 END) AS blocked
     FROM items WHERE status <> 'Done'
     GROUP BY repository ORDER BY total DESC`,
  ),
  // Edge census over the SCHEDULABLE set: both endpoints still open.
  query<{ edge_type: string; n: number | string }>(
    `SELECT d.edge_type, COUNT(*) AS n
     FROM item_deps d
     JOIN items s ON s.item_id = d.item_id
     JOIN items t ON t.item_id = d.dep_item_id
     WHERE s.status <> 'Done' AND t.status <> 'Done'
     GROUP BY d.edge_type`,
  ),
]);

const repos = rows.map((r) => ({
  repository: r.repository,
  total: n(r.total),
  declared: n(r.declared),
  blocked: n(r.blocked),
}));
const total = repos.reduce((s, r) => s + r.total, 0);
const declared = repos.reduce((s, r) => s + r.declared, 0);
const blocked = repos.reduce((s, r) => s + r.blocked, 0);

const edges = Object.fromEntries(edgeRows.map((r) => [r.edge_type, n(r.n)]));
const gatingEdges = (edges["blocks"] ?? 0) + (edges["parent-child"] ?? 0);
const provenanceEdges = edges["closes"] ?? 0;

const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ total, declared, blocked, gatingEdges, provenanceEdges, edges, repos }, null, 2),
  );
} else {
  const w = (s: string, k: number) => s.padEnd(k).slice(0, k);
  console.log(`Front Desk — triage coverage (non-Done items)\n`);
  console.log(`  ${w("repo", 22)} ${w("items", 6)} ${w("scored", 7)} ${w("cov", 5)} blocked`);
  for (const r of repos) {
    console.log(
      `  ${w(r.repository, 22)} ${w(String(r.total), 6)} ${w(String(r.declared), 7)} ${w(pct(r.declared, r.total), 5)} ${r.blocked}`,
    );
  }
  console.log(`\n  scores: ${declared}/${total} items declare effort AND value (${pct(declared, total)})`);
  console.log(
    `  edges:  ${gatingEdges} gating (blocks/parent-child, both endpoints open) → ${blocked}/${total} items blocked` +
      `\n          ${provenanceEdges} \`closes\` edges are mined PR provenance and gate nothing`,
  );

  if (declared < total) {
    console.log(
      `\n  ${total - declared} items rank on the kind+unblocks+age fallback. Declare effort/value in\n` +
        `  issue-body frontmatter — .github/ISSUE_TEMPLATE/ carries the block pre-filled.`,
    );
  }
  if (gatingEdges === 0) {
    console.log(
      `\n  ⚠ the dependency DAG is EMPTY over the schedulable set: nothing is gated, so\n` +
        `    readiness admits everything and the unblocks bonus is inert. The ranking is\n` +
        `    value-density alone — the scheduler's DAG machinery is idle.`,
    );
  } else if (blocked * 20 < total) {
    console.log(
      `\n  ⚠ the dependency DAG is nearly empty: ${blocked}/${total} items are gated by it.\n` +
        `    Readiness and the unblocks bonus are contributing almost nothing to the ranking.\n` +
        `    \`depends-on: [repo#n]\` in issue frontmatter is what populates it.`,
    );
  }
}
