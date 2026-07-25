# front-desk-scheduler

A formal model of **Front Desk** (bounded-systems org project #2) as what it
actually is once agents pull work concurrently: **a scheduler**.

The board is meant to become a *function* an agent calls to decide what to do next
(`gh-project-room`'s `prioritization.ts` + the reserved Concierge). That policy —
`prioritize()` / `budgetGate()` — is **pure and sequential**. The moment two agents
consult it and act at the same time, the board inherits the full OS-scheduler
problem set. This repo **reuses** the policy and models the missing **mechanism**,
so the races are reproducible (a seeded simulation) and provable (a TLA+ spec).

## The mapping — backlog concepts are scheduler concepts

| Front Desk / PM | OS / computer-processing equivalent |
|---|---|
| Issue (unit of intent) | process / task (PCB) |
| `Status: Todo` + no open blockers (`bd ready`) | **ready queue** (runnable processes) |
| `Depends on` graph | **dependency DAG** (`make -j`, Bazel, dataflow) |
| `prioritize()` (value-density + unblocks − effort) | the **priority function** (≈ WSJF / SJF) |
| Agent / Claude session | **thread / core / worker** |
| `budgetGate()` + `capacityPoints` over a window | **cgroup quota + admission control** (token bucket) |
| WIP limits | **thread-pool size** |
| circular `Depends on` | **deadlock** |
| an item never picked | **starvation** → needs aging |

Human-driven boards (Jira, Linear, ZenHub) are **cooperative schedulers with a
human CPU** — a person dispatches, so overspend and races are impossible. An
**agentic** Concierge must be a **preemptive, budget-gated, DAG-aware scheduler**,
which is why it needs the machinery those tools never did. This model is that
machinery, verified.

## What's here

```
src/board.ts        the live-board seam: reads Front Desk via gh, maps items → PriorityInput (read-only)
scripts/whats-next.ts  the Concierge interaction — "what should I pick up?" over the live board
src/policy.ts       vendored PURE policy (prioritize/score/budgetGate) — provenance: gh-project-room
src/contract.ts     the scheduler state machine (WorkItem, Agent, Budget, World) over machine-schema's pattern
src/invariants.ts   the spec: S1..L2 as a catalog + assertInvariants(world) → InvariantReport
src/ops.ts          the concurrency mechanism — claim/spend/complete, each with a racy and a safe variant
src/scheduler.ts    dispatch = prioritize ∘ budgetGate over the ready set
src/sim.ts          deterministic-simulation engine (seeded PRNG, decide/commit split, per-step invariant checks)
test/sim.test.ts    reproduces S1, S2, lost-wakeup; proves safe ops hold across 1000 seeds; catches L1
specs/tla/          the same protocol in TLA+ — racy config finds a counterexample, atomic config passes
specs/lean/         Lean 4 proof of budgetGate soundness + the TOCTOU (✅ builds, Lean 4.32.1)
specs/rust/         (planned) Rust + loom implementation-level interleaving harness
docs/model.md       the invariant catalog, the race taxonomy, and how each projection checks it
```

## Run it

```sh
node --test test/sim.test.ts     # the 5 invariant tests (needs Node >= 23.6 for native TS)
node scripts/demo.ts             # prints the reproduced racy traces vs the safe run

# TLA+ / TLC — two ways, no Nix required:
#   light:  brew install openjdk   (keg-only JRE, no sudo); scripts/tlc.sh auto-fetches tla2tools.jar
npm run tlc:racy                 # → Error: Invariant MutualExclusion is violated (double-claim)
npm run tlc:overspend            # → Error: Invariant NoOverspend is violated (budget TOCTOU)
npm run tlc:atomic               # → No error found; safety + Liveness hold over all 205 states
#   reproducible: `nix develop` (flake.nix provides node 24 + tlc), or `nix run .#tlc-atomic`

# The interaction — ask the live board what to pick up (needs `gh auth` + read:project):
npm run whats-next -- --top 12                 # ranked ready queue across the org + budget verdict
npm run whats-next -- --repo prx --budget rolling-5h
```

> Today the queue is honest about being degenerate: `Effort`/`Value`/`Depends on`
> are unpopulated on the real board (0/1251), so scoring runs its fallback and the
> ranking is near-FIFO. `whats-next` says so. Populate those fields and the same
> command returns a meaningful WSJF-style queue — no code change.

Source-available under **PolyForm Noncommercial 1.0.0** (matching gh-project-room).
