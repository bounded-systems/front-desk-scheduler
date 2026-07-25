# specs/lean — budgetGate soundness (Slice 2, ✅ proven)

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

## Build

```sh
# light: install elan (Lean toolchain manager), no sudo, user-space
curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y
cd specs/lean && lake build     # fetches Lean stable on first run, then compiles
```

Verified with Lean **4.32.1**: `Build completed successfully (3 jobs)`, no `sorry`.
