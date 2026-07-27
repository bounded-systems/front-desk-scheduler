# specs/lean — budgetGate soundness + S1 mutual exclusion (✅ proven)

The **algebra** layer of the verification pyramid: where the DST sim samples
interleavings and TLC enumerates a finite model, Lean proves the pure-policy
properties for **all** inputs. No mathlib — core `Nat` + `omega` — so it builds
from the toolchain alone.

`FrontDesk.lean` proves:

| theorem | statement |
|---|---|
| `gate_sound` | with `0 < capacity`, an allowed spend ⟹ `consumed + add < capacity` (S2, the money invariant) |
| `allowed_spend_within_cap` | corollary: post-spend `consumed` stays `≤ capacity` |
| `reserve_preserves_invariant` | the safe reserve carries its own no-overspend proof by construction |
| `racy_gate_unsound` | **the TOCTOU, proven**: gate being sound per-agent does NOT make two spends against the same snapshot sound (witness: cap 6, two spends of 4 → 8 > 6) |

`racy_gate_unsound` is the Lean counterpart of the `scheduler-overspend.cfg` TLC
counterexample and the sim's S2 seed — the *same* bug, at the algebra layer.

## `Leases.lean` — S1 (mutual exclusion)

Written after the 2026-07-27 bug, which was **not a wrong proof but a proof of
the wrong obligation**: TLC and loom both establish that an *atomic* CAS upholds
S1, and both are correct — neither says whether the SQL performs one, and it
did not. So this file states its two external assumptions rather than using them
silently:

- **A1 (engine atomicity)** — `INSERT IGNORE` is atomic w.r.t. `PRIMARY KEY`.
  A property of Dolt, not provable here, but far weaker than what the old design
  needed ("a SELECT and a later INSERT are jointly atomic", which nothing grants).
- **A2 (single serialization point)** — all claimants latch against the *same*
  database. ⚠️ **Currently unmet**: `dsql` writes to a local clone.

| theorem | statement |
|---|---|
| `mutual_exclusion` | at most one agent observes itself as holder — by injectivity of `some`, needing no invariant |
| `runAll_preserves_holder` | **no schedule of any length** displaces a holder |
| `first_wins` / `some_winner` | a non-empty schedule yields exactly one winner — no lost claims |
| `exclusion_over_schedules` | S1 for **all** interleavings of **any** number of agents — what bounded checkers can't give |
| `guarded_log_unsound` | **the bug, proven**: passing the `NOT EXISTS` guard doesn't exclude (witness: agents 0, 1 on the empty log) |
| `both_agents_confirm` | and it's *silent* — filtering the read-back on `agent` means both agents confirm |
| `log_admits_two_holders` | the structural point: a list can represent two holders; a cell cannot. The fix made the bad state unrepresentable |
| `fencing_excludes` | a fencing token permanently refuses a lapsed holder's effects — the part `leases` does **not** provide |

`guarded_log_unsound` is the S1 counterpart of `racy_gate_unsound`: the same
check-then-act shape, in the claim path rather than the budget path.

Verified with Lean **4.32.1**: no `sorry`, and `#print axioms` on every theorem
above reports only `propext` / `Quot.sound` (the standard axioms) — none depends
on `sorryAx`.

## Build

```sh
# light: install elan (Lean toolchain manager), no sudo, user-space
curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y
cd specs/lean && lake build     # fetches Lean stable on first run, then compiles
```

Verified with Lean **4.32.1**: `Build completed successfully (3 jobs)`, no `sorry`.
