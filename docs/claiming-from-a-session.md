# Claiming from a Claude Code cloud session

A cloud session can read the queue with no credential at all, and cannot write to
the claim plane at all. This document is about crossing that gap.

## Why the direct call cannot work

A cloud session's `GH_TOKEN` is the literal sentinel string `proxy-injected`. The
real credential is injected at the egress proxy, **for GitHub hosts only**. So a
session can reach GitHub, but it holds no bearer credential it can present to a
third-party host — and the lease Worker is a third-party host.

Measured against the deployed Worker, 2026-07-31:

```
POST /claim  (no auth)            → 401  writes require `Authorization: Bearer <github token>`
POST /claim  (ambient GH_TOKEN)   → 403  token is neither a valid user token (401)
                                         nor an installation token (401)
```

Both refuse **in the router, before the Durable Object is touched** — a failed
claim writes nothing. This is `AUTH_MODE=github` working as designed, not a bug to
route around.

Reads are unaffected. `/status` and `/history` are open, and the whole
`next` / `graph` / `list` path needs no credential at all.

## The ticket window

The session does not claim. It asks GitHub to claim on its behalf.

```
session ──dispatch──▶ claim-ticket.yml ──Bearer github.token──▶ lease Worker
   ▲                        │                                        │
   └────────read verdict────┴────────────────────────────────────────┘
```

`github.token` is an installation token covering this repo, which is an identity
the Worker already accepts — `worker/lease/src/auth.mjs` branch 2, where coverage
of the repo *is* the grant. The session never holds a credential; GitHub holds it,
and the workflow is the window the session speaks through.

The alias you pass is **not** the identity that gets recorded. The Worker binds
every self-asserted alias under the verified identity, so `session-7` lands as
`gha/session-7`. You cannot claim as someone else.

## The loop

**1. Decide.** Ask the `next` tool (or `node scripts/fds.ts next`). No credential.

**2. Dispatch.** Run the `claim-ticket` workflow with `agent_label` (required),
optionally `repo` to restrict the pick and `ttl` for the lease length.

From a session, the GitHub MCP tools are the path — there is no `gh` binary in a
cloud session:

```
mcp__github__actions_run_trigger
  owner: bounded-systems   repo: front-desk-scheduler
  workflow: claim-ticket.yml   ref: main
  inputs: { agent_label: "session-7" }
```

**3. Poll.** `mcp__github__actions_list` (or `actions_get`) until the run
completes. It is a single short job.

**4. Read the verdict.** Either from the run summary, or — cheaper — by grepping
one line out of the job log via `mcp__github__get_job_logs`:

```
FDS-CLAIM-RESULT {"won":true,"itemId":"i_kwDO…","number":58,"repository":"front-desk-scheduler",…}
```

That line is emitted on every run that reaches a decision, granted or not.

## Three outcomes, and why two of them are not failures

| outcome | run | meaning |
|---|---|---|
| **GRANTED** | success | You hold the lease. It expires on its own. |
| **NOT GRANTED** | success | Someone else holds it, or nothing was eligible. **A fact, not an error.** |
| **ERROR** | failure | No verdict was reached. The holder is **unknown**. |

The distinction between the last two is the one thing not to collapse. A lost race
tells you who holds the item. An error tells you nothing — the endpoint was
unreachable or the identity was refused, and the item's state is simply unknown.
Retrying an ERROR as though it were contention is how a caller ends up hammering a
broken endpoint and reading it as a busy queue.

`scripts/claim-ticket-summary.ts` renders all three, and
`test/claim-ticket-summary.test.ts` pins the property that a refusal and an error
never render as each other.

## After you hold it

The lease **expires on its own** — a dead claimant's grip lapses, which is the
whole reason this is a lease and not a lock. Release it when done with the
`release` verb, or let it lapse.

## What is not covered

The `release` path has no ticket window. A session that claims through this
workflow cannot release through one; it either lets the TTL expire or a human
releases it. Worth a follow-up if sessions start holding long leases.
