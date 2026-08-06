# What a cloud session can reach on the GitHub API

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
only; check the MCP column before concluding a capability is unreachable.

The probes are non-mutating **by construction**, not by expectation: every
write-shaped probe aims at a nonexistent id, the all-zeros sha, or an invalid
payload, so a probe that unexpectedly clears the proxy is refused by GitHub
with 404/422 — which is itself the evidence the path is served. Keep that
property when adding probes; do not "fix" one by making its payload valid.

## When drift appears

Update this file, the audit's expectations, and the CLAUDE.md paragraphs that
lean on the changed row — in the same PR. The likeliest legitimate drifts:
Anthropic widens or narrows the proxy allowlist (whole classes move at once),
or GitHub reshapes an endpoint (one row moves alone). A single flipped row in
I2/I4/I5 with no announcement deserves suspicion before celebration: the
strategy's security posture *is* those rows staying closed.
