/**
 * schema-export — project the DEPLOYED mirror schema into a checked-in artifact.
 *
 *   node scripts/schema-export.ts            # write schema/mirror.live.sql
 *   node scripts/schema-export.ts --check    # fail (exit 1) if the file has drifted
 *
 * WHY THIS EXISTS
 * ---------------
 * The 2026-07-27 S1 bug lived exactly where a projection didn't. `items`,
 * `claims`, `item_deps` existed only in the deployed DoltHub database — nothing
 * in the repo said what shape they had, so nothing could review a change to that
 * shape, and the absence of a unique index was invisible until someone went
 * looking. The habitat was the gap, not the SQL.
 *
 * This closes it with the api-extractor pattern (also buf breaking,
 * cargo-public-api, golden files): make the semantic object a FILE. Emit a
 * deterministic projection of the live schema, check it in, fail CI on drift,
 * and put CODEOWNERS on the directory. Path-granular ownership then acquires
 * semantic granularity for free — any change to the deployed schema, by any
 * route, shows up as a diff on an owned file.
 *
 * Note the two artifacts are NOT the same thing and the difference is load-bearing:
 *
 *   schema/mirror.sql        INTENT   — hand-written, commented, the schema of
 *                                       record applied to a fresh mirror
 *   schema/mirror.live.sql   REALITY  — generated, the projection of what is
 *                                       actually deployed right now
 *
 * Drift between the file and the live database fails the build. Drift between
 * INTENT and REALITY is reported, not failed — that is a pending migration, which
 * is a legitimate state to be in (and one worth seeing in CI rather than in a
 * PR-body footnote).
 *
 * Reads via the public DoltHub HTTP API: no credential, no dolt binary, and no
 * GitHub rate-limit budget — so this is safe to run on every PR and on a
 * schedule (the schedule is what catches an out-of-band edit made with no PR
 * attached to it at all).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { query } from "../src/dolthub.ts";

const OUT = new URL("../schema/mirror.live.sql", import.meta.url).pathname;
const INTENT = new URL("../schema/mirror.sql", import.meta.url).pathname;

const HEADER = `-- GENERATED — do not edit by hand.
--
-- The projection of the DEPLOYED bounded-systems/front-desk-mirror schema, as
-- read from the public DoltHub SQL API. Regenerate with:
--
--     node scripts/schema-export.ts
--
-- CI fails when this file and the live database disagree, so a change to the
-- deployed schema cannot land without a diff here for its owner to review.
-- Hand-written intent (with the rationale) lives in schema/mirror.sql.
`;

/**
 * Canonicalise one SHOW CREATE TABLE result so the projection is a pure function
 * of the schema. AUTO_INCREMENT's current counter is table STATE, not shape, and
 * changes on every insert — strip it or the file drifts on its own. The table
 * option is the only ` AUTO_INCREMENT=<n>` form; a column's is bare, so this
 * cannot catch the column attribute.
 */
function canonical(ddl: string): string {
  return ddl
    .replace(/ AUTO_INCREMENT=\d+/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
}

/** Table names declared in the hand-written intent file. */
function intentTables(): Set<string> {
  const sql = readFileSync(INTENT, "utf8");
  const names = [...sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? `([^`]+)`/g)].map((m) => m[1]);
  return new Set(names);
}

async function project(): Promise<{ sql: string; tables: string[] }> {
  const rows = await query<Record<string, string>>("SHOW TABLES");
  // The column is named `Tables_in_<db>`; take the sole value rather than guess it.
  const tables = rows.map((r) => Object.values(r)[0]).filter(Boolean).sort();

  const blocks: string[] = [];
  for (const t of tables) {
    const res = await query<Record<string, string>>(`SHOW CREATE TABLE \`${t}\``);
    const ddl = res[0]?.["Create Table"];
    if (!ddl) throw new Error(`no CREATE TABLE returned for ${t}`);
    blocks.push(`${canonical(ddl)};`);
  }
  return { sql: `${HEADER}\n${blocks.join("\n\n")}\n`, tables };
}

/** Minimal line diff — enough to point at the drift without a dependency. */
function report(expected: string, actual: string): void {
  const e = expected.split("\n");
  const a = actual.split("\n");
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) console.error(`  -${e[i]}`);
      if (a[i] !== undefined) console.error(`  +${a[i]}`);
    }
  }
}

const { sql, tables } = await project();

// Informational: a table in intent but not deployed is a migration waiting to be
// applied. Not a failure — but it should be visible, since "the schema we wrote
// down is not the schema that is running" is precisely the condition that hid
// the S1 bug.
const missing = [...intentTables()].filter((t) => !tables.includes(t)).sort();
if (missing.length > 0) {
  console.error(
    `note: declared in schema/mirror.sql but NOT deployed: ${missing.join(", ")}` +
      ` — a migration in schema/migrations/ is pending.`,
  );
}

if (process.argv.includes("--check")) {
  let onDisk: string;
  try {
    onDisk = readFileSync(OUT, "utf8");
  } catch {
    console.error(`schema drift: ${OUT} is missing. Run: node scripts/schema-export.ts`);
    process.exit(1);
  }
  if (onDisk !== sql) {
    console.error("schema drift: the deployed mirror no longer matches schema/mirror.live.sql.");
    console.error("  (-) checked in   (+) deployed\n");
    report(onDisk, sql);
    console.error("\nRegenerate and commit: node scripts/schema-export.ts");
    process.exit(1);
  }
  console.log(`schema/mirror.live.sql matches the deployed mirror (${tables.length} tables).`);
} else {
  writeFileSync(OUT, sql);
  console.log(`wrote schema/mirror.live.sql (${tables.length} tables: ${tables.join(", ")})`);
}
