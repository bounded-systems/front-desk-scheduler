# ⚠ DRAFT — copy into bounded-systems/infra; NOT applied from this repository.
#
# The GitHub half of L1 — phase 1 of docs/credential-chain.md. Needs NO new
# stored secret: the provider authenticates with a broker-minted App token
# (see versions.tf), so this half is bootstrapped by the mint itself.

# The reviewer gate lease-deploy.yml asserts before it will run. Managing it
# here means "the gate exists" is a reviewed diff, not a clicked setting —
# and GitHub's auto-create-on-reference (an environment named by a workflow
# springs into existence with NO protection rules) stops being a hazard,
# because tofu owns the environment before any workflow references it.
resource "github_repository_environment" "lease_deploy" {
  repository  = "front-desk-scheduler"
  environment = "lease-deploy"

  reviewers {
    users = [1240090] # bdelanghe
  }
}

resource "github_repository_environment" "mirror_write" {
  repository  = "front-desk-scheduler"
  environment = "mirror-write"

  reviewers {
    users = [1240090]
  }
}

# Standing configuration ONLY. FDS_CLAIM_ENDPOINT is deliberately absent: it is
# an OUTPUT of lease-deploy (the URL of the worker it just deployed), and a
# value tofu cannot know does not belong in tofu state — see "Boundary worth
# keeping" in docs/credential-chain.md.
resource "github_actions_variable" "cf_broker_path" {
  repository    = "front-desk-scheduler"
  variable_name = "FRONT_DESK_CF_BROKER_PATH"
  value         = "/cloudflare/front-desk-lease" # match the broker's route table
}
