# ⚠ DRAFT — copy into bounded-systems/infra; NOT applied from this repository.
#
# scopes.tf — the single source of truth for what the broker may mint.
#
# THE POINT OF THIS FILE (D3 in specs/lean/Delegation.lean)
# ---------------------------------------------------------
# The 2026-07-28 mint failure (HTTP 502, cf 9109) was drift between two
# definitions: the parent token's scopes lived in the Cloudflare dashboard while
# the broker's requested policy lived in code. Two hands that had to agree, and
# nothing made them.
#
# Here the TIERS are the definition and the PARENT IS DERIVED as their union.
# After that, every tier is a subset of the parent *by construction* — the mint
# hypothesis (`Sub tier parent`, C1's cap) holds for every tier, and this class
# of 9109 becomes unrepresentable rather than merely detected. That is theorem
# `derived_tiers_never_drift`; the counterexample lemma
# `independent_definitions_can_drift` is what this file replaces.
#
# test/credential-chain.test.ts pins the shape: the parent MUST be
# `distinct(flatten(values(local.tiers)))` and never a hand-maintained list.

locals {
  # Permission-group NAMES, resolved to ids in cloudflare.tf via the
  # permission_groups data source — names here so a reviewer can read a diff
  # without a lookup table. One key per broker route.
  tiers = {
    # /dolthub-adjacent DNS tier (the broker's original DNS-as-code purpose).
    dns_edit = [
      "Zone Read",
      "DNS Read",
      "DNS Write",
    ]

    # /cloudflare/front-desk-lease — deploy worker/lease. The tier whose
    # absence produced the observed 9109.
    workers_deploy = [
      "Workers Scripts Write",
      "Workers Scripts Read",
      "Account Settings Read", # wrangler resolves the account before deploying
    ]
  }

  # THE DERIVATION. Do not replace with a literal list: a literal list is the
  # second source of truth this file exists to eliminate.
  parent_permission_groups = distinct(flatten(values(local.tiers)))
}
