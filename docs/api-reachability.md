# What each identity can reach on the GitHub API

Two identities do this org's GitHub work, and **neither one dominates the
other**. A cloud session can read repository files and cannot touch ProjectV2;
the Front Desk App can write the board and cannot read a file. That is not a
gradient of privilege — it is two differently-shaped holes, and the practical
consequence is that "can X be done?" has no answer until you say *by whom*.

| | cloud session | Front Desk App (`front-desk` tier) |
|---|---|---|
| shaped by | the egress proxy's policy — imposed | the `GH_APPS` permission map — chosen |
| repo file reads | **yes** | no (`contents` deliberately absent) |
| ProjectV2 / GraphQL | no, by any spelling | **yes** — this is its whole job |
| issue writes | **yes** | no (`issues:read` — see #168) |
| where it runs | the session container | a GitHub Actions runner |

Sections below take them one at a time. The session plane is probed and
asserted on demand; the App plane is not, and [why](#the-app-plane-is-not-probed-and-cannot-be-from-here)
is itself load-bearing.

## The session plane

Measured 2026-08-06 by probing every endpoint class the MCP github toolset
exposes, through the session's egress proxy, with the ambient `proxy-injected`
sentinel. Re-derive with `scripts/audit-api-reachability.sh`, which asserts
this posture **in both directions** and exits nonzero on drift — a blocked
route quietly opening is as much a policy change as an open one closing.

The question this answers is not "what is blocked" but **"does every
capability the strategy depends on still have a route"**. The desired outcome,
stated as the invariants the audit asserts:

| id | invariant | why it is the strategy |
|----|-----------|------------------------|
| I1 | repo-scoped reads + issue/PR writes are open | the verify loop — read the mirror, read the run, read the verdict line — needs no MCP and no budget negotiation |
| I2 | content writes (`contents`, `git/*`, `forks`) are closed; `git push` works | one write path, credential injected at the proxy, every change rides the PR pipeline |
| I3 | raw workflow dispatch is closed **at the token** | ticket windows are driven via the MCP `actions_run_trigger` tool; there is exactly one dispatch route to reason about |
| I4 | GraphQL is closed entirely | ProjectV2 has no session route by ANY spelling, so board work goes through windows — this is the load-bearing fact behind `needs: [github-api]` |
| I5 | everything non-`/repos` is closed | search/org/user surfaces exist only over MCP, whose credential is not the session's |

## The matrix, by MCP tool group

"MCP" means the tool answers through the MCP github server; "raw" means the
same capability is reachable with `curl` against `api.github.com` from the
session. They differ because **the MCP server holds its own credential and its
own policy** — `search_issues` and `list_repository_collaborators` both answer
over MCP while the same REST paths 403 at the proxy. Reachable-over-MCP does
not imply reachable-over-raw, in either direction.

| group | raw API | MCP only | no session route at all |
|---|---|---|---|
| identity | `get_me` | | |
| repo/files | reads: `get_file_contents`, `list_branches`, `list_commits`, `get_commit`, `list_tags`, `get_tag` | | writes: `create_repository`, `fork_repository`, `create_or_update_file`, `push_files`, `delete_file`, `create_branch` — **use `git push`** |
| issues | `issue_read`, `issue_write`, `list_issues`, `add_issue_comment`, `sub_issue_write`, `get_label` | `list_issue_types` | |
| pull requests | `pull_request_read`, `list_pull_requests`, `create_pull_request`, `update_pull_request`, `update_pull_request_branch` | | `merge_pull_request` (dedicated proxy block), `enable/disable_pr_auto_merge` (GraphQL) |
| review | `pull_request_review_write`, `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `request_copilot_review` | | `resolve/unresolve_review_thread` (GraphQL) |
| actions/CI | `actions_list`, `actions_get`, `get_check_run`; `get_job_logs` metadata only | `actions_run_trigger`, `get_job_logs` **bodies** (see below) | |
| releases | all three | | |
| search | | all six | |
| org/teams | | `get_teams`, `get_team_members`, `list_repository_collaborators` | |
| copilot | | | all three (GraphQL/copilot host) |
| security | | `run_secret_scanning` | |
| PR activity | | | n/a — `subscribe/unsubscribe_pr_activity` are CCR-internal, not GitHub API |

Two rows earn their footnotes. **Job log bodies**: the REST path answers, but
it answers with a 302 to `*.blob.core.windows.net`, and CONNECT to that host
fails at the proxy — so raw curl gets metadata and zero log bytes. Reading a
window's `FDS-*-RESULT` line therefore goes through the MCP `get_job_logs`
tool. **Dispatch**: `POST …/dispatches` refuses with `Resource not accessible
by integration` — GitHub's voice, not the proxy's — so this is the injected
token's shape, and installing better tooling changes nothing (the same
identity-not-tooling boundary as the 2026-07-31 `gh` measurement in
CLAUDE.md).

## The five refusal classes

Worth telling apart because they imply different workarounds, and because the
audit classifies on the message, not the code — everything below is a 403:

| class | message fragment | speaker | meaning |
|---|---|---|---|
| `scope` | "bound to their configured repositories" | proxy | path is outside `/repos/{owner}/{repo}` — no repo-scoped respelling exists, use MCP |
| `proxy-write` | "Write access … not permitted through this proxy" | proxy | content write — the answer is `git push`, always |
| `proxy-path` | "Access to this GitHub API path is not permitted" | proxy | repo-scoped but denylisted (collaborators, secret-scanning) — MCP |
| `merge-block` | "Merging pull requests is not permitted for this session type" | proxy | its own rule; merging is a human/MCP act |
| `token` | "Resource not accessible by integration" | GitHub | the injected token lacks it — no proxy change would open it |

GraphQL is a sixth speaker: every query 403s with "only the pinned set of
PR-review operations is served", including `{ viewer { login } }` and a
`reviewThreads` query — so treat the pin as empty in practice and route
through REST or a window.

## What the audit does not establish

The MCP half of I3 — that `actions_run_trigger` actually *dispatches* — is a
production action the audit deliberately never takes, so the `token` row above
is not evidence for it either way. It is established instead by driving a
real window loop, and it was, on 2026-08-06 in one session minutes apart:
`curl …/claim-ticket.yml/dispatches` → 403, `actions_run_trigger` on the same
workflow → 204 with `FDS-CLAIM-RESULT` read back inside the minute. That
measurement lives in `docs/claiming-from-a-session.md` and the matching
`.claude/cloud-environment.json` caveat; this file defers to it rather than
keeping a second copy that can rot. If the date is old and you are about to
depend on it, re-prove with a harmless window (`board-parity.yml`) — the loop,
not the unit.

**Do not read the raw 403 as the window being shut.** That inference is
already in the tree once — `proposals/broker-session-tier/` cites
`workflow_dispatch → 403` as evidence the ticket window is expensive to reach,
which is right about the *verb* and wrong about the *window*. The `token` row
says a session-side **script** cannot dispatch (no `gh`, 403 from curl,
no route to the agent's MCP tools). It says nothing about the window, which is
open. Every "closed" row in this matrix is a statement about the raw plane
only; check the MCP column, and then the App plane below, before concluding a
capability is unreachable at all.

The probes are non-mutating **by construction**, not by expectation: every
write-shaped probe aims at a nonexistent id, the all-zeros sha, or an invalid
payload, so a probe that unexpectedly clears the proxy is refused by GitHub
with 404/422 — which is itself the evidence the path is served. Keep that
property when adding probes; do not "fix" one by making its payload valid.

## The App plane

An App token is minted on a GitHub runner and never traverses the session's
egress proxy, so **all five refusal classes above simply do not apply** —
`scope`, `proxy-write`, `proxy-path`, `merge-block`, and the GraphQL pin are
session artifacts, not properties of this org's GitHub access. What replaces
them is a permission map the broker *chooses* per tier. So on this plane the
question is rarely "is it reachable" and almost always **"is it in the tier"**,
which is the whole reason [prefer building the window](../CLAUDE.md) works as
standing advice rather than as a workaround.

Three tiers exist, same App and key, different broker entries. The pins are the
security design, not bookkeeping:

| broker route | permissions | pinned to |
|---|---|---|
| `/github/front-desk` | `organization_projects:write issues:read metadata:read pull_requests:write` | **nothing** — any workflow in any `bounded-systems` repo can mint it |
| `/github/front-desk-schema` | adds `contents:write` | `mirror-migrate.yml` only |
| `/github/front-desk-publish` | full grant | `lease-deploy.yml` only |

**`contents` is deliberately absent from `front-desk`, and that single omission
moves more rows than anything else.** It is the one unpinned multi-repo
fan-in, so granting it would hand repository write to the whole org —
`test/broker-scope.test.ts` asserts its absence for exactly that reason. The
side effect is the counterintuitive half of the table at the top of this file:
under `front-desk` the App **cannot read repository files**, a capability the
session has freely.

### The matrix under `front-desk`

| group | reachable today | needs a scope this tier doesn't request | impossible for any App |
|---|---|---|---|
| identity | — | — | `get_me` — `/user` needs user context an installation token has not got |
| repo/files | — | every read *and* write (`contents`) | `create_repository` (org admin) |
| issues | `issue_read`, `list_issues`, `get_label` | `issue_write`, `add_issue_comment`, `sub_issue_write` (**#168**) | — |
| pull requests | `pull_request_read`, `list_pull_requests`, `create_pull_request`, `update_pull_request` | `merge_pull_request` (also needs `contents:write`) | — |
| review | all four, **plus `resolve/unresolve_review_thread` and `enable_pr_auto_merge`** — GraphQL is open here | — | — |
| actions/CI | — | all five (`actions:read`/`write`) — but `get_job_logs` would get real bytes, no Azure-blob block | — |
| **ProjectV2** | **full read + write** — `organization.projectV2.items`, `updateProjectV2ItemFieldValue`, `gh project item-edit` | — | — |
| search | `search_issues` | `search_code` (`contents`) | `search_users` |
| releases | — | all three (`contents:read`) | — |
| org/teams | — | all three (`members:read`) | — |

**Provenance, because the two halves are not equally solid.** The ProjectV2 and
`search_issues` rows are *measured* — `src/mirror.ts` and
`scripts/status-writeback.ts` make those calls under this token and their lanes
run green. The rows marked as needing an unrequested scope are *inferred* from
the granted map plus GitHub's documented permission→endpoint mapping. That
inference has been wrong-shaped twice before, both times the same way: the mint
succeeded, the token was real, and the API 403'd anyway (runs 30373059795 on
`createPullRequest`, 30641376455 on `create-a-reference`). Treat an inferred row
as a prediction, not a measurement.

### Reading the granted map without dispatching anything

`broker-drift` mints each tier and compares what GitHub *granted* to what
`min_perms_for` *declares* — so its run output already contains the answer to
"what does this token actually hold", and reading it costs nothing and writes
nothing. The trick is that the step summary renders its conditionals with the
counts substituted, so a green run shows:

```
if [ "0" != "0" ]; then   # a tier's granted scope is WIDER than declared → 0
```

`wide = 0` on a green run means granted ≡ declared, exactly. That is how #168
was confirmed on 2026-08-06 (run 31089399737) — the alternative was dispatching
`triage-ticket.yml` at a real issue and watching whether it got closed, which
would have meant retiring a live item to test a permission.

Generalise it: **when a lane already measures the thing you want, read its
expansion instead of building a probe.** The measurement is usually sitting in a
green run nobody opened.

### The App plane is not probed, and cannot be from here

There is no App-token equivalent of `audit-api-reachability.sh`, and a session
cannot write one that runs: `verifyOIDC` pins `job_workflow_ref`, so only a
GitHub Actions runner can mint these tokens at all. Closing this gap means a
workflow — and that workflow needs its own `GH_APPS` allowlist entry before its
first run does anything (the #112 shape, which is what makes it a real piece of
work rather than a copy of the session script).

Two consequences worth holding. **This table can rot silently** in a way the
session table cannot, because nothing exits nonzero when it drifts. And
`broker-drift` does *not* close that gap: it asserts declared-vs-granted, which
is upstream of whether an endpoint answers. `test/window-scope.test.ts` covers
one more slice — declared-vs-**needed**, statically — and the remainder,
granted-vs-**actually-reachable**, is still discovered only by a production run
failing.

## When drift appears

Update this file, the audit's expectations, and the CLAUDE.md paragraphs that
lean on the changed row — in the same PR. The likeliest legitimate drifts:
Anthropic widens or narrows the proxy allowlist (whole classes move at once),
or GitHub reshapes an endpoint (one row moves alone). A single flipped row in
I2/I4/I5 with no announcement deserves suspicion before celebration: the
strategy's security posture *is* those rows staying closed.

On the App plane the trigger is different: drift there comes from a `GH_APPS`
edit in `bounded-systems/infra`, which is a **different repo from
`bdelanghe/infra`** — the latter is a near-empty skeleton (README and three
`.gitkeep` files), and a session scoped to it will find no broker config and can
easily conclude the map was deleted rather than that it is looking in the wrong
place. Same shape as the `fencing: 0` trap in CLAUDE.md: an empty read that
cannot, on its own, tell you which of the two it is. Confirm the repo before
concluding anything from its emptiness.

When the tier map does change, `test/window-scope.test.ts` is what tells you:
update `min_perms_for` in `broker-drift.yml` to match the new grant, and its
`KNOWN_GAPS` entries fail until the ones the change healed are deleted.
