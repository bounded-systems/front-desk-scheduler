# The scheduler model

One contract, verified by projection. The abstractions live once (in `src/`); each
formalism is a projection that checks a different failure class — the same idea as
verbspec (author a verb once → CLI/MCP/OpenAPI), applied to verification.

## The abstractions

- **`WorkItem`** — lifecycle `Blocked → Ready → InProgress → Done`.
  `Ready ⟺ open ∧ every "blocks"-dep is Done` (the `bd ready` rule, = `isEligible`).
  `edges` of type `blocks` form the dependency DAG.
- **`Agent`** (a thread) — `Idle → Claiming → Working → Releasing`.
- **`Budget`** — a token bucket `{ capacityPoints, consumed }`.
- **`World`** — the snapshot the invariants run against and the ops transition.
- **Policy** (`policy.ts`, vendored from gh-project-room) — pure, sequential:
  `prioritize = which item`, `budgetGate = allowed to spend?`. It has **no**
  concurrency. The races are entirely in the mechanism around it.

## The invariants (the spec)

| id | kind | statement |
|----|------|-----------|
| **S1** | safety | mutual exclusion — ≤1 agent InProgress on any item |
| **S2** | safety | no-overspend — `consumed ≤ capacityPoints`, always |
| **S3** | safety | conservation — owner/phase agree; a claimed item has exactly one owner |
| **L1** | liveness-hazard | deadlock-free — a `blocks`-cycle with an idle agent is flagged |
| **L2** | liveness | starvation-free — under aging, every Ready item eventually Done |

Represented (mirroring `machine-schema`) as the `invariantSpecs` string catalog +
`assertInvariants(world) → InvariantReport` with `{ id, severity, message }` findings.

## The race taxonomy

Every race is a **check-then-act** split. The sim/TLC separate the check from the
act with a yield point between; the racy variant trusts the stale check, the safe
variant re-validates atomically.

| race | op (`ops.ts`) | racy bug | safe fix | invariant |
|------|---------------|----------|----------|-----------|
| double-claim | `commitClaim` | assign unconditionally | CAS on status | **S1** |
| budget TOCTOU | `applySpend` | trust stale gate, `+=` | atomic reserve-then-commit | **S2** |
| lost wakeup | `complete` | skip re-scan of dependents | signal now-unblocked → Ready | **L2** |
| deadlock | (DAG shape) | — | cycle detection | **L1** |

### Reproduced traces (from `node scripts/demo.ts`)

**S1** — both agents *decide* on #1 before either *commits*:
```
agent-2: decide claim #1
agent-1: decide claim #1
agent-2: commit claim #1 → WON
agent-1: commit claim #1 → WON (racy, over a taken item)
!! INVARIANT VIOLATION: S1, S3
```

**S2** — both *gate* against `consumed=6` before either *applies*:
```
agent-2: gate spend 3 (consumed=6) → allow
agent-1: gate spend 3 (consumed=6) → allow
agent-1: apply spend 3 → consumed=9
agent-2: apply spend 3 → consumed=12
!! INVARIANT VIOLATION: S2      (12 > cap 10)
```

Under **safe** ops the same scenario denies the second spend at commit time
(`consumed=9, 9+3 > 10 → denied`), so the budget holds — and item #2 correctly
*waits* (fail-closed, until the window resets) rather than overspending.

## The two projections agree

- **DST sim** (`src/sim.ts`) — executable, mockable, seeded. Finds the failing
  interleaving and replays it by seed. This is the test harness the real Concierge
  will reuse.
- **TLA+** (`specs/tla/scheduler.tla`) — exhaustive over *all* interleavings.
  `scheduler-racy.cfg` (Cap=6, Effort=4) yields a counterexample to
  `MutualExclusion` or `NoOverspend`; `scheduler-atomic.cfg` (Cap=8, CAS+reserve)
  passes safety **and** liveness `<>AllDone`.

Both describe the *same* double-claim / overspend interleaving — the cross-check
that the model and the proof are talking about the same system.

### Confirmed TLC output

Run with TLC 2.19 (`java -cp tla2tools.jar tlc2.TLC`):

- **`scheduler-racy.cfg`** → `Error: Invariant MutualExclusion is violated.` The
  trace: `a1` and `a2` both `Pick i1`, then both `Claim` → `owners(i1) = {a1, a2}`.
  The *same* interleaving the DST sim's seed-1 racy run prints.
- **`scheduler-overspend.cfg`** (checks only `NoOverspend`, so the S2 race is
  surfaced rather than S1) → `Error: Invariant NoOverspend is violated.` The trace:
  `a1→i1`, `a2→i2` (distinct items), both gate at `consumed=0`, then
  `consumed: 0 → 4 → 8` > cap 6.
- **`scheduler-atomic.cfg`** → `Model checking completed. No error has been found.`
  205 distinct states; safety **and** liveness `<>AllDone` hold across every
  interleaving.

> Note on budget sizing across the two TLA+ configs: racy needs `Cap < |Agents|·Effort`
> to exhibit overspend; the atomic/liveness config needs `Cap ≥ |Items|·Effort` so all
> work is affordable (otherwise not-all-done is *correct*, not a liveness bug). Hence
> the different `Cap` per config — same spec, two model instances.

## The live-board tie-in

The real board runs the policy on **empty inputs** (`effort`/`value`/`Depends on`
are 0/1251 populated), so `score()`'s `effort===0 && value===0` fallback flattens
everything and Dependabot bumps rank top — a scheduler with no priority information
degenerating to near-FIFO. That's the starvation case (L2) in the field, and the
reason the Concierge needs its inputs populated before it can schedule anything
worth scheduling.

## The third projection — Lean (algebra)

`specs/lean/FrontDesk.lean` proves the policy properties for **all** inputs, not
just sampled/enumerated ones. Verified with Lean 4.32.1 (`omega`, no mathlib):

- **`gate_sound`** — `0 < capacity ∧ gate = allow ⟹ consumed + add < capacity`.
  A single gate-then-spend can never overspend.
- **`racy_gate_unsound`** — proves the TOCTOU: `gate` sound per-agent does *not*
  make two spends against the same snapshot sound (witness cap 6, two 4s → 8 > 6).
  The same S2 bug as the `scheduler-overspend.cfg` TLC trace and the sim's seed —
  now at the algebra layer. **Three projections, one bug.**

## The fourth projection — Rust + loom (implementation)

`specs/rust/` implements the claim/spend core in real atomics and lets `loom`
explore every thread interleaving. `safe_claim_is_mutually_exclusive` and
`safe_reserve_never_overspends` pass; `racy_spend_can_overspend` (`#[should_panic]`)
confirms loom **finds** the overspend in the stale-gated `fetch_add`. Same S2 bug,
now at four altitudes: **sim seed → TLC trace → Lean proof → loom interleaving.**

> A note the modeling itself earned: the first `spend_racy` used `store(c+add)`,
> so two stale writers both wrote 4 (a lost update), not 8 — loom's `should_panic`
> test failed, catching that the *model of the bug* was wrong. The faithful racy
> spend gates then `fetch_add`. The tool checking the model also debugged it.
