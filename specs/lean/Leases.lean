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

  Mirrors src/mirror.ts (claimNext / releaseClaim) and schema/mirror.sql; the
  referent section at the bottom mirrors worker/lease/src/lease-core.mjs
  (decideClaim / decideBind / decideRelease / decideReap), which is where the
  lease decision actually lives since the DO became ground truth for exclusion.
  No mathlib — core `Nat`/`List` + `decide`/`omega` — so it builds from the
  toolchain alone, like FrontDesk.lean.

  A1 and A2 below are the whole-file assumptions. The referent section adds two
  of its own (A3, A4) at the point where it needs them.
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

     EMPIRICALLY TESTED since 2026-07-28: scripts/claim-race.ts races N real
     concurrent claimants against a running dolt sql-server and requires
     exactly one winner (CI: claim-race.yml). Its first run caught two bugs of
     exactly the species this file warns about — a TOCTOU commit guard in the
     seam, and unhandled optimistic-concurrency retries (Dolt surfaces
     contention as SQLSTATE 40001 rather than blocking; each retry is still
     atomic, so S1 is preserved). Models bound the design; the experiment
     binds the deployment.

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

/-! ## The referent, and the collector (#105)

Everything above models ONE transition: `latch`, the claim. That was adequate
while claiming was the only way the cell changed — but #105 added two more, and
one of them is a shape this file had never seen:

  `bind`   the holder pins the lease to a REFERENT (its PR), which is what
           decides when the lease drops. Gated on holder + current fencing.
  `reap`   a COLLECTOR frees the lease, having observed the referent merged,
           closed, or gone. Gated on the current fencing AND the current
           referent — and deliberately NOT on the caller being the holder,
           because the whole premise is a holder who is finished or dead.

