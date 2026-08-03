/**
 * @module verbs
 * The scheduler as VerbSpec verbs — authored once, projected to CLI, MCP,
 * OpenAPI, and Anthropic-tool surfaces for free (`@bounded-systems/verbspec`).
 * Every verb reads through the `reads` seam (DoltHub or local dolt), so the
 * whole surface is off the GitHub API — zero rate-limit budget.
 */

import { z } from "zod";
import { defineVerb, type Registry, type VerbSpec } from "@bounded-systems/verbspec";
import { statusToState } from "./status.ts";
import { COVERAGE_GAPS, renderCoverage } from "./coverage.ts";
import { currentReads, type SchedulerReads } from "./reads.ts";
import {
  type ActorCapabilities,
  CAPABILITIES,
  currentActor,
  missingFor,
} from "./capability.ts";
import { assembleGraph, assembleScheduling } from "./scheduling.ts";
import {
  budgetGate,
  ORG_BUDGETS,
  planCapacity,
  prioritize,
  ROLLING_5H_BUDGET,
  type PriorityInput,
} from "./policy.ts";

// ── next ────────────────────────────────────────────────────────────────────

const NextInput = z.object({
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
  // No declared effort/value — the score is the kind+unblocks+age fallback, not
  // a real WSJF density. Surfaced per-item so estimate-backed ranks never pass
  // silently as triaged ones.
  untriaged: z.boolean(),
  // Capabilities this item declares (`needs:` frontmatter), and the subset the
  // CALLING actor lacks. `missing` empty ⇒ executable by this caller.
  needs: z.array(z.string()),
  missing: z.array(z.string()),
});

const NextOutput = z.object({
  source: z.enum(["local", "dolthub", "server"]),
  syncedAt: z.string().nullable(),
  // The commit this ranking was DERIVED FROM — the pin the read actually used,
  // not a second resolution of the head (which can differ if a sync lands in
  // between). `AS OF` this commit re-derives the same queue.
  derivedFrom: z.string().nullable(),
  budget: z.string(),
  remaining: z.number(),
  eligible: z.number(),
  // Of `eligible`, how many this caller can actually execute.
  executable: z.number(),
  untriagedCount: z.number(),
  queue: z.array(QueueItem),
  // Ranked items this caller CANNOT execute — correctly ranked, wrong actor.
  // A separate list, not a reordering: #58 keeps its rank and its score, it
  // simply belongs to someone else (#86).
  otherActors: z.array(QueueItem),
  // What this caller holds, so a refusal is inspectable rather than mysterious.
  actor: z.object({
    held: z.array(z.string()),
    missing: z.array(z.string()),
    // Why each capability is or is not held. The reason is the point: "GH_TOKEN
    // is the 'proxy-injected' sentinel — proxy-local, invalid against
    // api.github.com" is the sentence that would have saved the session in #86.
    why: z.array(z.object({ capability: z.string(), reason: z.string() })),
  }),
  pick: QueueItem.nullable(),
  gate: z.object({ allow: z.boolean(), reason: z.string() }),
  // What `eligible` does NOT count. Declared, not derived — a private repo
  // contributes zero rows, which is indistinguishable from a repo that does not
  // exist. See src/coverage.ts.
  excludes: z.array(z.object({ repo: z.string(), reason: z.string(), ranking: z.string() })),
});

interface Deps {
  readonly reads: SchedulerReads;
  /**
   * What the CALLER holds. Injected so the partition is testable without a
   * filesystem, and so a non-process caller (the MCP server, a workflow) can
   * declare its own capabilities rather than inheriting this process's.
   */
  readonly actor?: ActorCapabilities;
}

/**
 * Why the caller cannot execute anything — one line per capability that some
 * ranked item needs and this actor lacks, carrying the REASON rather than just
 * the name. "no `gh` binary on PATH" and "GH_TOKEN is the sentinel" are
 * different problems with different fixes.
 */
function explainMissingLines(o: { otherActors: { missing: string[] }[]; actor: { why: { capability: string; reason: string }[] } }): string[] {
  const wanted = new Set(o.otherActors.flatMap((r) => r.missing));
  return o.actor.why.filter((w) => wanted.has(w.capability)).map((w) => `${w.capability}: ${w.reason}`);
}

export const nextVerb: VerbSpec<typeof NextInput, typeof NextOutput, Deps> = defineVerb<
  typeof NextInput,
  typeof NextOutput,
  Deps
