# specs/lean — budgetGate soundness (planned, Slice 2)

The **algebra** layer of the verification pyramid: prove the pure-function
properties of the policy that hold for *all* inputs, not just the interleavings
the sim/TLC sample.

Target theorem (Lean 4):

```
-- budgetGate never admits a spend that would exceed the cap.
theorem budgetGate_sound
    (consumed cap add : Nat) (h : cap > 0) :
    (gate consumed cap add = .allow) → consumed + add ≤ cap
```

plus:

- `prioritize` induces a **total preorder** on eligible items (antisymmetry up to
  tie-break, totality, transitivity of the score order).
- `ready` predicate ⟺ DAG-satisfied (every `blocks`-dep Done).

This is where a proof beats a test: `budgetGate` guards real spend, so "sound for
all inputs" is worth a machine-checked proof rather than a sampled one.

Status: **stub.** Not built. See `../../docs/model.md`.
