/-
  Leases.lean — the ALGEBRA projection of S1 (mutual exclusion).

  Companion to FrontDesk.lean, which proves S2 (the budget invariant). Where TLC
  enumerates a finite model and loom enumerates the interleavings of a small
  program, Lean proves the property for ALL schedules and ALL numbers of agents.

  WHAT THIS FILE IS FOR
  ---------------------
  The 2026-07-27 bug was not a wrong proof. It was a proof of the wrong
  obligation: specs/tla and specs/rust both establish that an ATOMIC compare-and-
  swap upholds S1, and both are correct. Neither says anything about whether the
  SQL performs one — and it did not, because the `claims` table had no unique
  index. The models assumed the atomicity; the implementation never supplied it.

  So this file is written to make the assumption impossible to lose. Everything
  below is a theorem about a state machine, and the two facts that state machine
  needs from the world are stated as A1 and A2 rather than quietly used. The
  theorems are only as good as A1 and A2. A2 is now a DEPLOYMENT property —
  met when claims route through a shared server, not when they do not — rather
  than a latent assumption nobody could see (see the note on it).

  Mirrors src/mirror.ts (claimNext / releaseClaim) and schema/mirror.sql.
  No mathlib — core `Nat`/`List` + `decide`/`omega` — so it builds from the
  toolchain alone, like FrontDesk.lean.
-/

namespace FrontDesk.Leases

abbrev Agent := Nat

/-
  ── THE TWO EXTERNAL ASSUMPTIONS ──────────────────────────────────────────────

  A1 (ENGINE ATOMICITY). `latch` below is ONE state transition. The obligation on
     the implementation is that `INSERT IGNORE INTO leases ...` is atomic with
     respect to `PRIMARY KEY (item_id)` — i.e. of two concurrent inserts of the
     same key, exactly one creates the row and the other is rejected, with no
     interleaving that admits both. This is the defining guarantee of a unique
     index in any MySQL-compatible engine, and is the weakest assumption we know
     how to rest on. It is NOT provable here; it is a property of Dolt.

     What makes A1 discharge-able where the old design's assumption was not: the
     old code needed "a SELECT and a subsequent INSERT are jointly atomic", which
     no engine promises and which `dolt sql -q` (a fresh process per statement)
     actively breaks. A1 needs one statement to be atomic against a key. That is
     a much smaller thing to be wrong about.

  A2 (SINGLE SERIALIZATION POINT). All claimants must latch against the SAME
     database. A PRIMARY KEY excludes a second row within one database; it says
     nothing across replicas. If two workers each write to their own local Dolt
     clone and reconcile by merge afterwards, both latch successfully, both
     believe they hold the item, and the conflict surfaces at merge time — long
     after both agents have started working.

     STATUS: the SEAM exists, the DEPLOYMENT decides. Since 2026-07-28 the three
     concurrent claim writes (claimNext / renewLease / releaseClaim) route
     through `claimWrite`/`claimRows` in src/mirror.ts, which send them to a
     shared `dolt sql-server` when DOLT_HOST is set — one database, so the
     PRIMARY KEY is globally authoritative and A2 holds. With DOLT_HOST unset
     they fall back to the local clone, where A2 does NOT hold; that path warns
     at runtime rather than failing silently.

     So A2 is now a deployment property, checkable by looking at one variable,
     rather than a latent assumption nobody could see. It is still an assumption:
     Lean cannot observe DOLT_HOST. The sync/push writes were never in scope —
     they run only from Actions under one concurrency group, so they are already
     single-writer.
-/

/-! ## Design B — the lease cell (current)

`PRIMARY KEY (item_id)` means one item's lease state is a single cell: held by
exactly one agent, or free. Uniqueness is not a predicate to be checked; it is
the shape of the state. That is the entire fix, and the proofs are short because
of it. -/

/-- The lease state of ONE item. S1 is a per-item property, so one cell suffices. -/
abbrev Lease := Option Agent

