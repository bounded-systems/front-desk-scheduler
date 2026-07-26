/**
 * front-desk whats-next — the Concierge interaction.
 *
 * Reads the LIVE Front Desk board and answers "what should I pick up?" by running
 * the real ready queue through the VERIFIED scheduler (prioritize + budgetGate).
 * Read-only. Requires `gh auth` with the `read:project` scope.
 *
 *   node scripts/whats-next.ts [--budget rolling-5h|weekly] [--consumed N]
 *                              [--repo <name>] [--top N] [--json]
 */

import { fetchBoardItems, statusToState, toPriorityInputs, type BoardItem } from "../src/board.ts";
import { mirrorMeta, readMirrorScheduling } from "../src/mirror.ts";
import {
  budgetGate,
  isEligible,
  ORG_BUDGETS,
  planCapacity,
  prioritize,
  ROLLING_5H_BUDGET,
} from "../src/policy.ts";

interface Args {
  budget: string;
  consumed: number;
  repo?: string;
  top: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const a: Args = { budget: ROLLING_5H_BUDGET.id, consumed: 0, top: 10, json: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--budget": a.budget = v; i++; break;
      case "--consumed": a.consumed = Number(v); i++; break;
      case "--repo": a.repo = v; i++; break;
      case "--top": a.top = Number(v); i++; break;
      case "--json": a.json = true; break;
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const budget = ORG_BUDGETS.get(args.budget) ?? ROLLING_5H_BUDGET;

  // Read plane: prefer the Dolt mirror (pinned commit, zero API cost, no GitHub
  // credential needed). Fall back to a cached/live gh fetch if the mirror is empty.
  let board: (BoardItem & { openBlockers?: number; unblocks?: number; ageDays?: number; leased?: boolean })[];
  let source: string;
  const meta = await mirrorMeta().catch(() => null);
  if (meta) {
    // openBlockers/unblocks come from the FULL edge graph (text + mined
    // sub-issue/closing-PR relations) computed in SQL.
    board = await readMirrorScheduling();
    source = `mirror@${meta.commit} (synced ${meta.syncedAt})`;
  } else {
    board = await fetchBoardItems(undefined, undefined, undefined, 15);
    source = "github (no mirror yet — run scripts/sync.ts)";
  }
  const unleased = board.filter((i) => !i.leased);
  const scoped = args.repo ? unleased.filter((i) => i.repository === args.repo) : unleased;
  // Mirror path: graph-derived counts. Fallback path: text-field derivation.
  const inputs = meta
    ? scoped.map((i) => ({
        number: i.number,
        title: i.title,
        kind: i.kind,
        state: statusToState(i.status),
        effort: i.effort,
        value: i.value,
        openBlockers: i.openBlockers ?? 0,
        unblocks: i.unblocks ?? 0,
        ageDays: i.ageDays ?? 0,
      }))
    : toPriorityInputs(scoped);

  const remaining = Math.max(budget.capacityPoints - args.consumed, 0);
  const ranked = prioritize(inputs, remaining);
  const eligible = ranked.filter((r) => r.eligible);

  // Budget verdict via the (verified) gate — cost of the top pick.
  const top = eligible[0];
  const report = planCapacity(budget, top ? [top] : [], args.consumed);
  const gate = budgetGate(report, top ? Math.max(top.effort, 1) : 0);

  const hasInputs = scoped.some((i) => i.effort > 0 || i.value > 0);

  if (args.json) {
    console.log(JSON.stringify({ budget: budget.id, remaining, gate, queue: eligible.slice(0, args.top) }, null, 2));
    return;
  }

  console.log(`Front Desk — whats-next   budget=${budget.id} (cap ${budget.capacityPoints}, consumed ${args.consumed}, remaining ${remaining})`);
  console.log(`source: ${source}`);
  console.log(`ready: ${eligible.length} eligible${args.repo ? ` in ${args.repo}` : " across the org"}\n`);

  const rows = eligible.slice(0, args.top);
  const w = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(`  ${w("#", 5)} ${w("repo", 16)} ${w("kind", 5)} ${w("eff", 4)} ${w("val", 4)} ${w("score", 7)} fits`);
  for (const r of rows) {
    const repo = board.find((b) => b.number === r.number)?.repository ?? "?";
    console.log(`  ${w(String(r.number), 5)} ${w(repo, 16)} ${w(r.kind, 5)} ${w(String(r.effort), 4)} ${w(String(r.value), 4)} ${w(r.score.toFixed(2), 7)} ${r.fitsRemaining ? "✔" : "·"}`);
  }

  console.log();
  if (top) {
    const repo = board.find((b) => b.number === top.number)?.repository ?? "?";
    console.log(`→ pick: #${top.number} [${repo}] ${top.title}`);
    console.log(`  budget: ${gate.allow ? "ALLOW" : "DENY"} — ${gate.reason}`);
  } else {
    console.log("→ nothing eligible (no live item with zero open blockers).");
  }
  if (!hasInputs) {
    console.log(
      "\n⚠ effort/value are unpopulated on this scope, so scoring runs the degenerate\n" +
        "  fallback (kind + unblocks + age) — the ranking is near-FIFO. Populate Effort/\n" +
        "  Value/Depends-on for a meaningful queue (see docs/model.md).",
    );
  }
}

main().catch((err) => {
  console.error("whats-next failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
