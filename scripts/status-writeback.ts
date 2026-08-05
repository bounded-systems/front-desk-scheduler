/**
 * status-writeback — render the derived Status onto the live board (#148).
 *
 *   node scripts/status-writeback.ts            # plan only, write nothing
 *   node scripts/status-writeback.ts --apply    # perform the mutations
 *
 * WHY THIS EXISTS
 * ---------------
 * Status is a projection of state the system already holds — `closed_at` for
 * Done, the dependency graph for Blocked, a live lease for In Progress — but the
 * board card is where humans read it, and nothing wrote it back. `src/board.ts`
 * is query-only and a Claude Code session cannot reach ProjectV2 at all (the
 * egress proxy serves only a pinned set of PR-review operations; board-parity.yml
 * carries the verified 403s).
 *
 * The capability was never the blocker. The Front Desk App holds
 * `organization_projects:write` — declared in broker-drift.yml's `min_perms_for`
 * and asserted by that lane every run. What was missing was a window, and
 * board-writeback.yml is it: the same shape as claim-ticket.yml (#61) and
 * board-parity.yml (#58).
 *
 * WHAT IT READS, AND WHY BOTH READS PAGE
 * --------------------------------------
 * The derivation needs every item and every edge, not just the schedulable
 * subset — a Done row is exactly what confirms a dependency is satisfied. Both
 * are whole-table reads of tables that grow without bound, so both go through
 * `readPaged` (keyset, pinned with AS OF). `items` crossed the 1000-row cap in
 * July; #88 is the failure this avoids repeating.
 *
 * THE LEASE PLANE IS NOT READ, AND THAT IS SAFE
 * ---------------------------------------------
 * There is no batch route to the Durable Object — a DurableObjectNamespace
 * cannot be enumerated (#84) — so a whole-board pass cannot know who holds what.
 * It therefore passes `null` rather than an empty Set, and the two are NOT the
 * same: `deriveStatus` turns `null` into a refusal to touch "In Progress", where
 * an empty Set would assert "nothing is held" and downgrade every held card to
 * Todo. The #124 lesson, applied before it could bite.
 *
 * The practical consequence is bounded and worth stating plainly: this pass
 * derives Done and Blocked, preserves In Progress, and never promotes Todo →
 * In Progress. That component activates when #84 lands a batch lease route; the
 * rule for it is already written and tested in `deriveStatus`.
 *
 * WHY IT IS SAFE BY DEFAULT
 * -------------------------
 * `--apply` is required to write. This is the only path in the repo that mutates
 * the live board, the board is what the whole mirror derives from, and a plan
 * printed against real data is a useful artifact on its own.
 *
 * WHICH cards move is decided by `deriveStatus` + `planWriteback` and nothing is
 * restated here (#59) — this file is transport, ids and reporting.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readPaged } from "../src/dolthub.ts";
import { SQL } from "../src/scheduling.ts";
import { BOARD_FIELDS, DEFAULT_ORG, DEFAULT_PROJECT, fetchBoardItemsCheapRaw, normalize } from "../src/board.ts";
import type { BoardItem } from "../src/board.ts";
import { planWriteback } from "../src/writeback.ts";
import type { DepEdge, DerivationRow, PlannedWrite } from "../src/writeback.ts";

const pexecFile = promisify(execFile);
const apply = process.argv.includes("--apply");

/**
 * The Status field's id and its option ids, resolved once per run.
 *
 * `field(name:)` rather than hardcoded ids: they are project-scoped opaque
 * strings, and pinning them in source would turn a field rebuild into a silent
 * mismatch instead of a loud lookup failure. Same reasoning as BOARD_FIELDS.
 */
const FIELD_QUERY = `query($org:String!,$num:Int!){
  organization(login:$org){projectV2(number:$num){
    id
    field(name:"${BOARD_FIELDS.status}"){
      ... on ProjectV2SingleSelectField{ id options{ id name } }
    }
  }}
}`;

const MUTATION = `mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
  updateProjectV2ItemFieldValue(input:{
    projectId:$project, itemId:$item, fieldId:$field,
    value:{ singleSelectOptionId:$option }
  }){ projectV2Item{ id } }
}`;

interface FieldIds {
  readonly projectId: string;
  readonly fieldId: string;
  /** Status option name → option id. All four, since any of them can be written now. */
  readonly options: ReadonlyMap<string, string>;
}

