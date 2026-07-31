/-
  FrontDesk.lean — the ALGEBRA projection of the scheduler contract.

  Where the DST sim (src/) samples interleavings and TLC (specs/tla/) enumerates
  a finite model, Lean proves the pure-policy properties for ALL inputs. The
  target is `budgetGate` soundness — the invariant where "expensive to be wrong"
  is literal compute spend.

  Mirrors `src/policy.ts` budgetGate, quantities as Nat (effort points).
  No mathlib — core `Nat` + `omega` only, so it builds from the toolchain alone.
-/

namespace FrontDesk

/-- A gate decision. -/
inductive Decision
  | allow
  | deny
  deriving DecidableEq, Repr

/--
  `budgetGate`, mirroring src/policy.ts:
    * `capacity = 0` models "no budget set" → fail-open (allow);
    * otherwise deny once `consumed + add` would reach the cap, else allow.
  (`≥ capacity` matches the TS `projected >= capacityPoints` boundary.)
-/
def gate (consumed capacity add : Nat) : Decision :=
  if capacity = 0 then Decision.allow
  else if consumed + add ≥ capacity then Decision.deny
  else Decision.allow

/--
  SOUNDNESS (S2, the money invariant): with a real budget (`0 < capacity`), an
  *allowed* spend leaves the projected total strictly under the cap. So a single
  gate-then-spend can never overspend.
-/
theorem gate_sound {consumed capacity add : Nat}
    (hcap : 0 < capacity) (h : gate consumed capacity add = Decision.allow) :
    consumed + add < capacity := by
  unfold gate at h
  split at h
  · omega                       -- capacity = 0 contradicts hcap
  · split at h
    · contradiction             -- deny = allow is impossible
    · omega                     -- ¬(consumed + add ≥ capacity) ⇒ strictly under

/-- Corollary: after an allowed spend, the new `consumed` is within the cap. -/
theorem allowed_spend_within_cap {consumed capacity add : Nat}
    (hcap : 0 < capacity) (h : gate consumed capacity add = Decision.allow) :
    consumed + add ≤ capacity :=
  Nat.le_of_lt (gate_sound hcap h)

/--
  The atomic reserve (safe applySpend) preserves the no-overspend invariant:
  if the live check passes, the post-state stays within the cap. Trivial by
  construction — which is exactly the point: the SAFE op carries its own proof,
  whereas the racy op below cannot.
-/
theorem reserve_preserves_invariant {consumed capacity add : Nat}
    (hfits : consumed + add ≤ capacity) : consumed + add ≤ capacity := hfits

/-! ## The schedulable set (#89)

  Completion is recorded on two surfaces: the board card's Status column
  (`cardDone`) and GitHub's open/close (`closedAt` — authority.ts: "realized
  completion, calibration ground truth"). Set membership mirrors SCHEDULABLE in
  `src/scheduling.ts` (`status <> 'Done' AND closed_at IS NULL`): a row must be
  clear on BOTH surfaces to be scheduled. This is deliberately the SET, not the
  ready rule — `isEligible` stays the one definition of ready (#59); the set
  decides which rows reach it at all, and (because dependency satisfaction is
  set-complement) which deps count as done.

  `closed` is a Bool — `closed_at IS NOT NULL` in the SQL. WHAT the timestamp
  is never matters to membership, only whether GitHub recorded one, so the
  model carries exactly that bit (and every theorem below is `decide`-checkable).
-/

/-- Mirrors SCHEDULABLE in src/scheduling.ts. -/
def schedulable (closed : Bool) (cardDone : Bool) : Bool :=
  !closed && !cardDone

/--
  #89's invariant: an item GitHub has closed is NEVER schedulable, whatever its
  card says. `.github#55` is the counterexample this rules out — closed
  2026-07-08, card "In Progress", ranked 8th for 23 days. The card can refine a
  live item; it cannot resurrect a closed one.
-/
theorem closed_never_schedulable :
    ∀ cardDone, schedulable true cardDone = false := by decide

/-- The card keeps its own veto: Done excludes the item even with GitHub open. -/
theorem card_done_never_schedulable :
    ∀ closed, schedulable closed true = false := by decide

/--
  Completeness of the two clauses: an excluded row implicates at least one
  authority — there is no third way out of the set. (This is what makes a
  status-drift report exhaustive: every exclusion is attributable.)
-/
theorem excluded_names_its_authority :
    ∀ closed cardDone, schedulable closed cardDone = false →
      closed = true ∨ cardDone = true := by decide

/--
  THE TOCTOU, formalized: `gate` being sound for EACH agent individually does
  NOT make it sound for two agents spending against the SAME snapshot. This is
  the racy S2 bug — proven, not merely simulated. Witness: capacity 6, two spends
  of 4, each allowed against consumed 0, jointly 8 > 6.
-/
theorem racy_gate_unsound :
    ¬ (∀ consumed capacity a b : Nat,
        0 < capacity →
        gate consumed capacity a = Decision.allow →
        gate consumed capacity b = Decision.allow →
        consumed + a + b ≤ capacity) := by
  intro hall
  have h := hall 0 6 4 4 (by decide) (by decide) (by decide)
  omega   -- 0 + 4 + 4 = 8 ≤ 6 is false

end FrontDesk
