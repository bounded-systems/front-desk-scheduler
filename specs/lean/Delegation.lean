/-
  Delegation.lean — the ALGEBRA projection of the credential chain.

  Companion to Leases.lean (S1) and FrontDesk.lean (S2). Subject: the broker —
  cf-oidc-token-broker mints short-lived Cloudflare/GitHub tokens for workflows
  that prove their identity over OIDC. The chain is

      L0 human-created root  →  L1 infra (tofu)  →  L2 broker  →  L3 workflows

  and the property the whole design leans on is that authority only ever flows
  DOWN it. docs/credential-chain.md is the map; this file is the algebra.

  WHAT THIS FILE IS FOR
  ---------------------
  On 2026-07-28 a mint against the live broker failed:

      HTTP 502  cf_errors 9109 "Unauthorized to access requested resource"
                token_check ok

  i.e. the broker's parent credential was alive, and Cloudflare refused to ISSUE
  the requested policy. Two responses were on the table: fix it from below (have
  the broker or a minted child widen the parent) or fix it from above (a human,
  at the dashboard, at L0). The theorems below are the argument that "from
  below" is not a workaround being withheld — under C1 it is IMPOSSIBLE, and
  that impossibility is the security property, not an inconvenience.

  As with Leases.lean, the theorems are only as good as the named assumptions,
  and one of them is genuinely uncertain:

  ── THE TWO EXTERNAL ASSUMPTIONS ──────────────────────────────────────────────

  C1 (MINT IS SUBSET-CAPPED). A token created or edited via another token holds
     at most the creator's scopes. Modeled as the `Sub child parent` hypothesis
     on `mint`/`edit` — the analog of A1's "the engine supplies the atomicity".

     ⚠ C1's truth for Cloudflare is UNRESOLVED, and this file does not pretend
     otherwise. The observed 9109 is consistent with C1. But the broker's own
     SECURITY.md (R4) says a token with "API Tokens: Edit" can mint "up to the
     account owner's full scope", which contradicts it — under that reading the
     9109 was a policy-resource mismatch, not a subset cap. The monitor
     (.github/workflows/broker-drift.yml) is what decides: it mints each tier
     and probes minted tokens read-only for authority they should not have.
     If C1 is FALSE, `attainable_le_root` says nothing about the world, and the
     design response is R4's: treat the parent as account-root and guard it
     accordingly — which the tofu draft does regardless, by deriving the
     parent's scopes as exactly the union of the mintable tiers.

  C2 (ROOT IS MANAGED OUT-OF-BAND ONLY). No in-system principal can reach the
     root credential. Structural in the model — `root` is a parameter and no
     rule rewrites it; the world obligation is that nothing below L0 holds
     token-management scope over the root. Monitored by the same probe: a
     minted token that can touch token management is a C2 violation.

  No mathlib — plain predicates and induction — so it builds from the
  toolchain alone, like the other two files.
-/

namespace FrontDesk.Delegation

/-- A token's authority: a predicate over an abstract permission universe.
    `Scopes α` rather than a concrete enum so the theorems quantify over every
    permission system, not the one we happen to have today. -/
abbrev Scopes (α : Type) := α → Prop

/-- `Sub s t`: every permission `s` grants, `t` also grants. -/
def Sub {α : Type} (s t : Scopes α) : Prop := ∀ x, s x → t x

theorem Sub.refl {α : Type} (s : Scopes α) : Sub s s := fun _ h => h

theorem Sub.trans {α : Type} {s t u : Scopes α} (h₁ : Sub s t) (h₂ : Sub t u) :
    Sub s u := fun x hx => h₂ x (h₁ x hx)

/-
  Attainable authority. `Attainable root t` = starting from the root, some
  sequence of mints and edits can put a live token with scopes `t` in the world.

  `mint` and `edit` have the same algebraic shape (both are C1-capped), but they
  model different API calls — POST /user/tokens vs PUT /user/tokens/{id} — and
  keeping both constructors keeps the correspondence with the broker legible.
-/
inductive Attainable {α : Type} (root : Scopes α) : Scopes α → Prop
  | root : Attainable root root
  | mint {parent child : Scopes α} :
      Attainable root parent → Sub child parent → Attainable root child
  | edit {editor target : Scopes α} :
      Attainable root editor → Sub target editor → Attainable root target

/--
  D1 (MONOTONE BOUND). Every attainable token is bounded by the root — over any
  number of mints and edits, in any order. The bound does not decay with depth:
  a child of a child of a child is still capped by the same root.
-/
theorem attainable_le_root {α : Type} {root t : Scopes α}
    (h : Attainable root t) : Sub t root := by
  induction h with
  | root => exact Sub.refl _
  | mint _ hsub ih => exact Sub.trans hsub ih
  | edit _ hsub ih => exact Sub.trans hsub ih

/--
  D2 (CANNOT WIDEN FROM BELOW). Authority the root lacks is unattainable —
  by the broker, by any minted child, by any chain of them. This is the
  theorem behind "the 9109 cannot be fixed with the mint": the only sound move
  is at L0, above the chain, which is exactly where the model has no rule.
-/
theorem cannot_widen_from_below {α : Type} {root want : Scopes α}
    (hw : ¬ Sub want root) : ¬ Attainable root want :=
  fun h => hw (attainable_le_root h)

/-- A tier DERIVED from the parent: the parent's authority restricted by a
    request. This is the tofu phase-3 move — `locals` define tiers as
    restrictions of one definition, not as an independent list. -/
def restrict {α : Type} (parent want : Scopes α) : Scopes α :=
  fun x => parent x ∧ want x

theorem restrict_sub {α : Type} (parent want : Scopes α) :
    Sub (restrict parent want) parent := fun _ h => h.1

/--
  D3 (DERIVED TIERS NEVER DRIFT). If the requested tier is BY CONSTRUCTION a
  restriction of the parent, the mint hypothesis holds for every request — there
  is no `want` for which it can fail. Drift is not detected; it is
  unrepresentable. This is the theorem the tofu draft's `scopes.tf` implements:
  parent scopes = union of the tiers, so each tier is a restriction of the
  parent definitionally.
-/
theorem derived_tiers_never_drift {α : Type} {root parent : Scopes α}
    (hp : Attainable root parent) (want : Scopes α) :
    Attainable root (restrict parent want) :=
  Attainable.mint hp (restrict_sub parent want)

/-- Drift: a request the parent cannot cover. What HTTP 502 / cf 9109 looks
    like from inside the algebra. -/
def Drift {α : Type} (parent request : Scopes α) : Prop := ¬ Sub request parent

/--
  INDEPENDENTLY-DEFINED TIERS CAN DRIFT: the counterexample that makes D3 worth
  having. With scopes over `Nat`, a parent holding only permission 0 and a
  request asking for permission 1 drift by witness. Two sources of truth —
  scopes set at a dashboard, policy written in code — admit exactly this state,
  and the 2026-07-28 mint failure was this lemma happening in production.
-/
theorem independent_definitions_can_drift :
    ∃ (parent request : Scopes Nat), Drift parent request := by
  refine ⟨(· = 0), (· = 1), ?_⟩
  intro h
  exact Nat.one_ne_zero (h 1 rfl)

/--
  Sanity: D3 and the counterexample are not in tension — `restrict` tiers never
  drift, for ANY parent and want. The difference between the two lemmas is
  precisely whether the tier's definition mentions the parent.
-/
theorem restrict_never_drifts {α : Type} (parent want : Scopes α) :
    ¬ Drift parent (restrict parent want) :=
  fun hd => hd (restrict_sub parent want)

end FrontDesk.Delegation
