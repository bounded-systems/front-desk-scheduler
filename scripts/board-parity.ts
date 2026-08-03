/**
 * board-parity — prove the cheap board query returns the SAME board as the
 * legacy one, and measure what each actually costs.
 *
 * The cheap query (`fieldValueByName`) is a drop-in for `gh project item-list`,
 * but "drop-in" is a claim about a live project's field names, which no unit
 * test can check. This runs both against the real board, diffs every normalized
 * field, and prints the measured GraphQL cost of each.
 *
 *   node scripts/board-parity.ts
 *
 * Exit 0 = identical (safe to rely on the cheap path), 1 = differences found.
 */

import { fetchBoardItemsCheap, normalize, type BoardItem, type RawBoardItem } from "../src/board.ts";
import { fetchGraphqlLimit } from "../src/mirror.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** The legacy path, called directly so this script measures it in isolation. */
async function fetchLegacy(): Promise<BoardItem[]> {
  const { stdout } = await pexecFile("gh", [
    "project", "item-list", "2",
    "--owner", "bounded-systems", "--format", "json", "--limit", "2000",
  ], { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { items?: RawBoardItem[] };
  return (parsed.items ?? []).map(normalize).filter((x): x is BoardItem => x !== null);
}

async function measure<T>(label: string, fn: () => Promise<T>): Promise<{ out: T; cost: number }> {
  const before = await fetchGraphqlLimit();
  const out = await fn();
  const after = await fetchGraphqlLimit();
  const cost = Math.max(before.remaining - after.remaining, 0);
  console.log(`${label}: ${cost} GraphQL points`);
  return { out, cost };
}

const cheap = await measure("cheap  (fieldValueByName)", () => fetchBoardItemsCheap());
const legacy = await measure("legacy (project item-list)", () => fetchLegacy());

if (!cheap.out) {
  console.error("cheap query returned null — it is NOT safe to rely on it");
  process.exit(1);
}

const saved = legacy.cost - cheap.cost;
const pct = legacy.cost > 0 ? Math.round((saved / legacy.cost) * 100) : 0;
console.log(`saving: ${saved} points per sync (${pct}%)\n`);

const byId = new Map(legacy.out.map((i) => [i.id, i]));
const diffs: string[] = [];

if (cheap.out.length !== legacy.out.length) {
  diffs.push(`item COUNT differs: cheap ${cheap.out.length} vs legacy ${legacy.out.length}`);
}

for (const c of cheap.out) {
  const l = byId.get(c.id);
  if (!l) {
    diffs.push(`${c.id} (${c.repository}#${c.number}): present in cheap, absent from legacy`);
    continue;
  }
  for (const f of ["number", "title", "repository", "status", "kind", "effort", "value"] as const) {
    if (c[f] !== l[f]) diffs.push(`${c.repository}#${c.number} ${f}: cheap=${JSON.stringify(c[f])} legacy=${JSON.stringify(l[f])}`);
  }
  if (JSON.stringify(c.dependsOn) !== JSON.stringify(l.dependsOn)) {
    diffs.push(`${c.repository}#${c.number} dependsOn: cheap=${JSON.stringify(c.dependsOn)} legacy=${JSON.stringify(l.dependsOn)}`);
  }
}
for (const l of legacy.out) {
  if (!cheap.out.some((c) => c.id === l.id)) {
    diffs.push(`${l.id} (${l.repository}#${l.number}): present in legacy, MISSING from cheap`);
  }
}

if (diffs.length === 0) {
  console.log(`PARITY OK — ${cheap.out.length} items identical across both paths`);
  process.exit(0);
}
console.error(`PARITY FAILED — ${diffs.length} difference(s):`);
for (const d of diffs.slice(0, 40)) console.error(`  ${d}`);
if (diffs.length > 40) console.error(`  … and ${diffs.length - 40} more`);
console.error("\nA systematic field difference usually means a project field was renamed —");
console.error("check BOARD_FIELDS in src/board.ts against the project's actual field names.");
process.exit(1);
