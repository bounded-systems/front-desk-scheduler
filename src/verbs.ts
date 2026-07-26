/**
 * @module verbs
 * The scheduler as VerbSpec verbs — authored once, projected to CLI, MCP,
 * OpenAPI, and Anthropic-tool surfaces for free (`@bounded-systems/verbspec`).
 * Every verb reads through the `reads` seam (DoltHub or local dolt), so the
 * whole surface is off the GitHub API — zero rate-limit budget.
 */

import { z } from "zod";
import { defineVerb, type Registry, type VerbSpec } from "@bounded-systems/verbspec";
import { statusToState } from "./board.ts";
import { resolveReads, type SchedulerReads } from "./reads.ts";
import {
  budgetGate,
  ORG_BUDGETS,
  planCapacity,
  prioritize,
  ROLLING_5H_BUDGET,
  type PriorityInput,
} from "./policy.ts";

// ── whats-next ──────────────────────────────────────────────────────────────

const WhatsNextInput = z.object({
  budget: z.string().default(ROLLING_5H_BUDGET.id),
  top: z.coerce.number().int().min(1).max(100).default(10),
  repo: z.string().optional(),
  consumed: z.coerce.number().min(0).default(0),
});

const QueueItem = z.object({
  number: z.number(),
  repository: z.string(),
  kind: z.string(),
  effort: z.number(),
  value: z.number(),
  score: z.number(),
  fits: z.boolean(),
  title: z.string(),
});

const WhatsNextOutput = z.object({
  source: z.enum(["local", "dolthub", "server"]),
  syncedAt: z.string().nullable(),
  budget: z.string(),
  remaining: z.number(),
  eligible: z.number(),
  queue: z.array(QueueItem),
  pick: QueueItem.nullable(),
  gate: z.object({ allow: z.boolean(), reason: z.string() }),
});

interface Deps {
  readonly reads: SchedulerReads;
}

export const whatsNextVerb: VerbSpec<typeof WhatsNextInput, typeof WhatsNextOutput, Deps> = defineVerb<
  typeof WhatsNextInput,
  typeof WhatsNextOutput,
  Deps
>({
  id: "whats-next",
  summary:
    "What should I work on next? The ranked ready queue (WSJF value-density) + budget verdict, read from the DoltHub/local mirror — zero GitHub API.",
  actor: "front-desk",
  input: WhatsNextInput,
  output: WhatsNextOutput,
  deps: () => ({ reads: resolveReads() }),
  run: async (input, deps) => {
    const reads = deps?.reads ?? resolveReads();
    const budget = ORG_BUDGETS.get(input.budget) ?? ROLLING_5H_BUDGET;
    const [board, meta] = await Promise.all([reads.readScheduling(), reads.meta()]);

    const scoped = (input.repo ? board.filter((i) => i.repository === input.repo) : board)
      .filter((i) => !i.leased);
    // Use the array INDEX as the policy's `number` — issue numbers collide across
    // repos, so identity must be positional, then mapped back to the real item.
    const inputs: PriorityInput[] = scoped.map((i, idx) => ({
      number: idx,
      title: i.title,
      kind: i.kind,
      state: statusToState(i.status),
      effort: i.effort,
      value: i.value,
      openBlockers: i.openBlockers,
      unblocks: i.unblocks,
      ageDays: i.ageDays,
    }));

    const remaining = Math.max(budget.capacityPoints - input.consumed, 0);
    const ranked = prioritize(inputs, remaining).filter((r) => r.eligible);
    const toQ = (r: (typeof ranked)[number]) => {
      const it = scoped[r.number]; // r.number is the index
      return {
        number: it.number,
        repository: it.repository,
        kind: it.kind,
        effort: it.effort,
        value: it.value,
        score: Number(r.score.toFixed(2)),
        fits: r.fitsRemaining,
        title: it.title,
      };
    };

    const top = ranked[0];
    const report = planCapacity(budget, top ? [top] : [], input.consumed);
    const gate = budgetGate(report, top ? Math.max(top.effort, 1) : 0);

    return {
      source: reads.source,
      syncedAt: meta?.syncedAt ?? null,
      budget: budget.id,
      remaining,
      eligible: ranked.length,
      queue: ranked.slice(0, input.top).map(toQ),
      pick: top ? toQ(top) : null,
      gate: { allow: gate.allow, reason: gate.reason },
    };
  },
  render: (o) => {
    const w = (s: string, n: number) => String(s).padEnd(n).slice(0, n);
    const lines = [
      `Front Desk — whats-next   source=${o.source}${o.syncedAt ? ` (synced ${o.syncedAt})` : ""}`,
      `budget=${o.budget} remaining=${o.remaining}   ready: ${o.eligible}`,
      `  ${w("#", 6)} ${w("repo", 16)} ${w("kind", 5)} ${w("eff", 4)} ${w("val", 4)} ${w("score", 7)} fits`,
      ...o.queue.map(
        (r) =>
          `  ${w("#" + r.number, 6)} ${w(r.repository, 16)} ${w(r.kind, 5)} ${w(String(r.effort), 4)} ${w(String(r.value), 4)} ${w(r.score.toFixed(2), 7)} ${r.fits ? "✔" : "·"}`,
      ),
      o.pick
        ? `\n→ pick: #${o.pick.number} [${o.pick.repository}] ${o.pick.title}\n  budget: ${o.gate.allow ? "ALLOW" : "DENY"} — ${o.gate.reason}`
        : "\n→ nothing eligible.",
    ];
    return lines.join("\n");
  },
});

export const VERBS: Registry = {
  "whats-next": whatsNextVerb,
};
