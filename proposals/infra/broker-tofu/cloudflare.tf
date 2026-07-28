# ⚠ DRAFT — copy into bounded-systems/infra; NOT applied from this repository.
#
# The Cloudflare half of L1: the broker's parent token as a managed resource.
# Phase 2 of docs/credential-chain.md — needs the L0 token-admin root, so it
# lands AFTER the GitHub half.

variable "cloudflare_account_id" {
  type = string
}

# Resolve permission-group names (scopes.tf) to Cloudflare's global ids at plan
# time, instead of hand-copying opaque ids into config. A renamed group fails
# the plan loudly rather than silently requesting the wrong scope.
data "cloudflare_api_token_permission_groups" "all" {}

locals {
  pg_ids = {
    for name in local.parent_permission_groups :
    name => data.cloudflare_api_token_permission_groups.all.account[name]
  }
}

# THE PARENT — CF_BROKER_TOKEN as code. Its policy is derived from the tiers
# (scopes.tf), so what it HOLDS and what the broker may REQUEST cannot drift:
# the 9109 class ends at this resource.
#
# ⚠ The token value lands in tofu state (see versions.tf). It must then be set
# as the broker Worker's secret; `wrangler secret put CF_BROKER_TOKEN` from the
# apply workflow, or a cloudflare_workers_secret resource if the provider
# version in use supports it.
resource "cloudflare_api_token" "broker_parent" {
  name = "cf-oidc-token-broker-parent"

  policy {
    effect            = "allow"
    permission_groups = values(local.pg_ids)
    resources = {
      "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
    }
  }

  # Rotation is a `tofu apply` away — something the dashboard token never had.
  # Uncomment to enforce expiry once phase-2 rotation is wired:
  # expires_on = timeadd(timestamp(), "2160h") # ~90 days
}

output "broker_parent_token_id" {
  value = cloudflare_api_token.broker_parent.id
}