async function gh(args: string[]): Promise<unknown> {
  const { stdout } = await pexecFile("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function resolveFieldIds(org: string, project: number): Promise<FieldIds> {
  const data = await gh([
    "api", "graphql", "-f", `query=${FIELD_QUERY}`,
    // -f for $org:String!, -F only for $num:Int! — see writeOne for why the
    // distinction is load-bearing rather than stylistic.
    "-f", `org=${org}`, "-F", `num=${project}`,
  ]) as {
    data?: { organization?: { projectV2?: {
      id?: string;
      field?: { id?: string; options?: { id: string; name: string }[] } | null;
    } | null } | null };
  };

  const pv2 = data.data?.organization?.projectV2;
  const projectId = pv2?.id;
  const fieldId = pv2?.field?.id;
  const options = new Map((pv2?.field?.options ?? []).map((o) => [o.name, o.id]));

  // Three different failures; none of them should read as "nothing to do".
  if (!projectId) throw new Error(`project ${org}#${project} not readable — is GH_TOKEN the Front Desk App token?`);
  if (!fieldId) throw new Error(`no single-select field named "${BOARD_FIELDS.status}" on the project`);
  if (options.size === 0) throw new Error(`"${BOARD_FIELDS.status}" returned no options`);
  return { projectId, fieldId, options };
}

async function writeOne(ids: FieldIds, w: PlannedWrite): Promise<void> {
  const option = ids.options.get(w.to);
  if (!option) throw new Error(`"${BOARD_FIELDS.status}" has no option named "${w.to}"`);
  await gh([
    "api", "graphql", "-f", `query=${MUTATION}`,
    // -f, NOT -F. `gh api graphql -F` does TYPED parsing: a value that looks
    // numeric is sent as a JSON number. Every variable here is ID! or String!,
    // and ProjectV2 single-select option ids are 8-character hex — so an
    // all-digits one (e.g. "98236657") is coerced to a number and the String!
    // variable rejects it, while a hex id containing a letter goes through.
    //
    // That is not a hypothetical either. Run 31020918592 wrote prx#972 →
    // "Blocked" successfully and failed BOTH → "Done" writes in the same pass:
    // one option id per target status, one of them all-digits. `-f` sends every
    // value as a string, which is what these variables are declared as.
    "-f", `project=${ids.projectId}`, "-f", `item=${w.itemId}`,
    "-f", `field=${ids.fieldId}`, "-f", `option=${option}`,
  ]);
}

function verdict(fields: Record<string, unknown>): void {
  // One greppable line, so a session reads the outcome from the job log without
  // downloading the summary. Mirrors FDS-CLAIM-RESULT (#61) and FDS-PARITY-RESULT.
  console.log(`FDS-WRITEBACK-RESULT ${JSON.stringify(fields)}`);
}

const mode = apply ? "apply" : "dry-run";

// Both reads page. Neither may become a bare whole-table query (#88).
const { rows, at } = await readPaged<DerivationRow>(SQL.derivationItems, ["item_id"]);
// typedEdges, not edges: the kind decides whether an edge gates, and `closes`
// never does. Reading the flattened list cost prx#972 a wrong "Blocked".
const { rows: edges } = await readPaged<DepEdge>(SQL.typedEdges, ["item_id", "dep_item_id"]);
console.log(`status-writeback: ${rows.length} item(s), ${edges.length} edge(s)${at ? ` @ ${at}` : ""}`);

let board: BoardItem[];
try {
  const raw = await fetchBoardItemsCheapRaw(DEFAULT_ORG, DEFAULT_PROJECT);
  if (!raw) throw new Error("board read returned nothing usable");
  board = raw.map(normalize).filter((x): x is BoardItem => x !== null);
} catch (e) {
  // Fail loud and name the likely cause. A window whose credential never arrives
  // fails on EVERY run, and #112 is what that looks like when nobody notices.
  console.error(`status-writeback: could not read the board — ${(e as Error).message}`);
  console.error("  GH_TOKEN must be the Front Desk App token (ProjectV2 is not served to a session).");
  verdict({ mode, items: rows.length, planned: null, written: 0, failed: 0, error: "board-read" });
  process.exit(1);
}

// null, not an empty Set — see the header. This is the #84 boundary.
const plan = planWriteback(rows, edges, board, null);

for (const s of plan.skipped) console.log(`  skip  ${s.ref} — ${s.reason}`);
for (const w of plan.writes) console.log(`  move  ${w.ref}  "${w.from}" → "${w.to}"  (${w.because})`);

if (plan.writes.length === 0) {
  console.log(`\nstatus-writeback: board already matches the derivation (${plan.skipped.length} skipped)`);
  verdict({ mode, items: rows.length, planned: 0, written: 0, failed: 0, skipped: plan.skipped.length });
  process.exit(0);
}

if (!apply) {
  console.log(`\nstatus-writeback: ${plan.writes.length} card(s) would move. Re-run with --apply to write.`);
  verdict({ mode, items: rows.length, planned: plan.writes.length, written: 0, failed: 0, skipped: plan.skipped.length });
  process.exit(0);
}

const ids = await resolveFieldIds(DEFAULT_ORG, DEFAULT_PROJECT);
let written = 0;
const failures: string[] = [];
for (const w of plan.writes) {
  try {
    await writeOne(ids, w);
    written++;
    console.log(`  ✓ ${w.ref} → ${w.to}`);
  } catch (e) {
    // Per-item, because partial success is a real outcome: the cards that moved
    // stay moved, and the next run re-plans only the rest.
    failures.push(w.ref);
    console.error(`  ✗ ${w.ref} — ${(e as Error).message}`);
  }
}

console.log(`\nstatus-writeback: ${written}/${plan.writes.length} card(s) written`);
verdict({
  mode: "apply",
  items: rows.length,
  planned: plan.writes.length,
  written,
  failed: failures.length,
  skipped: plan.skipped.length,
});
process.exit(failures.length === 0 ? 0 : 1);