/-- `INSERT IGNORE`: create the row, or collide and change nothing. One step (A1). -/
def latch (a : Agent) : Lease → Lease
  | none   => some a
  | some h => some h

/-- Read-back: who holds it. Total, and single-valued by construction. -/
def holder (s : Lease) : Option Agent := s

/-- The claimant's success test in `claimNext`: the read-back names me. -/
def won (a : Agent) (s : Lease) : Prop := holder s = some a

instance (a : Agent) (s : Lease) : Decidable (won a s) := by
  unfold won holder; exact inferInstance

/-- A latch never displaces an existing holder — the loser's write is a no-op. -/
theorem latch_never_displaces (a h : Agent) : latch a (some h) = some h := rfl

/-- After any latch the item is held by someone. Latching cannot free an item. -/
theorem latch_occupied (a : Agent) (s : Lease) : ∃ h, latch a s = some h := by
  cases s with
  | none   => exact ⟨a, rfl⟩
  | some h => exact ⟨h, rfl⟩

/--
  **S1 — MUTUAL EXCLUSION.** In any reachable state, at most one agent can
  observe itself as the holder. Note what the proof needs: nothing. It is
  injectivity of `some`. Once the state is a single cell, exclusion is not an
  invariant to be maintained across transitions — it is unstatable to violate.
-/
theorem mutual_exclusion {s : Lease} {a b : Agent} (ha : won a s) (hb : won b s) : a = b := by
  unfold won holder at ha hb
  rw [ha] at hb
  exact Option.some.inj hb

/-! ### Arbitrary schedules, arbitrarily many agents

`runAll` folds a list of latch attempts — one list is one interleaving, and
quantifying over the list quantifies over every schedule of every size. This is
what the bounded model checkers cannot give us. -/

/-- Run a whole schedule of claim attempts against one item. -/
def runAll : List Agent → Lease → Lease
  | [],      s => s
  | a :: as, s => runAll as (latch a s)

/-- Once held, NO schedule of any length can displace the holder. -/
theorem runAll_preserves_holder (as : List Agent) (h : Agent) :
    runAll as (some h) = some h := by
  induction as with
  | nil => rfl
  | cons a as ih => simpa [runAll, latch] using ih

/-- The first claimant in the schedule wins, whatever follows it. -/
theorem first_wins (a : Agent) (as : List Agent) :
    runAll (a :: as) none = some a := by
  simpa [runAll, latch] using runAll_preserves_holder as a

/--
  **S1 over every schedule.** For any sequence of claim attempts by any number
  of agents, at most one of them observes a win. This is the theorem the SQL
  now earns, given A1 and A2.
-/
theorem exclusion_over_schedules (as : List Agent) (s : Lease) {a b : Agent}
    (ha : won a (runAll as s)) (hb : won b (runAll as s)) : a = b :=
  mutual_exclusion ha hb

/-- A non-empty schedule always produces exactly one winner — no lost claims. -/
theorem some_winner (a : Agent) (as : List Agent) :
    won a (runAll (a :: as) none) := by
  unfold won holder
  exact first_wins a as

/-! ## Design A — the predicate-guarded log (pre-2026-07-27)

`claims` had no unique index, so the state was a LIST and exclusion had to be a
predicate: `INSERT ... WHERE NOT EXISTS (<live claim>)`. The guard is evaluated
against a state that the write does not hold fixed. -/

/-- The append-only claims log: the state is a list, so it admits any number of holders. -/
abbrev Log := List Agent

/-- The `WHERE NOT EXISTS` guard — a read, evaluated against a snapshot. -/
def guard (l : Log) : Bool := l.isEmpty

/-- The unconstrained INSERT — a write, in a separate statement from the guard. -/
def push (a : Agent) (l : Log) : Log := a :: l

/-- The old `claimNext` confirmation: "is there a live claim naming ME?" -/
def wonLog (a : Agent) (l : Log) : Prop := a ∈ l

