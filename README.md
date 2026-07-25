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
src/policy.ts       vendored PURE policy (prioritize/score/budgetGate) — provenance: gh-project-room
src/contract.ts     the scheduler state machine (WorkItem, Agent, Budget, World) over machine-schema's pattern
src/invariants.ts   the spec: S1..L2 as a catalog + assertInvariants(world) → InvariantReport
src/ops.ts          the concurrency mechanism — claim/spend/complete, each with a racy and a safe variant
src/scheduler.ts    dispatch = prioritize ∘ budgetGate over the ready set
src/sim.ts          deterministic-simulation engine (seeded PRNG, decide/commit split, per-step invariant checks)
test/sim.test.ts    reproduces S1, S2, lost-wakeup; proves safe ops hold across 1000 seeds; catches L1
specs/tla/          the same protocol in TLA+ — racy config finds a counterexample, atomic config passes
specs/lean/         (planned) Lean 4 proof of budgetGate soundness
specs/rust/         (planned) Rust + loom implementation-level interleaving harness
docs/model.md       the invariant catalog, the race taxonomy, and how each projection checks it
```

## Run it

```sh
node --test test/sim.test.ts     # the 5 invariant tests (needs Node >= 23.6 for native TS)
node scripts/demo.ts             # prints the reproduced racy traces vs the safe run
# TLA+ (needs the TLA+ tools / TLC on PATH):
npm run tlc:racy                 # expect: counterexample to MutualExclusion or NoOverspend
npm run tlc:atomic               # expect: all invariants + Liveness pass
```

Source-available under **PolyForm Noncommercial 1.0.0** (matching gh-project-room).