>({
  id: "next",
  summary:
    "What should I work on next? The ranked ready queue (WSJF value-density) + budget verdict, read from the DoltHub/local mirror — zero GitHub API.",
  actor: "front-desk",
  input: NextInput,
  output: NextOutput,
  deps: () => ({ reads: currentReads(), actor: currentActor() }),
  run: async (input, deps) => {
    const reads = deps?.reads ?? currentReads();
    const actor = deps?.actor ?? currentActor();
    const budget = ORG_BUDGETS.get(input.budget) ?? ROLLING_5H_BUDGET;
    const [read, meta] = await Promise.all([reads.readScheduling(), reads.meta()]);
    const board = read.items;

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
        untriaged: it.effort <= 0 && it.value <= 0,
        needs: [...it.needs],
        missing: missingFor(it.needs, actor),
      };
    };

    // The capability partition. NOT a re-ranking: both lists stay in the score
    // order `prioritize` produced, and no score is touched. #58 was ranked
    // first correctly — effort-1, and #60/#62 are sized off the number it
    // produces — it just needs `gh`, which a cloud session does not have. The
    // useful output is two lists, not one reordered list (#86).
    const executableRanked = ranked.filter((r) => toQ(r).missing.length === 0);
    const otherRanked = ranked.filter((r) => toQ(r).missing.length > 0);

    // The pick is the top item this caller can ACTUALLY do. A pick the caller
    // cannot execute is what cost a full session on 2026-07-31.
    const top = executableRanked[0];
    const report = planCapacity(budget, top ? [top] : [], input.consumed);
    const gate = budgetGate(report, top ? Math.max(top.effort, 1) : 0);

    return {
      source: reads.source,
      syncedAt: meta?.syncedAt ?? null,
      derivedFrom: read.at,
      budget: budget.id,
      remaining,
      eligible: ranked.length,
      executable: executableRanked.length,
      untriagedCount: ranked.filter((r) => toQ(r).untriaged).length,
      queue: executableRanked.slice(0, input.top).map(toQ),
      otherActors: otherRanked.slice(0, input.top).map(toQ),
      actor: {
        held: [...actor.held],
        missing: CAPABILITIES.filter((c) => !actor.held.has(c)),
        why: CAPABILITIES.map((c) => ({ capability: c, reason: actor.because.get(c) ?? "unknown" })),
      },
      pick: top ? toQ(top) : null,
      gate: { allow: gate.allow, reason: gate.reason },
      // Scoping to one repo does not narrow the gaps: a caller asking for `infra`
      // specifically is the one MOST likely to be misled by `ready: 0`.
      excludes: COVERAGE_GAPS.map((g) => ({ ...g })),
    };
  },
  render: (o) => {
    const w = (s: string, n: number) => String(s).padEnd(n).slice(0, n);
    const lines = [
      `Front Desk — next   source=${o.source}${o.syncedAt ? ` (synced ${o.syncedAt})` : ""}` +
        (o.derivedFrom ? `\nderived from commit ${o.derivedFrom} — \`AS OF '${o.derivedFrom}'\` re-derives this exact queue` : ""),
      `budget=${o.budget} remaining=${o.remaining}   ready: ${o.eligible}` +
        (o.otherActors.length ? `   yours: ${o.executable}` : ""),
      `  ${w("#", 6)} ${w("repo", 16)} ${w("kind", 5)} ${w("eff", 4)} ${w("val", 4)} ${w("score", 7)} ${w("fits", 4)} meta`,
      ...o.queue.map(
        (r) =>
          `  ${w("#" + r.number, 6)} ${w(r.repository, 16)} ${w(r.kind, 5)} ${w(String(r.effort), 4)} ${w(String(r.value), 4)} ${w(r.score.toFixed(2), 7)} ${w(r.fits ? "✔" : "·", 4)} ${r.untriaged ? "~" : "✔"}`,
      ),
      // The second list. Printed rather than dropped because these items are
      // correctly ranked and genuinely valuable — they belong to a different
      // actor, and a caller who cannot see them cannot hand them off (#86).
      ...(o.otherActors.length
        ? [
            `\n⊘ ranked, but NOT executable by you (${o.otherActors.length}) — correct ranks, different actor:`,
            ...o.otherActors.map(
              (r) =>
                `  ${w("#" + r.number, 6)} ${w(r.repository, 16)} ${w(r.score.toFixed(2), 7)} needs ${r.missing.join(", ")}`,
            ),
            `  you hold: ${o.actor.held.join(", ") || "none"}${o.actor.missing.length ? `   you lack: ${o.actor.missing.join(", ")}` : ""}`,
          ]
        : []),
      o.pick
        ? `\n→ pick: #${o.pick.number} [${o.pick.repository}] ${o.pick.title}` +
          (o.pick.untriaged ? `\n  ⚠ untriaged — this rank is the fallback (kind+unblocks+age), not a declared priority` : "") +
          `\n  budget: ${o.gate.allow ? "ALLOW" : "DENY"} — ${o.gate.reason}`
        : o.otherActors.length
        ? `\n→ nothing YOU can execute. ${o.otherActors.length} ranked item(s) need capabilities you lack:\n` +
          explainMissingLines(o).map((l) => `  ${l}`).join("\n")
        : "\n→ nothing eligible.",
      ...(o.untriagedCount > 0
        ? [
            `\n~ ${o.untriagedCount}/${o.eligible} ready items are untriaged (no declared effort/value).`,
            `  Declare via issue-body frontmatter (kind/effort/value/depends-on) — see .github/ISSUE_TEMPLATE/task.md.`,
          ]
        : []),
      ...renderCoverage(o.excludes),
    ];
    return lines.join("\n");
  },
});