instance (a : Agent) (l : Log) : Decidable (wonLog a l) := by
  unfold wonLog; exact inferInstance

/--
  **THE BUG, PROVEN.** Both agents passing the guard against the same snapshot
  does NOT yield exclusion: the resulting log names both, so both confirmations
  succeed. Witness: agents 0 and 1 against the empty log.

  This is the S1 counterpart of `FrontDesk.racy_gate_unsound` — the same
  check-then-act shape, in the claim path rather than the budget path.
-/
theorem guarded_log_unsound :
    ¬ (∀ (a b : Agent) (l : Log), guard l = true →
        ∀ x y, wonLog x (push b (push a l)) → wonLog y (push b (push a l)) → x = y) := by
  intro hall
  have h : (0 : Agent) = 1 := hall 0 1 [] (by decide) 0 1 (by decide) (by decide)
  exact absurd h (by decide)

/--
  And the failure is SILENT. Each agent's confirmation filtered on its own name,
  so in a double-insert both agents read back their own row and both returned
  `won = true`. There is no interleaving in which either learns it lost.
-/
theorem both_agents_confirm :
    wonLog 0 (push 1 (push 0 [])) ∧ wonLog 1 (push 1 (push 0 [])) := by
  constructor <;> decide

/--
  The structural statement of the fix: the log admits a state with two holders;
  the cell cannot represent one. The repair was not a better predicate — it was
  making the bad state unrepresentable.
-/
theorem log_admits_two_holders :
    ∃ (l : Log) (x y : Agent), wonLog x l ∧ wonLog y l ∧ x ≠ y :=
  ⟨[0, 1], 0, 1, by decide, by decide, by decide⟩

/-! ## Expiry, and why the PK alone is not enough

A lease lapses on a TTL and `claimNext` reaps it. Reaping is correct in the
database — but a reaped agent is not thereby STOPPED. Between its lease expiring
and its noticing, it is still working, while a new holder latches legitimately.
Both hold, in the world if not in the table. This is the standard fencing
problem, and no amount of uniqueness in `leases` addresses it. -/

/-- A monotonically increasing fencing token, handed out with each lease. -/
abbrev Token := Nat

/-- An effect sink (the brokered-effects seam) remembers the highest token it honoured. -/
def accepts (seen t : Token) : Bool := decide (seen < t)

/-- Honouring an effect advances the watermark. -/
def bump (seen t : Token) : Token := if seen < t then t else seen

theorem accepts_iff (seen t : Token) : accepts seen t = true ↔ seen < t := by
  unfold accepts; exact decide_eq_true_iff

/-- A holder whose token has been superseded is refused. Staleness is detectable. -/
theorem stale_token_rejected {seen t : Token} (h : t ≤ seen) : accepts seen t = false := by
  unfold accepts
  simp only [decide_eq_false_iff_not, Nat.not_lt]
  exact h

/--
  **FENCING.** Once the sink has honoured the newer holder's token, every effect
  the older holder attempts is refused — for good, since the watermark only
  rises. This is what actually excludes a lapsed agent from the world, and it is
  the piece `leases` does not provide.
-/
theorem fencing_excludes {seen old new : Token}
    (hlt : old < new) (hseen : accepts seen new = true) :
    accepts (bump seen new) old = false := by
  have hs : seen < new := (accepts_iff seen new).mp hseen
  have hb : bump seen new = new := by unfold bump; exact if_pos hs
  rw [hb]
  exact stale_token_rejected (Nat.le_of_lt hlt)

/-- The watermark never decreases, so a rejection is permanent. -/
theorem bump_monotone (seen t : Token) : seen ≤ bump seen t := by
  unfold bump
  by_cases h : seen < t
  · rw [if_pos h]; exact Nat.le_of_lt h
  · rw [if_neg h]; exact Nat.le_refl seen

end FrontDesk.Leases
