# ⚠ DRAFT — copy into bounded-systems/infra; NOT applied from this repository.

terraform {
  required_version = ">= 1.7" # OpenTofu >= 1.7 equally

  # State backend: R2 (S3-compatible). ⚠ STATE CONTAINS TOKEN VALUES —
  # cloudflare_api_token resources store the minted secret in state, so this
  # bucket IS credential storage: private, no public access, its own access key
  # held only by the gated apply workflow. Skipping this warning re-creates the
  # stored-secret problem in a bucket.
  backend "s3" {
    bucket                      = "<R2_STATE_BUCKET>"
    key                         = "broker/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }
}

# The Cloudflare provider authenticates with the L0 ROOT (token-admin): the one
# human-created credential, held as a gated environment secret in infra. It sits
# ABOVE broker_parent in the chain — D2 in Delegation.lean is exactly the
# statement that it cannot be replaced by anything the broker can mint.
provider "cloudflare" {
  # api_token from CLOUDFLARE_API_TOKEN env var, supplied by the apply workflow.
}

# The GitHub provider authenticates with a BROKER-MINTED App token (per-run,
# expiring) — the half of the bootstrap the mint CAN do. Requires the GH_APPS
# map to grant the front-desk App `environments: write` + `variables: write`.
provider "github" {
  owner = "bounded-systems"
  # token from GITHUB_TOKEN env var, minted by broker-gh-token in the workflow.
}
