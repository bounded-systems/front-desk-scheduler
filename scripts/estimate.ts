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
import { setDoltFields } from "../src/mirror.ts";
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

  // Authority model: effort/value are DOLT-OWNED. The estimator writes the Dolt
  // surface (setDoltFields → dolt-dirty) — free, no GitHub API — and scripts/push.ts
  // (or the cron) flushes to the board project fields. Writing GitHub directly
  // would be the "invalid" out-of-band path.
  console.log(
    `\n--apply: estimating Effort/Value on the DOLT surface for ${targets.length}${doneMode ? ` of ${all.length} Done` : " non-Done"} items missing inputs${repo ? ` in ${repo}` : " ORG-WIDE"} (0 GitHub API).`,
  );

  let done = 0;
  for (const item of targets) {
    const e = estimate(item.kind, item.title);
    await setDoltFields(item.id, { effort: e.effort, value: e.value });
    done++;
    if (done % 100 === 0 || done === targets.length) console.log(`  …${done}/${targets.length}`);
  }
  console.log(`\nestimated ${done} items → Dolt (dolt-dirty). Run scripts/push.ts to flush to GitHub, or let the cron.`);
}

main().catch((err) => {
  console.error("estimate failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
