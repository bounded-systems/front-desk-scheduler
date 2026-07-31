# front-desk-scheduler

Front Desk (org project #2) modelled as a concurrent scheduler. It answers **"what
should I work on next?"** across the org's repos, and arbitrates who holds an item.

## Start here

The verbs are registered as MCP tools (`.mcp.json`), so ask the **`next`** tool —
don't shell out and don't hand-rank issues from the GitHub API. Same verbs on the
CLI if you prefer:

```
node scripts/fds.ts next          # the ranked ready queue + a pick
node scripts/fds.ts graph         # ready + blocked, with the edges that block
node scripts/fds.ts list          # every item incl. Done, plus typed dep edges
```

Reads need **no credential and no rate-limit budget**: with `FDS_READS=dolthub`
(the default in `.mcp.json`) the read plane is one unauthenticated GET against the
public DoltHub mirror. Every result names the commit it derived from — quote it, and
`AS OF '<commit>'` re-derives that exact queue.

## Two things the ranking does not tell you

**It excludes private repos.** `infra` is deliberately out of scope — the webhook
skips private repos (infra#138/#145). `ready: N` counts what Front Desk can see, not
all open work. For `infra`, the authoritative ranking is its own tracking issue
(infra#101), and on that issue the **latest comment supersedes the body**.

**A ranked item is not necessarily one you can do** — but `next` now tells you
which. The score weighs effort and value and never asks whether *you* hold the
credentials or binaries an item needs, so the ranking is split rather than
reordered: `queue` is what you can execute, `otherActors` is what you can only
rank. Scores and order are identical in both; an item you can't do keeps its rank
and is shown, not dropped, so you can hand it off. `pick` is the top item you can
actually execute. (front-desk-scheduler#86)

Items declare requirements as `needs: [gh, github-api, dolt, deno]` in issue-body
frontmatter. **Undeclared means anyone can do it** — the predicate fails open, so
an item with no `needs` is never filtered from anyone. If `next` says nothing is
executable, the reason is printed per capability; from a cloud session the usual
one is that `GH_TOKEN` is the `proxy-injected` sentinel rather than a credential
(see below), which is set and non-empty and does not work.

When you declare `needs:`, note the blocker is the **identity, not the tooling** —
so `gh` and `github-api` are not interchangeable. Installing a real `gh` does not
buy the second one: the egress proxy is a policy point, not a credential
passthrough. Verified 2026-07-31 with `gh` 2.63.2 actually installed:

```
gh api rate_limit                        → 200  {"limit":5000,"remaining":5000}
gh api user                              → 200  bdelanghe, X-Oauth-Scopes: <empty>
gh api orgs/bounded-systems              → 403  sessions are bound to their configured repositories
gh api graphql {organization{projectV2}} → 403  only the pinned set of PR-review operations is served
```

So **ProjectV2 GraphQL is unreachable from a session by any route** — including a
remote `gh` egressing through the same proxy. A *script* that reads the board
itself (`board:parity`, `sync`) therefore wants `needs: [github-api]`; declaring
`needs: [gh]` would wrongly mark it executable anywhere a binary happens to be
installed.

Note what that sentence is about, though: **the script, not the issue.** `needs:`
is what an actor must *hold to discharge the item*, and the two part company the
moment a window exists. #58 was the case in point — the board-reading item, and
it never carried a `needs:` declaration at all, because once `board-parity.yml`
existed the work was "dispatch a workflow and read one line", which any caller
can do. So this is not "board work always needs `github-api`".

### Prefer building the window to declaring `needs:` (#95)

**When you find you can't do something, the usual right answer is to build a
ticket window, not to declare `needs:`.** Any privileged capability can be moved
behind a workflow dispatch, and once it is, the item needs nothing: the workflow
holds the credential and dispatching is something any actor can do.
`claim-ticket.yml` (#61), `board-parity.yml` (#58) and `mirror-migrate.yml` (#94)
are all the same move.

Declaring `needs:` is right when the item genuinely belongs to a different actor
— then `next` routes it to `otherActors` so it can be handed off. It is wrong
when it is really a record that **nobody has built the window yet**, because that
parks the item instead of prompting the one change that would unblock it. The
declaration #58 was *intended* to carry went `[gh]` → `[github-api]` → nothing
inside one afternoon (#95), and only the last was ever a fact about the issue
rather than about the state of the tooling that day. Note it was never actually
written into the issue — what moved was the guidance in this file, which is why
the correction lands here.

**A stale `needs:` is author-maintained, and that is accepted, not solved.**
Nothing detects one: a checker would have to know that a window exists for the
capability, and nothing records that — a window is just a workflow file that
happens to hold a credential. So re-read `needs:` when you pick an item up, and
delete it in the PR that builds the window. Treat a non-empty `needs:` as a claim
with a date on it, not a standing fact.

## Claiming — go through the ticket window

**Calling `claim` directly from a cloud session does not work, and cannot.** A
session's `GH_TOKEN` is the sentinel `proxy-injected`; the real credential is
injected at the egress proxy for GitHub hosts only, so a session holds nothing it
can present to the lease Worker. Verified live, 2026-07-31:

```
POST /claim  (no auth)              → 401  writes require `Authorization: Bearer <github token>`
POST /claim  (ambient GH_TOKEN)     → 403  token is neither a valid user token (401) nor an installation token (401)
```

Both refuse in the router, before the Durable Object is touched — a failed claim
writes nothing. That is `AUTH_MODE=github` working as designed.

So don't call it. **Dispatch `claim-ticket.yml` instead** and let GitHub claim on
your behalf with `github.token`, an identity the Worker already accepts. Read the
verdict from the one `FDS-CLAIM-RESULT` line in the job log. The full loop —
dispatch, poll, read — is in `docs/claiming-from-a-session.md` (#61).

Note the three outcomes: granted, **not granted** (a fact, not an error — someone
else holds it), and error (no verdict, holder unknown). Don't retry the third as
though it were the second.

**Reads are unaffected** — `/status` and `/history` are open, and the whole
`next`/`graph`/`list` path needs no credential.

## Measuring the board — the same window, one door over

`board:parity` (#58) needs ProjectV2 on both paths, so it cannot run in a session
either. **Dispatch `board-parity.yml`** and read the one `FDS-PARITY-RESULT` line
from the job log. It mints the same Front Desk App token the syncer uses, so its
measured costs are comparable to `api_spend`, and it serializes on `mirror-write` —
the cost is a difference of `remaining` on a shared counter, so a concurrent
`mirror-sync` would be attributed to the path under measurement.

Unlike a claim, a parity **failure is not an answer**: it fails the run, because
there is no benign reading of "the cheap query returns a different board".

## Working here

- **Install deps with `deno install --frozen`, never `npm install`.** `deno.lock` is
  the single tracked lockfile; `package-lock.json` is gitignored. `npm install`
  re-resolves unpinned, giving different bytes in CI, in a cloud session, and on a
  laptop with nothing recording the difference. If the frozen install fails,
  resolution genuinely changed — run `deno install` and commit the lockfile.
- `npm test` runs `node --test test/*.test.ts worker/lease/src/*.test.mjs`.
- The ready rule (`isEligible` in `src/policy.ts`) is proven in `specs/lean` and
  `proofs/`. It must stay **one** definition — imported, never restated in SQL, in
  the Worker, or in a script. #59 has the history of that constraint.
- Cloud-session environment facts (allowlisted domains, the `FDS_*` variables and
  their environment-scoped caveat) live in `.claude/cloud-environment.json`.

## Session start

`.claude/hooks/session-start.sh` provisions dolt, deno, Lean and the deps. It only
runs when this repo is the session's **project directory** — a multi-repo session
rooted above it never fires it, which is what the dispatcher in
`bounded-systems/.github` (`.claude/session-start-dispatch.mjs`) exists to fix. If
`node_modules` or `deno` is missing, that is the hook not having run; it is not a
broken checkout.
