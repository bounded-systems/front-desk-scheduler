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

### The referent and the collector (#105)

Everything above models **one** transition — `latch`, the claim. #105 added two
more, and `reap` is the first that *frees* a lease and the first performed by a
**non-holder**. That does not make `runAll_preserves_holder` false — it
quantifies over latch schedules — but it makes its informal reading ("once
held, nothing displaces the holder") wrong, which is the 2026-07-27 failure
mode wearing new clothes. So the model is widened rather than the reading left
to trust: `St` carries `{holder, fencing, referent}`, and a schedule is now a
list of `claim | bind | release | reap`.

| theorem | statement |
|---|---|
| `reap_never_grants` | a reap frees or does nothing — no agent can come to hold a lease *by way of* a collection |
| `reap_preserves_fencing` | the counter survives a reap, so a reaped holder's token can never be reused |
| `stale_reap_noop` | **the zombie-collector theorem**: a reaper whose observed fencing no longer matches changes nothing |
| `mismatched_reap_noop` | evidence gathered against a referent the lease is no longer pinned to is refused |
| `referentless_never_reaped` | a lease that never materialized a referent is **unreapable** — that corpse belongs to the backstop TTL, which is why #105 demotes expiry instead of deleting it |
| `reaper_cannot_free_the_new_holder` | the end-to-end race: alice releases and bob claims between the reaper's `/status` read and its reap; bob's lease survives — refused **twice over** (out-fenced *and* referent-less) |
| `takeover_after_release_outfences` | …and the counter really moved, so `fencing_excludes` keeps excluding alice |
| `bind_preserves_holder` / `bind_preserves_fencing` | binding cannot grant, free, or re-fence — the token is stable for the life of a grant |
| `nonholder_bind_noop` / `stale_bind_noop` | a stranger cannot arm someone else's lease for collection (bind sets the *release trigger*, so it is gated like renew) |
| `exclusion_over_mixed_schedules` | **S1 over the enlarged set**: at most one holder under any schedule of claims, binds, releases *and* reaps. Still proven by injectivity — adding a collector did not reintroduce the shape the 2026-07-27 bug lived in |
| `fencing_monotone_step` / `fencing_monotone` | the counter never decreases under any schedule, which is what makes the sink watermark (`fencing_excludes`) apply to the new world |
| `no_grant_without_claim` | from a free lease, no schedule of binds, releases and reaps produces a holder |

**Two things this section deliberately does *not* prove**, stated the way A1/A2
are rather than left to be discovered:

- **A3 — liveness is the cell, not the clock.** "Held" is `holder ≠ none`; the
  real `isLive` also consults `expiresAt`. Sound for every property above (all
  are of the form "this transition cannot free/grant the wrong thing", and a
  clock only makes a transition refuse *more* often) — but it means the
  **backstop is not modelled**: "an unreaped lease eventually lapses" is a
  liveness property and is not proven here.
- **A4 — the oracle is not modelled.** Whether a PR really is merged/closed/gone
  is `verdictFromPrProbe` in `src/reaper.ts` — tested, not proven, and not
  provable here because it is a fact about GitHub. What *is* proven is that a
  reaper acting on stale or wrong evidence changes nothing, which is the half
  that does not depend on the oracle.

Verified with Lean **4.32.1** (referent section re-verified on **4.32.2**): no
`sorry`, and `#print axioms` on every theorem above reports only `propext` /
`Quot.sound` (the standard axioms) — none depends on `sorryAx`. The fifteen
referent/collector theorems report `propext` or nothing at all.

## Build

```sh
# light: install elan (Lean toolchain manager), no sudo, user-space
curl --proto '=https' --tlsv1.2 -sSf https://elan.lean-lang.org/elan-init.sh | sh -s -- -y
cd specs/lean && lake build     # fetches Lean stable on first run, then compiles
```

Verified with Lean **4.32.1**: `Build completed successfully (3 jobs)`, no `sorry`.
