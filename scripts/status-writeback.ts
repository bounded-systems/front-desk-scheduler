/**
 * status-writeback — move a closed issue's board card to Done (#148).
 *
 *   node scripts/status-writeback.ts            # plan only, write nothing
 *   node scripts/status-writeback.ts --apply    # perform the mutations
 *
 * WHY THIS EXISTS
 * ---------------
 * `status-drift` detects the disagreement and its remediation line said "drag
 * the card" because, at the time, dragging was the only thing that could move
 * it: `src/board.ts` is query-only and a Claude Code session cannot reach
 * ProjectV2 at all (the egress proxy serves only a pinned set of PR-review
 * operations — see board-parity.yml for the verified 403s).
 *
 * But the blocker was never the *capability*. The Front Desk App holds
 * `organization_projects:write` — declared in broker-drift.yml's `min_perms_for`
 * and asserted by that lane on every run. What was missing was a window: a
 * workflow that mints that identity and performs the write on a caller's behalf.
 * This script is the inside of that window (board-writeback.yml), the same shape
 * as claim-ticket.yml (#61) and board-parity.yml (#58).
 *
 * WHY IT IS SAFE BY DEFAULT
 * -------------------------
 * Writing nothing unless `--apply` is passed is not ceremony. This is the only
 * script in the repo that mutates the live board, the board is the thing the
 * whole mirror is derived from, and a plan printed against real data is a
 * genuinely useful artifact on its own. The workflow's `apply` input defaults to
 * false for the same reason: the first dispatch shows you the diff.
 *
 * WHICH cards move is decided by `planWriteback` (src/writeback.ts) and nothing
 * is restated here — this file is transport, ids and reporting only (#59).
 *
 * READS: the drift set comes from the public DoltHub API (no credential). The
 * board read and the mutation need `GH_TOKEN` to be the Front Desk App token.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { query } from "../src/dolthub.ts";
import { SQL } from "../src/scheduling.ts";
import { DEFAULT_ORG, DEFAULT_PROJECT, BOARD_FIELDS, fetchBoardItemsCheapRaw, normalize } from "../src/board.ts";
import type { BoardItem } from "../src/board.ts";
import { DONE, planWriteback } from "../src/writeback.ts";
import type { DriftRow, PlannedWrite } from "../src/writeback.ts";

const pexecFile = promisify(execFile);
const apply = process.argv.includes("--apply");

/**
 * The Status field's id and its "Done" option id, resolved once per run.
 *
 * `field(name:)` rather than a hardcoded id: the ids are project-scoped opaque
 * strings, and pinning them in source would make a field rebuild a silent
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
  readonly doneOptionId: string;
}

async function gh(args: string[]): Promise<unknown> {
  const { stdout } = await pexecFile("gh", args, { maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function resolveFieldIds(org: string, project: number): Promise<FieldIds> {
  const data = await gh([
    "api", "graphql", "-f", `query=${FIELD_QUERY}`,
    "-F", `org=${org}`, "-F", `num=${project}`,
  ]) as {
    data?: { organization?: { projectV2?: {
      id?: string;
      field?: { id?: string; options?: { id: string; name: string }[] } | null;
    } | null } | null };
  };

  const pv2 = data.data?.organization?.projectV2;
  const projectId = pv2?.id;
  const fieldId = pv2?.field?.id;
  const doneOptionId = pv2?.field?.options?.find((o) => o.name === DONE)?.id;

  // Each of these is a different failure and none of them should read as "no
  // drift". A renamed Status field returns a null `field`; a renamed option
  // returns options that simply lack "Done".
  if (!projectId) throw new Error(`project ${org}#${project} not readable — is GH_TOKEN the Front Desk App token?`);
  if (!fieldId) throw new Error(`no single-select field named "${BOARD_FIELDS.status}" on the project`);
  if (!doneOptionId) throw new Error(`"${BOARD_FIELDS.status}" has no option named "${DONE}"`);
  return { projectId, fieldId, doneOptionId };
}

async function writeOne(ids: FieldIds, w: PlannedWrite): Promise<void> {
  await gh([
    "api", "graphql", "-f", `query=${MUTATION}`,
    "-F", `project=${ids.projectId}`, "-F", `item=${w.itemId}`,
    "-F", `field=${ids.fieldId}`, "-F", `option=${ids.doneOptionId}`,
  ]);
}

function verdict(fields: Record<string, unknown>): void {
  // One greppable line, so a session reads the outcome from the job log without
  // downloading the summary. Mirrors FDS-CLAIM-RESULT (#61) and FDS-PARITY-RESULT.
  console.log(`FDS-WRITEBACK-RESULT ${JSON.stringify(fields)}`);
}

const rows = await query<DriftRow>(SQL.statusDrift);

// The board read is the expensive half (~14 GraphQL points, the cheap paged
// query). Skip it when there is nothing that could possibly be written.
const derivable = rows.filter((r) => r.closed_at);
if (derivable.length === 0) {
  console.log(`status-writeback: no closed-issue drift — ${rows.length} row(s) reported, none derivable`);
  verdict({ mode: apply ? "apply" : "dry-run", drift: rows.length, planned: 0, written: 0, failed: 0, skipped: rows.length });
  process.exit(0);
}

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
  verdict({ mode: apply ? "apply" : "dry-run", drift: rows.length, planned: null, written: 0, failed: 0, error: "board-read" });
  process.exit(1);
}

const plan = planWriteback(rows, board);

for (const s of plan.skipped) console.log(`  skip  ${s.ref} — ${s.reason}`);
for (const w of plan.writes) console.log(`  move  ${w.ref}  "${w.from}" → "${DONE}"  (closed ${w.closedAt})`);

if (plan.writes.length === 0) {
  console.log(`\nstatus-writeback: nothing to write (${plan.skipped.length} skipped)`);
  verdict({ mode: apply ? "apply" : "dry-run", drift: rows.length, planned: 0, written: 0, failed: 0, skipped: plan.skipped.length });
  process.exit(0);
}

if (!apply) {
  console.log(`\nstatus-writeback: ${plan.writes.length} card(s) would move. Re-run with --apply to write.`);
  verdict({ mode: "dry-run", drift: rows.length, planned: plan.writes.length, written: 0, failed: 0, skipped: plan.skipped.length });
  process.exit(0);
}

const ids = await resolveFieldIds(DEFAULT_ORG, DEFAULT_PROJECT);
let written = 0;
const failures: string[] = [];
for (const w of plan.writes) {
  try {
    await writeOne(ids, w);
    written++;
    console.log(`  ✓ ${w.ref} → ${DONE}`);
  } catch (e) {
    // Per-item, because a partial success is a real outcome worth recording:
    // the cards that moved stay moved, and the next run re-plans only the rest.
    failures.push(w.ref);
    console.error(`  ✗ ${w.ref} — ${(e as Error).message}`);
  }
}

console.log(`\nstatus-writeback: ${written}/${plan.writes.length} card(s) moved to ${DONE}`);
verdict({
  mode: "apply",
  drift: rows.length,
  planned: plan.writes.length,
  written,
  failed: failures.length,
  skipped: plan.skipped.length,
});
process.exit(failures.length === 0 ? 0 : 1);