`reap` is the first transition that frees a lease and the first performed by a
non-holder, so the obligations it carries are new. Note precisely what that
does to `runAll_preserves_holder` above: the theorem is still TRUE — it
quantifies over schedules of latches — but its informal reading ("once held,
nothing displaces the holder") is now wrong, because a reap displaces the
holder on purpose. Leaving that gap unstated is the 2026-07-27 failure mode
exactly: not a wrong proof, a proof of a narrower obligation than the one the
reader believes. So the model is widened here rather than the reading being
left to trust.

WHAT THIS SECTION ABSTRACTS AWAY (stated, per this file's house rule)

  A3  LIVENESS IS THE CELL, NOT THE CLOCK. The implementation's `isLive` also
      consults `expiresAt`; here "held" is `holder ≠ none`. This is the SAME
      abstraction the sections above make, and it is sound for the safety
      properties below — every one of them is of the form "this transition
      cannot free/grant the wrong thing", and a clock can only make a
      transition refuse MORE often, never less. What it means is that the
      BACKSTOP is not modelled: "an unreaped lease eventually lapses" is a
      liveness property resting on the clock, and it is not proven here.

  A4  THE ORACLE IS NOT MODELLED. Whether a PR really is merged/closed/gone is
      `verdictFromPrProbe` in src/reaper.ts — tested, not proven, and it
      cannot be proven here because it is a fact about GitHub. What IS proven
      below is that a reaper acting on STALE or WRONG evidence changes
      nothing, which is the half that does not depend on the oracle. -/

/-- An opaque referent identity. The implementation's `{kind, id}` collapses to
    a `Nat` here because nothing in these proofs inspects a referent — they
    only ever COMPARE two, which is precisely the DO's own posture: it stores
    and matches the referent, and only the reaper interprets `kind`. -/
abbrev Ref := Nat

/-- The lease cell, carrying what #105 added. Still ONE holder slot — which is
    why exclusion survives the new transitions for free (see below). -/
structure St where
  holder   : Option Agent
  fencing  : Token
  referent : Option Ref
  deriving DecidableEq, Repr

/-- The empty lease. Mirrors `EMPTY_STATE` in worker/lease/src/lease-core.mjs. -/
def St.empty : St := { holder := none, fencing := 0, referent := none }

/-- `decideClaim`. Granted only when free; every grant strictly out-fences, and
    starts REFERENT-LESS — a fresh grant never inherits the previous holder's
    referent, or the collector could free it on somebody else's merge. -/
def claim (a : Agent) (s : St) : St :=
  match s.holder with
  | none   => { holder := some a, fencing := s.fencing + 1, referent := none }
  | some _ => s

/-- `decideBind`. Holder + current fencing; sets the referent, touching neither
    the holder nor the counter. -/
def bind (a : Agent) (f : Token) (r : Ref) (s : St) : St :=
  if s.holder = some a ∧ f = s.fencing then { s with referent := some r } else s

/-- `decideRelease`. Holder + current fencing; frees, RETAINING the counter. -/
def release (a : Agent) (f : Token) (s : St) : St :=
  if s.holder = some a ∧ f = s.fencing then
    { holder := none, fencing := s.fencing, referent := none }
  else s

/-- `decideReap`. No agent gate — the holder cannot speak. The gates are the
    CURRENT fencing and the CURRENT referent, both read from one `/status`
    snapshot, and the counter is retained exactly as `release` retains it. -/
def reap (f : Token) (r : Ref) (s : St) : St :=
  if s.holder ≠ none ∧ f = s.fencing ∧ s.referent = some r then
    { holder := none, fencing := s.fencing, referent := none }
  else s

/-! ### What a reap cannot do -/

/-- **A reap never grants.** It frees or it does nothing; no agent can come to
    hold the lease by way of a reap. This is what keeps the collector outside
    the exclusion argument entirely. -/
theorem reap_never_grants (f : Token) (r : Ref) (s : St) (a : Agent)
    (h : (reap f r s).holder = some a) : s.holder = some a := by
  unfold reap at h
  split at h
  · exact absurd h (by simp)
  · exact h

/-- **A reap retains the counter.** Resetting it would let a later grant reuse
    a token an old zombie still carries — the same reason `release` retains it. -/
theorem reap_preserves_fencing (f : Token) (r : Ref) (s : St) :
    (reap f r s).fencing = s.fencing := by
  unfold reap; split <;> rfl

/-- **A stale collector is a no-op.** The reaper read `/status`, the world
    moved, and its reap lands against a fencing it no longer matches. This is
    the zombie-release theorem one actor over: the collector's belief is
    checked against the cell rather than trusted. -/
theorem stale_reap_noop {f : Token} {r : Ref} {s : St} (h : f ≠ s.fencing) :
    reap f r s = s := by
  unfold reap
  rw [if_neg]
  intro hc
  exact h hc.2.1

/-- **A reap against a referent the lease is no longer pinned to is a no-op.**
    The holder re-bound (a PR closed and was superseded); evidence gathered
    against the old one is stale. -/
theorem mismatched_reap_noop {f : Token} {r : Ref} {s : St} (h : s.referent ≠ some r) :
    reap f r s = s := by
  unfold reap
  rw [if_neg]
  intro hc
  exact h hc.2.2

/-- **A referent-less lease is NEVER reapable.** Nothing materialized, so no
    observation about a referent can mean anything for it. That corpse belongs
    to the backstop TTL — which is why #105 demotes expiry rather than deleting
    it, and why an unrecognised referent kind cannot mean "immortal". -/
theorem referentless_never_reaped {f : Token} {r : Ref} {s : St} (h : s.referent = none) :
    reap f r s = s :=
  mismatched_reap_noop (by simp [h])

/-- **The race the collector had to survive, end to end.** Alice holds the item
    with her PR bound. The reaper reads `/status` — fencing `s.fencing`,
    referent `r` — and *then*, before its reap lands, alice releases and bob
    claims. The stale reap must not free bob's brand-new lease.

    It is refused TWICE OVER, which is the belt and braces worth having: bob's
    grant out-fences what the reaper observed, AND bob's grant is
    referent-less. Either gate alone suffices. -/
theorem reaper_cannot_free_the_new_holder
    (alice bob : Agent) (r : Ref) (s : St)
    (hheld : s.holder = some alice) :
    reap s.fencing r (claim bob (release alice s.fencing s)) = claim bob (release alice s.fencing s) := by
  have hrel : release alice s.fencing s = { holder := none, fencing := s.fencing, referent := none } := by
    unfold release; rw [if_pos ⟨hheld, rfl⟩]
  rw [hrel]
  -- bob's grant: fencing s.fencing + 1, referent none. Refused on both counts;
  -- we discharge it on the referent, the gate that needs no arithmetic.
  exact referentless_never_reaped rfl

/-- And the counter really did move, so alice's old token can never be reused —
    the premise `fencing_excludes` above needs to keep excluding her. -/
theorem takeover_after_release_outfences (alice bob : Agent) (s : St)
    (hheld : s.holder = some alice) :
    s.fencing < (claim bob (release alice s.fencing s)).fencing := by
  have hrel : release alice s.fencing s = { holder := none, fencing := s.fencing, referent := none } := by
    unfold release; rw [if_pos ⟨hheld, rfl⟩]
  rw [hrel]
  exact Nat.lt_succ_self s.fencing

/-! ### What a bind cannot do

`bind` sets the trigger that decides when the lease DROPS, so a stranger who
could set it would have a release primitive on someone else's lease. It is
gated like renew for exactly that reason. -/

/-- Binding never moves the holder — it cannot grant or free. -/
theorem bind_preserves_holder (a : Agent) (f : Token) (r : Ref) (s : St) :
    (bind a f r s).holder = s.holder := by
  unfold bind; split <;> rfl

/-- Binding never re-fences: the token is stable for the life of a grant, which
    is the one number the effect side depends on not moving. -/
theorem bind_preserves_fencing (a : Agent) (f : Token) (r : Ref) (s : St) :
    (bind a f r s).fencing = s.fencing := by
  unfold bind; split <;> rfl

/-- A non-holder cannot arm another agent's lease for collection. -/
theorem nonholder_bind_noop {a : Agent} {f : Token} {r : Ref} {s : St}
    (h : s.holder ≠ some a) : bind a f r s = s := by
  unfold bind
  rw [if_neg]
  intro hc
  exact h hc.1

/-- Nor can a holder presenting a superseded token. -/
theorem stale_bind_noop {a : Agent} {f : Token} {r : Ref} {s : St}
    (h : f ≠ s.fencing) : bind a f r s = s := by
  unfold bind
  rw [if_neg]
  intro hc
  exact h hc.2

/-! ### S1 and fencing, over the ENLARGED transition set

The obligation this section exists to discharge. Above, a schedule was a list
of agents (latches). Here it is a list of arbitrary transitions, so the
quantifier finally covers the machine that actually runs. -/

/-- One step of the real lease machine. -/
inductive Step where
  | claim   (a : Agent)
  | bind    (a : Agent) (f : Token) (r : Ref)
  | release (a : Agent) (f : Token)
  | reap    (f : Token) (r : Ref)

/-- Deliberately NOT `Step.apply`: defining it in the `Step` namespace opens
    that namespace for the body, where `claim`/`bind`/`reap` would resolve to
    the CONSTRUCTORS rather than to the transitions above — a shadowing that
    typechecks into nonsense. -/
def applyStep : Step → St → St
  | .claim a,     s => claim a s
  | .bind a f r,  s => bind a f r s
  | .release a f, s => release a f s
  | .reap f r,    s => reap f r s

/-- One list is one interleaving; quantifying over the list quantifies over
    every schedule of every size, now mixing all four transitions. -/
def runSteps : List Step → St → St
  | [],      s => s
  | st :: rest, s => runSteps rest (applyStep st s)

/-- **S1, over the enlarged set.** At most one agent observes itself as holder,
    in any state reachable by ANY schedule of claims, binds, releases and
    reaps. The proof still needs nothing: the state is still a cell, so two
    holders remain unrepresentable. That is the point worth recording — adding
    a collector did not reintroduce the shape the 2026-07-27 bug lived in. -/
theorem exclusion_over_mixed_schedules (steps : List Step) (s : St) {a b : Agent}
    (ha : (runSteps steps s).holder = some a)
    (hb : (runSteps steps s).holder = some b) : a = b := by
  rw [ha] at hb
  exact Option.some.inj hb

/-- Every single step leaves the counter where it was or raises it. -/
theorem fencing_monotone_step (st : Step) (s : St) : s.fencing ≤ (applyStep st s).fencing := by
  cases st with
  | claim a =>
    simp only [applyStep, claim]
    split
    · exact Nat.le_succ s.fencing
    · exact Nat.le_refl s.fencing
  | bind a f r =>
    simp only [applyStep]
    exact Nat.le_of_eq (bind_preserves_fencing a f r s).symm
  | release a f =>
    simp only [applyStep, release]
    split <;> exact Nat.le_refl s.fencing
  | reap f r =>
    simp only [applyStep]
    exact Nat.le_of_eq (reap_preserves_fencing f r s).symm

/-- **The fencing counter never decreases, under any schedule.** This is what
    makes the sink watermark above (`fencing_excludes`) applicable to the new
    world: a token that has been superseded stays superseded, so a holder the
    COLLECTOR displaced is refused by the effect side exactly as one the clock
    displaced was. Reap frees the queue slot; fencing is what excludes the
    reaped holder from the world. -/
theorem fencing_monotone (steps : List Step) (s : St) :
    s.fencing ≤ (runSteps steps s).fencing := by
  induction steps generalizing s with
  | nil => exact Nat.le_refl s.fencing
  | cons st rest ih => exact Nat.le_trans (fencing_monotone_step st s) (ih (applyStep st s))

/-- No schedule can make the lease grant itself: a held state is only ever
    reached by a `claim` step, never by a bind, release or reap. Stated as the
    contrapositive that matters — from a FREE lease, no schedule of binds,
    releases and reaps produces a holder. -/
theorem no_grant_without_claim (steps : List Step) (s : St)
    (hfree : s.holder = none)
    (hnoclaim : ∀ st ∈ steps, ∀ a, st ≠ Step.claim a) :
    (runSteps steps s).holder = none := by
  induction steps generalizing s with
  | nil => exact hfree
  | cons st rest ih =>
    have hstep : (applyStep st s).holder = none := by
      cases st with
      | claim a => exact absurd rfl (hnoclaim (Step.claim a) List.mem_cons_self a)
      | bind a f r =>
        simp only [applyStep]
        rw [bind_preserves_holder]; exact hfree
      | release a f =>
        simp only [applyStep]
        unfold release; split <;> simp_all
      | reap f r =>
        simp only [applyStep]
        unfold reap; split <;> simp_all
    exact ih (applyStep st s) hstep (fun x hx => hnoclaim x (List.mem_cons_of_mem st hx))

end FrontDesk.Leases
