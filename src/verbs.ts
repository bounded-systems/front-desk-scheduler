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
import { assembleGraph } from "./scheduling.ts";
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

// ── claim / release (the agent work loop; writes the authoritative local mirror) ──

import { claimNext, readMirrorScheduling, releaseClaim } from "./mirror.ts";

const orderedReadyIds = async (repo?: string): Promise<{ ids: string[]; byId: Map<string, { number: number; repository: string; title: string }> }> => {
  const board = (await readMirrorScheduling()).filter(
    (i) => i.status !== "Done" && !i.leased && (!repo || i.repository === repo),
  );
  const inputs: PriorityInput[] = board.map((i, idx) => ({
    number: idx, title: i.title, kind: i.kind, state: statusToState(i.status),
    effort: i.effort, value: i.value, openBlockers: i.openBlockers, unblocks: i.unblocks, ageDays: i.ageDays,
  }));
  const ranked = prioritize(inputs, Number.MAX_SAFE_INTEGER).filter((r) => r.eligible);
  const ids = ranked.map((r) => board[r.number].id);
  const byId = new Map(board.map((i) => [i.id, { number: i.number, repository: i.repository, title: i.title }]));
  return { ids, byId };
};

const ClaimOutput = z.object({
  won: z.boolean(),
  itemId: z.string().nullable(),
  number: z.number().nullable(),
  repository: z.string().nullable(),
  title: z.string().nullable(),
  reason: z.string(),
});

export const claimVerb = defineVerb({
  id: "claim",
  summary:
    "Lease the top-ranked ready item for an agent — an atomic CAS (the scheduler's proven S1) with a ttl visibility timeout; a dead agent's lease auto-expires.",
  actor: "front-desk",
  input: z.object({
    agent: z.string(),
    repo: z.string().optional(),
    ttl: z.coerce.number().int().min(1).default(3600),
  }),
  output: ClaimOutput,
  run: async (input) => {
    const { ids, byId } = await orderedReadyIds(input.repo);
    const res = await claimNext(input.agent, ids, input.ttl);
    const meta = res.itemId ? byId.get(res.itemId) : undefined;
    return {
      won: res.won,
      itemId: res.itemId ?? null,
      number: meta?.number ?? null,
      repository: meta?.repository ?? null,
      title: meta?.title ?? null,
      reason: res.reason,
    };
  },
  render: (o) =>
    o.won
      ? `claimed #${o.number} [${o.repository}] — ${o.reason}\n  ${o.title}`
      : `no claim: ${o.reason}`,
});

export const releaseVerb = defineVerb({
  id: "release",
  summary: "Release or complete a lease, freeing the item (or recording completion).",
  actor: "front-desk",
  input: z.object({
    itemId: z.string(),
    agent: z.string(),
    complete: z.coerce.boolean().default(false),
  }),
  output: z.object({ released: z.boolean(), status: z.string() }),
  run: async (input) => {
    const status = input.complete ? "completed" : "released";
    await releaseClaim(input.itemId, input.agent, status);
    return { released: true, status };
  },
  render: (o) => `${o.status} (${o.released ? "ok" : "failed"})`,
});

// ── graph ────────────────────────────────────────────────────────────────────
// The GH-canonical dep-graph + ready/blocked classification — the bd-ready /
// bd-dep replacement (GH-1010). Unlike whats-next (eligible-only, no budget-
// independent view), this emits BOTH buckets plus the typed edges, so a consumer
// (prx's picker + beadsd door) can reconstruct the bd read surface. Repo-scoped
// so per-repo callers get collision-free numbers.

const GraphInput = z.object({
  repo: z.string().optional(),
});

const GraphRefOut = z.object({ number: z.number(), repository: z.string() });
const GraphItemOut = z.object({
  number: z.number(),
  repository: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.string(),
  effort: z.number(),
  value: z.number(),
  score: z.number(),
  ageDays: z.number(),
});
const GraphBlockedOut = GraphItemOut.extend({ blockedBy: z.array(GraphRefOut) });
const GraphEdgeOut = z.object({ from: GraphRefOut, to: GraphRefOut, kind: z.string() });

const GraphOutput = z.object({
  source: z.enum(["local", "dolthub", "server"]),
  syncedAt: z.string().nullable(),
  ready: z.array(GraphItemOut),
  blocked: z.array(GraphBlockedOut),
  edges: z.array(GraphEdgeOut),
});

export const graphVerb: VerbSpec<typeof GraphInput, typeof GraphOutput, Deps> = defineVerb<
  typeof GraphInput,
  typeof GraphOutput,
  Deps
>({
  id: "graph",
  summary:
    "The GH-canonical dep-graph — ready (WSJF-ranked) + blocked (with open blocker IDs) + typed edges, read from the mirror. The bd-ready/bd-dep replacement; zero GitHub API.",
  actor: "front-desk",
  input: GraphInput,
  deps: () => ({ reads: resolveReads() }),
  output: GraphOutput,
  run: async (input, deps) => {
    const reads = deps?.reads ?? resolveReads();
    const [board, typedEdges, meta] = await Promise.all([
      reads.readScheduling(),
      reads.readTypedEdges(),
      reads.meta(),
    ]);

    const scoped = input.repo ? board.filter((i) => i.repository === input.repo) : board;
    const graph = assembleGraph(scoped, typedEdges);

    // Rank every scoped item once (positional identity — numbers collide across
    // repos), so ready is WSJF-ordered and every item carries a score.
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
    const ranked = prioritize(inputs, Number.MAX_SAFE_INTEGER);
    const scoreByIdx = new Map(ranked.map((r) => [r.number, Number(r.score.toFixed(2))]));

    const toItem = (i: (typeof scoped)[number], idx: number) => ({
      number: i.number,
      repository: i.repository,
      kind: i.kind,
      title: i.title,
      status: i.status,
      effort: i.effort,
      value: i.value,
      score: scoreByIdx.get(idx) ?? 0,
      ageDays: i.ageDays,
    });

    // ready = eligible (open, no open blockers), in WSJF rank order.
    const ready = ranked
      .filter((r) => r.eligible)
      .map((r) => toItem(scoped[r.number], r.number));
    // blocked = open items with at least one OPEN blocker, carrying the IDs.
    const blocked = scoped
      .map((i, idx) => ({ i, idx }))
      .filter(({ i }) => (graph.blockedBy.get(i.id)?.length ?? 0) > 0)
      .map(({ i, idx }) => ({ ...toItem(i, idx), blockedBy: graph.blockedBy.get(i.id) ?? [] }));

    return {
      source: reads.source,
      syncedAt: meta?.syncedAt ?? null,
      ready,
      blocked,
      edges: graph.edges,
    };
  },
  render: (o) =>
    [
      `Front Desk — graph   source=${o.source}${o.syncedAt ? ` (synced ${o.syncedAt})` : ""}`,
      `ready: ${o.ready.length}   blocked: ${o.blocked.length}   edges: ${o.edges.length}`,
      ...o.ready.slice(0, 10).map((r) => `  ready   ${r.repository}#${r.number}  ${r.title}`),
      ...o.blocked.slice(0, 10).map((b) =>
        `  blocked ${b.repository}#${b.number}  ← ${b.blockedBy.map((x) => `#${x.number}`).join(",")}`
      ),
    ].join("\n"),
});

export const VERBS: Registry = {
  "whats-next": whatsNextVerb,
  "graph": graphVerb,
  "claim": claimVerb,
  "release": releaseVerb,
};
