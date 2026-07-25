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

import { fetchBoardItems, toPriorityInputs, type BoardItem } from "../src/board.ts";
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

  const board = await fetchBoardItems();
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

  // --- GUARDED WRITE PATH ---
  console.log("\n--apply given: this WOULD write Effort/Value to the live board.");
  console.log("Refusing to write from this script until the write path is explicitly enabled.");
  console.log("(Board writes are org-wide and outward; wire gh project item-edit here only with sign-off.)");
  process.exit(2);
}

main().catch((err) => {
  console.error("estimate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