// ── claim / release (the agent work loop; writes the authoritative local mirror) ──

import { bindReferent, claimNext, releaseClaim } from "./mirror.ts";

/**
 * The ranked candidate list a claim latches from.
 *
 * Reads through the SAME `reads` seam `next` uses — not the local clone.
 * Until 2026-07-28 this called readMirrorScheduling() directly, which meant the
 * claim path RANKED off a local dolt clone while (since the A2 seam) it LATCHED
 * on the shared server: two different databases, one decision. It also made
 * `fds claim` fail outright wherever there is no clone and no dolt CLI — a
 * cloud session, for instance, where it died on `spawn dolt ENOENT`.
 *
 * Returns the commit the ranking was derived from, so the claim can record what
 * board state it decided against (`claims.decided_at_commit`).
 */
const orderedReadyIds = async (repo?: string): Promise<{ ids: string[]; at: string | null; byId: Map<string, { number: number; repository: string; title: string }> }> => {
  const read = await currentReads().readScheduling();
  const board = read.items.filter(
    (i) => i.status !== "Done" && !i.leased && (!repo || i.repository === repo),
  );
  const inputs: PriorityInput[] = board.map((i, idx) => ({
    number: idx, title: i.title, kind: i.kind, state: statusToState(i.status),
    effort: i.effort, value: i.value, openBlockers: i.openBlockers, unblocks: i.unblocks, ageDays: i.ageDays,
  }));
  const ranked = prioritize(inputs, Number.MAX_SAFE_INTEGER).filter((r) => r.eligible);
  const ids = ranked.map((r) => board[r.number].id);
  const byId = new Map(board.map((i) => [i.id, { number: i.number, repository: i.repository, title: i.title }]));
  return { ids, at: read.at, byId };
};

const ClaimOutput = z.object({
  won: z.boolean(),
  itemId: z.string().nullable(),
  number: z.number().nullable(),
  repository: z.string().nullable(),
  title: z.string().nullable(),
  reason: z.string(),
  /**
   * The fencing token, first-class (#114).
   *
   * It used to appear ONLY inside `reason` ("leased 3600s (fencing 1)"), while
   * `docs/claiming-from-a-session.md` told callers to read a `fencing` field —
   * and `release-ticket.yml` / `bind-ticket.yml` both REQUIRE one as input. So
   * the documented path was: read a field that does not exist, then regex an
   * integer out of an English sentence nothing pins.
   *
   * Nothing caught it because every test calls `claimLease()` directly and gets
   * a typed `LeaseGrant` with the token on it; the shape a WORKFLOW caller
   * actually receives is this verb's rendered JSON, which no test exercised.
   *
   * Null on the Dolt planes, which have no ordinal to offer — `claimNext`
   * already returns `fencing: null` there, so this is plumbing rather than new
   * semantics, and the null stays information rather than an omission.
   */
  fencing: z.number().int().nullable(),
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
    const { ids, at, byId } = await orderedReadyIds(input.repo);
    const res = await claimNext(input.agent, ids, input.ttl, at);
    const meta = res.itemId ? byId.get(res.itemId) : undefined;
    return {
      won: res.won,
      itemId: res.itemId ?? null,
      number: meta?.number ?? null,
      repository: meta?.repository ?? null,
      title: meta?.title ?? null,
      reason: res.reason,
      fencing: res.fencing ?? null,
    };
  },
  render: (o) =>
    o.won
      ? `claimed #${o.number} [${o.repository}] — ${o.reason}\n  ${o.title}` +
        // Named on its own line because it is an INPUT to the next thing the
        // caller does (bind-ticket / release-ticket both require it), not a
        // detail of what just happened.
        (o.fencing === null ? "" : `\n  fencing: ${o.fencing}`)
      : `no claim: ${o.reason}`,
});

