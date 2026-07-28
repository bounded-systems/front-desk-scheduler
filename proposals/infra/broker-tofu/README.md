# broker-tofu — ⚠ DRAFT, not applied from this repository

The L1 layer of [`docs/credential-chain.md`](../../../docs/credential-chain.md),
drafted here because `bounded-systems/infra` is outside this session's scope.
**Copy into infra; nothing in this repo runs it.**

## What it encodes

One idea: `scopes.tf` defines the broker's mintable tiers **once**, and the
parent token's policy is **derived** as their union. What the parent holds and
what the broker may request can then never disagree — the 9109 drift class
becomes unrepresentable (theorem `derived_tiers_never_drift`,
`specs/lean/Delegation.lean`) instead of detected at 502-time.

| file | contents | phase |
|---|---|---|
| `scopes.tf` | tiers + the derived parent policy — the single source of truth | 1 |
| `github.tf` | environments (+ required reviewers), standing repo variables | 1 |
| `cloudflare.tf` | `broker_parent` token as a managed, rotatable resource | 2 |
| `versions.tf` | providers + R2 state backend | — |

## Bootstrap order

1. **Phase 1 (no new secret):** apply `github.tf` with the GitHub provider
   authenticated by a broker-minted App token (`broker-gh-token` action).
   Requires `environments: write` + `variables: write` in the `GH_APPS` map.
2. **Phase 2 (one new secret, at the top):** a human creates the L0
   token-admin root in the Cloudflare dashboard — once — and parks it as a
   reviewer-gated environment secret in infra. Then `cloudflare.tf` manages the
   broker's parent token as code, and the hand-made `a30f2572…` token is
   retired.

## Two warnings that must survive the copy

- **State contains token values.** `cloudflare_api_token` stores the secret in
  state; the R2 bucket is credential storage and must be private.
- **The L0 root is account-root in effect** (SECURITY.md R4). The gate on the
  apply workflow is the control; the root is touched by nothing else.

## What keeps this draft honest while it sits here

`test/credential-chain.test.ts` pins the D3 shape (parent derived, never
listed), the DRAFT banners, and placeholder hygiene — so the draft cannot
quietly rot into something that looks applyable from the wrong repo.
