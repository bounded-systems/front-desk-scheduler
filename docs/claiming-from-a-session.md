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
optionally `repo` to restrict the pick and `ttl` for the lease length. If you were
handed a specific issue rather than asking the board, pass `item` instead — see
[When someone hands you an issue](#when-someone-hands-you-an-issue-127).

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

## When someone hands you an issue (#127)

Everything above is the *ask-the-board* flow: you do not know what to work on, so
you take whatever ranks top. The other flow is at least as common — a human hands
you a specific issue — and until #127 it was not expressible. `claim-ticket.yml`
latched the top-ranked pick, so "I intend to work #118" came out as a lease on
whatever else happened to rank first.

That is not hypothetical. On 2026-08-03 two sessions worked #118 simultaneously,
landing two different strategies for one item, with the whole lease apparatus
sitting unused. And restricting the pick with `repo:` would not have saved it:
#118 was created at `21:45:52Z` and the `21:59:28Z` sync still did not contain
it, so a repo-scoped dispatch would have **leased #113, the wrong item**, and
left #118 unheld anyway.

Pass `item`:

```
mcp__github__actions_run_trigger
  owner: bounded-systems   repo: front-desk-scheduler
  workflow: claim-ticket.yml   ref: main
  inputs:
    agent_label: "session-7"
    item:        "front-desk-scheduler#127"
```

The form is **`repo#number`**. A bare `#127` is refused — issue numbers repeat
across repos, and front-desk-scheduler#93 is the record of what a bare number
costs on a multi-repo board. `owner/repo#number` is accepted too, since that is
the shape `bind-ticket.yml` takes for its referent. A `PVTI_…` node id works, so
a verdict you already hold can be replayed verbatim.

### Naming an item does not exempt it from the ready rule

This is the property that made the obvious version of this input the wrong one.
An arbitrary `item_id` handed to the lease plane would be a way to hold an item
that is Done, closed, or blocked — a lease-plane bypass of the rule #59 spent
effort making single-definition.

So the **selection** changes and nothing else does. A named item is resolved
through the same schedulable set (`SCHEDULABLE`) and the same `isEligible` the
ranking uses, and is refused if it does not pass. `test/claim-named.test.ts`
pins that a refusal is decided *before* the CAS is reached — the same property
the Worker has when it refuses in the router before touching the Durable Object:
a failed claim writes nothing.

### Four verdicts, and only one of them is worth retrying

Every payload now carries a `verdict` field alongside `won`.

| verdict | `won` | meaning | retry? |
|---|---|---|---|
| `granted` | true | You hold it. **Bind your PR.** | — |
| `not-granted` | false | Someone else holds it. Ordinary contention. | Another item, or wait for their PR to close. |
| `not-eligible` | false | The board knows it and the ready rule refuses it — blocked, not live, or finished. | **No.** The item has to change. |
| `not-in-mirror` | false | The board has never heard of it. | **Yes, after the next sync.** |

The last two are the pair worth keeping apart, for the same reason not-granted
and error are: they want opposite reactions. `not-in-mirror` is almost always a
freshly filed issue — the #127 case exactly — and says *nothing* about who holds
the item; retrying after a sync can succeed. `not-eligible` is a fact about the
item that no amount of re-dispatching will change.

A malformed selector is neither: it fails the run as an **ERROR**, because
"I cannot parse what you typed" is not a fact about the board.

> `verdict` is absent from payloads recorded before #127. The summary renderer
> falls back to `won`, which is what the two verdicts that existed then were
> carried by.

## After you hold it — bind your PR (#105)

The claim's ttl (default 3600s) is **not** a task estimate. It is the
referent-less grace window: the time you have to make the work exist somewhere
with a queryable lifecycle — your PR — and pin the lease to it. Dispatch
`bind-ticket.yml` **immediately after opening your PR**:

```
mcp__github__actions_run_trigger
  owner: bounded-systems   repo: front-desk-scheduler
  workflow: bind-ticket.yml   ref: main
  inputs:
    agent_label: "session-7"        # the SAME label you claimed with
    item_id:     "PVTI_lADO…"       # from the claim verdict
    fencing:     "1"                # from the claim verdict
    pr:          "bounded-systems/front-desk-scheduler#110"
```

Read the one `FDS-BIND-RESULT` line from the job log. Once bound, the lease's
expiry is re-sized to a **backstop** (default 24h) and the primary release path
becomes the reaper (`reap-leases.yml`): it polls bound referents and releases
any lease whose PR is merged, closed, or gone. Your lease now lives exactly as
long as your work — a three-hour task no longer lapses mid-flight, and a merged
PR no longer holds its item for the rest of a timer.

A lease that never binds simply lapses on the short claim ttl, which is the
right outcome for a session that died before producing anything.

Two consequences worth knowing:

- **One dispatch replaces every heartbeat.** #105 priced a session heartbeat at
  one runner boot per beat; a bind is one dispatch per lease, ever, and GitHub
  runs the liveness state machine from there.
- **An `expired` interval is now an anomaly.** With the reaper as the primary
  release, a lease that reaches its backstop means the GC has been down for a
  day — `history` keeps `expired` and `reaped` distinct precisely so that is
  visible.

## Give it back through the other window

Binding does not replace the explicit release — the reaper frees your lease
when the PR closes, but saying "I am done" yourself is still faster and carries
the released-vs-completed distinction that effort calibration reads. Letting
the backstop lapse is the fallback of last resort: a session that finishes in
eight minutes on a 3600s lease holds a closed item for another fifty-two, and
every `next` in that window sees it held. That is measured, not hypothetical
(#104).

So release explicitly. `release-ticket.yml` is the same window, one verb over —
the session cannot `POST /release` for exactly the reason it cannot `POST /claim`.

```
mcp__github__actions_run_trigger
  owner: bounded-systems   repo: front-desk-scheduler
  workflow: release-ticket.yml   ref: main
  inputs:
    agent_label: "session-7"        # the SAME label you claimed with
    item_id:     "PVTI_lADO…"       # from the claim verdict
    fencing:     "1"                # from the claim verdict — see below
    status:      "completed"        # or "released" to hand it back unfinished
```

Then read the one `FDS-RELEASE-RESULT` line out of the job log, exactly as with a
claim.

### You must present the fencing token you were granted

`decideRelease` refuses a release whose token is stale, and that check is
load-bearing: without it a zombie that woke up and released would free the lease
belonging to the **new** holder, handing the item to a third agent while the
second is still working. The workflow passes your token through and deliberately
does *not* look one up — looking it up would reconstruct the caller's belief from
current state, which is the very belief being checked.

The token is the `fencing` field of the `FDS-CLAIM-RESULT` line from the run that
granted your lease, and it is also called out in that run's summary.

> Runs before 2026-08-03 do **not** carry that field — the verb did not emit one
> until #114, and the token appeared only inside the `reason` string
> (`"leased 3600s (fencing 1)"`). If you are reading an older verdict, take it
> from there. Do **not** substitute `/status`: that reports the lease's CURRENT
> token, whereas what you must present is the one **you were granted**, and the
> two differ exactly when you have become a zombie — the case the check exists
> to catch.

### Four outcomes, and one of them is a stop signal

| outcome | run | meaning |
|---|---|---|
| **RELEASED / COMPLETED** | success | The item is free. Its grant interval is closed. |
| **not-held** | success | The lease had already lapsed. Nobody held it. Nothing to do. |
| **not-holder** | success | Someone else holds it. You released nothing. |
| **stale-fencing** | success (annotated) | **You are a zombie** — a newer grant exists. |
| **ERROR** | failure | No verdict. The lease's state is **unknown**; it may still be held. |

`stale-fencing` is the one worth reacting to. For a *claim*, losing is ordinary
contention. For a *release* it means you believed you held an item that has since
been granted to someone else — so you may still be doing work, and your writes are
the ones a downstream sink should be refusing. The refusal is the mechanism
working, and it is simultaneously a signal to **stop**.

The ERROR row is the mirror of the claim's: do not read it as "already released"
and move on, or you leave a lease held with nobody watching it. Read `/status` for
the item before re-dispatching.

## What is not covered

There is no `renew` window, and — decided in #105, not left to omission — there
will not be one. `decideRenew` exists in the Worker and the syncer uses it for
its own lease, but a session never heartbeats: the referent design makes the PR
the liveness signal, and `bind` is the one dispatch that replaces every beat a
renew window would have cost. If you find yourself wanting to *extend* a
session-held lease, what you actually want is to bind it to your PR.