export const bindVerb = defineVerb({
  id: "bind",
  summary:
    "Pin a held lease to its referent (the open PR) and re-size the expiry into the #105 backstop — from here the reaper releases it when the referent closes.",
  actor: "front-desk",
  input: z.object({
    itemId: z.string(),
    agent: z.string(),
    // Gated exactly like renew in the Worker: the referent decides when the
    // lease DROPS, so only the fenced holder may set it.
    fencing: z.coerce.number().int(),
    kind: z.string().default("pr"),
    ref: z.string(),
    // The BACKSTOP, not a task estimate: sized to "the reaper has been broken
    // for a day", because once the referent exists the reaper is the primary
    // release path and this number should essentially never fire.
    ttl: z.coerce.number().int().min(1).default(86400),
  }),
  output: z.object({
    bound: z.boolean(),
    reason: z.string(),
    holder: z.string().nullable(),
    expiresAt: z.number().nullable(),
  }),
  run: async (input) => {
    const out = await bindReferent(
      input.itemId,
      input.agent,
      input.fencing,
      { kind: input.kind, id: input.ref },
      input.ttl,
    );
    return { bound: out.bound, reason: out.reason, holder: out.holder, expiresAt: out.expiresAt };
  },
  render: (o) =>
    o.bound
      ? `bound (backstop expiry ${o.expiresAt ? new Date(o.expiresAt).toISOString() : "?"})`
      : `NOT bound: ${o.reason}${o.holder ? ` — held by ${o.holder}` : ""}`,
});

export const releaseVerb = defineVerb({
  id: "release",
  summary: "Release or complete a lease, freeing the item (or recording completion).",
  actor: "front-desk",
  input: z.object({
    itemId: z.string(),
    agent: z.string(),
    complete: z.coerce.boolean().default(false),
    // Required by the lease plane, which throws without it: releasing without
    // the token you were granted is how a woken zombie frees the NEW holder's
    // lease. Optional here only because the SQL plane has no fencing at all.
    fencing: z.coerce.number().int().optional(),
  }),
  output: z.object({
    released: z.boolean(),
    status: z.string(),
    reason: z.string(),
    holder: z.string().nullable(),
  }),
  run: async (input) => {
    const status = input.complete ? "completed" : "released";
    // The outcome is REPORTED, not assumed. This used to return a hardcoded
    // `released: true`, so a `not-holder` or `stale-fencing` refusal — which
    // the DO returns correctly — surfaced as a clean release (#104).
    const out = await releaseClaim(input.itemId, input.agent, status, input.fencing);
    return { released: out.released, status, reason: out.reason, holder: out.holder };
  },
  render: (o) =>
    o.released
      ? `${o.status} (ok)`
      : `NOT released: ${o.reason}${o.holder ? ` — held by ${o.holder}` : ""}`,
});

