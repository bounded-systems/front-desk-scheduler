/**
 * front-desk estimate — DRY RUN by default.
 *
 * Fetches the live board, applies the heuristic estimator to fill Effort/Value,
 * and shows the ranked ready queue BEFORE (empty inputs → degenerate) vs AFTER
 * (estimated → WSJF). Writes NOTHING unless `--apply` is passed (guarded).
 *
 *   node scripts/estimate.ts [--repo <name>] [--top N] [--budget <id>]
 *   node scripts/estimate.ts --apply        # (gated) writes Effort/Value to the board
 */

import {
  fetchBoardItems,
  fetchProjectMeta,
  setNumberField,
  toPriorityInputs,
  type BoardItem,
} from "../src/board.ts";
import { estimate } from "../src/estimate.ts";
import { prioritize, ROLLING_5H_BUDGET, ORG_BUDGETS, type PriorityInput } from "../src/policy.ts";

function rank(inputs: PriorityInput[], remaining: number) {
  return prioritize(inputs, remaining).filter((r) => r.eligible);
}

function withEstimates(items: readonly BoardItem[]): BoardItem[] {
  return items.map((i) =>
    i.effort > 0 || i.value > 0 ? i : { ...i, ...pick(estimate(i.kind, i.title)) }
  );
}
function pick(e: { effort: number; value: number }) {
  return { effort: e.effort, value: e.value };
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const repo = argv[argv.indexOf("--repo") + 1] && argv.includes("--repo") ? argv[argv.indexOf("--repo") + 1] : undefined;
  const top = argv.includes("--top") ? Number(argv[argv.indexOf("--top") + 1]) : 12;
  const budget = ORG_BUDGETS.get(argv.includes("--budget") ? argv[argv.indexOf("--budget") + 1] : ROLLING_5H_BUDGET.id) ?? ROLLING_5H_BUDGET;
  const remaining = budget.capacityPoints;

  // Read from cache (item ids are stable); only the writes below spend live budget.
  const board = await fetchBoardItems(undefined, undefined, undefined, 30);
  const scoped = repo ? board.filter((i) => i.repository === repo) : board;

  const before = rank(toPriorityInputs(scoped), remaining);
  const estimated = withEstimates(scoped);
  const after = rank(toPriorityInputs(estimated), remaining);

  const label = repo ? `in ${repo}` : "across the org";
  console.log(`Front Desk — estimate (DRY RUN)   ${label}   eligible=${before.length}\n`);

  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  const line = (r: (typeof after)[number]) => {
    const b = board.find((x) => x.number === r.number);
    return `  ${w("#" + r.number, 6)} ${w(b?.repository ?? "?", 15)} ${w(r.kind, 5)} eff=${w(String(r.effort), 3)} val=${w(String(r.value), 4)} score=${r.score.toFixed(2)}`;
  };

  console.log("BEFORE (empty inputs → degenerate fallback, near-FIFO):");
  before.slice(0, top).forEach((r) => console.log(line(r)));
  console.log("\nAFTER (heuristic Effort/Value → WSJF-style value-density):");
  after.slice(0, top).forEach((r) => console.log(line(r)));

  console.log(`\n→ top pick shifts: #${before[0]?.number} → #${after[0]?.number}`);

  if (!apply) {
    console.log("\n(dry run — no board writes. Re-run with --apply to write Effort/Value, after review.)");
    return;
  }

  // --- WRITE PATH (approved 2026-07-25) ---
  // Default: NON-Done items missing EITHER field (partial writes get healed).
  // --done: backfill Done items instead (historical value-density data), in
  // --batch N slices so it trickles inside the API budget instead of spiking.
  const doneMode = argv.includes("--done");
  const batch = argv.includes("--batch") ? Number(argv[argv.indexOf("--batch") + 1]) : 150;
  const missing = (i: BoardItem) => i.effort === 0 || i.value === 0;
  const all = scoped.filter((i) => (doneMode ? i.status === "Done" : i.status !== "Done") && missing(i));
  const targets = doneMode ? all.slice(0, batch) : all;

  // Fail-closed API-budget gate (same Budget model that gates agent labor):
  // ~2 mutations/item at ~1.6 pts each; refuse when it would push past at-risk.
  const { fetchGraphqlLimit, apiCapacity } = await import("../src/mirror.ts");
  const live = await fetchGraphqlLimit();
  const estCost = Math.ceil(targets.length * 3.5);
  const cap = apiCapacity(live);
  if (cap.remainingPoints - estCost < 1000) {
    console.error(
      `GATED: ~${estCost} pts needed, ${cap.remainingPoints} remaining (floor 1000). Resets ${live.resetAt}.`,
    );
    process.exit(3);
  }
  console.log(
    `\n--apply: writing Effort/Value to ${targets.length}${doneMode ? ` of ${all.length} Done` : " non-Done"} items missing inputs${repo ? ` in ${repo}` : " ORG-WIDE"} (est ~${estCost} pts of ${cap.remainingPoints}).`,
  );
  if (!repo) {
    console.log("(no --repo → org-wide. If you meant the prx canary, re-run with --repo prx.)");
  }

  const meta = await fetchProjectMeta();
  if (!meta.fieldId["Effort"] || !meta.fieldId["Value"]) {
    console.error("Effort/Value fields not found on the board; aborting.");
    process.exit(1);
  }

  const writeWithRetry = async (id: string, field: string, value: number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await setNumberField(meta, id, field, value);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // transient network/GraphQL blips → retry a couple times; else rethrow.
        if (attempt < 3 && /connection reset|ECONNRESET|EOF|timeout|502|503/i.test(msg)) {
          continue;
        }
        throw err;
      }
    }
  };

  let done = 0;
  let failed = 0;
  for (const item of targets) {
    const e = estimate(item.kind, item.title);
    try {
      await writeWithRetry(item.id, "Effort", e.effort);
      await writeWithRetry(item.id, "Value", e.value);
      done++;
      if (done % 20 === 0 || done === targets.length) {
        console.log(`  …${done}/${targets.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ #${item.number}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\nwrote ${done} items (${failed} failed). Re-run whats-next to see the live re-ranked queue.`);
}

main().catch((err) => {
  console.error("estimate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