// ── graph ────────────────────────────────────────────────────────────────────
// The GH-canonical dep-graph + ready/blocked classification (GH-1010).
// Unlike `next` (eligible-only, no budget-
// independent view), this emits BOTH buckets plus the typed edges, so a consumer
// (prx's picker) can reconstruct the full read surface. Repo-scoped
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
    "The GH-canonical dep-graph — ready (WSJF-ranked) + blocked (with open blocker IDs) + typed edges, read from the mirror. Zero GitHub API.",
  actor: "front-desk",
  input: GraphInput,
  deps: () => ({ reads: currentReads() }),
  output: GraphOutput,
  run: async (input, deps) => {
    const reads = deps?.reads ?? currentReads();
    const [read, typedEdges, meta] = await Promise.all([
      reads.readScheduling(),
      reads.readTypedEdges(),
      reads.meta(),
    ]);
    const board = read.items;

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

// ── list ─────────────────────────────────────────────────────────────────────
// The `list` verb (GH-1011). ALL items incl Done (unlike graph,
// which is non-Done only) + the typed edges, GH-canonical. A consumer maps these
// to its record shape (e.g. prx's BeadsRecord). Repo-scoped for collision-free
// numbers.

const ListInput = z.object({
  repo: z.string().optional(),
});

const ListItemOut = z.object({
  number: z.number(),
  repository: z.string(),
  kind: z.string(),
  title: z.string(),
  status: z.string(),
  effort: z.number(),
  value: z.number(),
  dependsOn: z.array(z.number()),
  ageDays: z.number(),
});
const ListEdgeOut = z.object({ from: GraphRefOut, to: GraphRefOut, kind: z.string() });

const ListOutput = z.object({
  source: z.enum(["local", "dolthub", "server"]),
  syncedAt: z.string().nullable(),
  // Same contract as NextOutput.derivedFrom: the pin the read actually used.
  // `list` could not report one until #88, because it did not pin — which is
  // also why it could not paginate correctly. The two arrived together.
  derivedFrom: z.string().nullable(),
  items: z.array(ListItemOut),
  edges: z.array(ListEdgeOut),
});

export const listVerb: VerbSpec<typeof ListInput, typeof ListOutput, Deps> = defineVerb<
  typeof ListInput,
  typeof ListOutput,
  Deps
>({
  id: "list",
  summary:
    "Every work item incl Done + the typed dep edges, GH-canonical. Read from the mirror; zero GitHub API.",
  actor: "front-desk",
  input: ListInput,
  deps: () => ({ reads: currentReads() }),
  output: ListOutput,
  run: async (input, deps) => {
    const reads = deps?.reads ?? currentReads();
    // The item read comes FIRST, not in parallel: it resolves the commit, and
    // the edge read is then pinned to that same commit so both halves describe
    // one board state (#88). assembleGraph drops edges whose endpoints are
    // missing, so a torn read here deletes edges quietly instead of failing.
    const [{ items: raw, at }, meta] = await Promise.all([
      reads.readAllItems({ repo: input.repo }),
      reads.meta(),
    ]);
    const typedEdges = await reads.readTypedEdges(at);

    // assembleScheduling with no edges/leases gives us the id-bearing item
    // objects (openBlockers unused here). The rows are ALREADY scoped — the
    // read plane narrowed the query rather than the result set — so every edge
    // endpoint that survives is in the set.
    const scoped = assembleScheduling(raw, [], []);
    const graph = assembleGraph(scoped, typedEdges);

    return {
      source: reads.source,
      syncedAt: meta?.syncedAt ?? null,
      derivedFrom: at,
      items: scoped.map((i) => ({
        number: i.number,
        repository: i.repository,
        kind: i.kind,
        title: i.title,
        status: i.status,
        effort: i.effort,
        value: i.value,
        dependsOn: [...i.dependsOn],
        ageDays: i.ageDays,
      })),
      edges: graph.edges,
    };
  },
  render: (o) =>
    [
      `Front Desk — list   source=${o.source}${o.syncedAt ? ` (synced ${o.syncedAt})` : ""}` +
      (o.derivedFrom
        ? `\nderived from commit ${o.derivedFrom} — \`AS OF '${o.derivedFrom}'\` re-derives this exact list`
        : ""),
      `items: ${o.items.length}   edges: ${o.edges.length}`,
      ...o.items.slice(0, 15).map((i) => `  ${i.repository}#${i.number} [${i.status}] ${i.title}`),
    ].join("\n"),
});

// `renew` is DELIBERATELY not a verb — decided in #105, not left to omission.
// The referent design removes the only caller that would have wanted one: a
// session never heartbeats (its PR does the talking, via `bind` + the reaper),
// and a dispatch-per-beat would cost a runner boot per minute against the
// shared App bucket (#60). The one caller that both needs renew and holds a
// credential is the syncer renewing its own lease, and it calls
// `renewLeaseRemote` directly (src/mirror.ts). If a second in-workflow holder
// ever appears, promote it then.
export const VERBS: Registry = {
  "next": nextVerb,
  "graph": graphVerb,
  "list": listVerb,
  "claim": claimVerb,
  "bind": bindVerb,
  "release": releaseVerb,
};
