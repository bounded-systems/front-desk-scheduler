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
(the default in `.mcp.json`) the read plane is unauthenticated GETs against the
public DoltHub mirror — one for `next`/`graph`, a handful for `list`, which pages
the whole board (#88). Every result names the commit it derived from — quote it,
and `AS OF '<commit>'` re-derives that exact queue.

DoltHub caps a single query at 1000 rows, so **any new read of a table that grows
without bound has to paginate**. `list` does, on a keyset over `item_id` pinned
with `AS OF`; `next` and `graph` do not, because they read non-Done only (~233
rows). Don't add a third unpaginated whole-table read — `dolthub.query` now
refuses at 900 rows and tells you to page it, which is the failure #88 wanted
moved off the wall and into the open.

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

**Handed a specific issue? Pass `item: repo#number`** (#127). Without it the
dispatch latches whatever ranks top, which is a *different* item than the one you
were given — and `repo:` does not save you, because a freshly filed issue is not
in the mirror yet. Naming an item changes only the selection: it is still
resolved through `SCHEDULABLE` + `isEligible`, so a named claim cannot hold a
Done, closed or blocked item. The verdict is now a field with four values, and
the two refusals to keep apart are **`not-eligible`** (the item has to change —
don't retry) and **`not-in-mirror`** (the syncer hasn't caught up — retry later,
and it says nothing about who holds it).

**Bind your PR as soon as it exists.** The claim's ttl (default 3600s) is the
referent-less grace window, not a task estimate (#105): dispatch
`bind-ticket.yml` with the `item_id`, your `fencing` token, and the PR as
`owner/repo#number`, and read `FDS-BIND-RESULT`. From then on the lease is
pinned to the PR's lifecycle — the reaper (`reap-leases.yml`) releases it when
the PR merges or closes, and the expiry is only a 24h backstop whose firing
means the reaper is down. A lease that never binds lapses on the short claim
ttl, which is the right outcome for a session that died before pushing. There
is deliberately no `renew` window — binding once replaces every heartbeat.

**Give it back the same way.** `release-ticket.yml` is the same window one verb
over (#104) — dispatch it with the `item_id` and the **`fencing` token from your
claim verdict**, and read `FDS-RELEASE-RESULT`. The reaper will free a bound
lease when its PR closes, but saying "I am done" yourself is faster and records
released-vs-completed. Don't just let the TTL lapse: a session that finishes in
eight minutes on a 3600s lease holds a closed item for another fifty-two, and
every `next` in that window sees it held. The one refusal to react to is
**`stale-fencing`** — it means a newer grant exists, so you are a zombie and
should stop working the item, not retry.

**Reads are unaffected** — `/status` and `/history` are open, and the whole
`next`/`graph`/`list` path needs no credential.

**`next` now excludes items that are actually held — but only the top N** (#135).
The mirror's `leases` table is empty on the lease plane by design (the DO is the
adjudicator), so the `leased` flag excluded nothing and held items ranked as
ready: #127 sat at rank 1 while a session held it. `next` now asks the DO's open
`/status` about the window it is about to show you, and reports what it dropped —
with the holder, and the PR when the lease is bound.

Three things follow. It is **bounded**: there is no batch route (a
`DurableObjectNamespace` cannot be enumerated), so an item promoted into view
because a held one was dropped has not itself been checked — that whole-board
remainder is #84. It **fails open**: an unreachable Worker leaves the queue
intact rather than emptying it, and says `could not be checked` so a degraded
exclusion is never silent. And it is **off** when `FDS_CLAIM_ENDPOINT` is unset,
so the no-credential path is unchanged.

`graph` does this too now (#115), and additionally reports the holder and — when
the lease is bound — the PR, since a bound lease and a lapsing one are different
answers to "wait, or take something else?".

**`list` never read the flag at all**, and an earlier version of this line said it
did. It has no `leased` field in its output and no `leased` filter on its input:
it is the everything-including-Done surface, so it lists held items the same way
it lists Done ones — present, not offered. There is nothing to fix there.

Where the flag IS still read on a plane that never writes it: `orderedReadyIds`
in `src/verbs.ts` — the ranked candidate list a **claim** latches from. On the
mirror plane `leases` is a real table and `!i.leased` genuinely excludes; on the
lease plane it is always false, so the same filter is **inert** and `claim` walks
candidates that are held. That is not a correctness bug — the DO adjudicates, so
a held candidate refuses and the walk moves on — but it costs round trips, and it
means `next` and a bare `claim` disagree about the same board. Pass `item:`
(#127) and none of it applies.

## The shape contract — fixtures on every PR, the live board daily

`specs/shacl/front-desk-shapes.ttl` is the declarative twin of the SQL shape
checks. Two lanes run it, and they are **different claims**:

- `test.yml` runs `--fixtures` on every PR: *the validator can still fail.* The
  negative fixture asserts each named constraint actually fires, because a
  validator that cannot fail is indistinguishable from a clean board (#139).
- `shacl-mirror.yml` runs `--live` daily: *the board conforms.* It reads the
  public DoltHub plane — **no credential, no dolt binary, no clone** — so it is a
  plain scheduled job rather than something needing a ticket window.

**Violations gate; warnings do not.** D1 (a dependency cycle) is `sh:Violation`:
the item can never become Ready, so the board is corrupt. D2/D3 are
`sh:Warning` — a `Todo` that should be `Blocked` is untidy, not broken. Gating on
those would have red-lined the lane on its first run (2 warnings live on
2026-08-04, both correct), which is exactly how `broker-drift` became a monitor
nobody read (#124). Warnings are printed, named as `repo#number`, and counted —
including `0 warnings` explicitly, since silence and "not checked" look identical.

**`--live` paginates, and has to.** `items` was **1782 rows** on 2026-08-04 —
already past the 1000-row cap, so an unpaginated read does not degrade, it fails.
Keyset over the primary key, pinned with `AS OF` the resolved head, exactly as
`list` does (#88); `item_deps` keysets over its composite PK by row-value
comparison. And **check `query_execution_status`, not just `rows`**: an over-cap
query returns `RowLimit` *with 1000 rows in the body*, so a client that reads
`rows` alone validates 56% of the board and reports a pass.

The verdict names the commit it derived from, and `AS OF '<commit>'` re-derives
it. What the renderer promises the shapes is only partly written down — #139 has
one live disagreement (`fd:self`); #143 was the other and is now closed.

**`fd:number` is required of `github`-origin rows only** (#143). The three layers
disagreed — nullable column, renderer emitting it only `if … is not None`, shapes
demanding it — and the resolution is that absence is *legal for dolt-born rows and
corruption for github ones*, so the constraint splits on `fd:origin` rather than
relaxing. Two things are worth carrying forward from it. The issue blamed
**ProjectV2 drafts, and that trigger is unreachable**: `normalize()` in
`src/board.ts` drops any item whose `content.number` is absent, and the board
query has no `... on DraftIssue` fragment, so a draft never reaches the mirror to
be validated. What *is* reachable is `syncPush()`'s captured-work flow — a
`dolt:`-prefixed row exists before its GitHub issue does. And a blanket
`sh:minCount 0` would have modelled that correctly while **giving up the check
that matters**; when a constraint is wrong for one class of row, split it on the
discriminator instead of dropping it.

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
- The ready rule (`isEligible` in `src/policy.ts`) must stay **one** definition —
  imported, never restated in SQL, in the Worker, or in a script. #59 has the
  history of that constraint. Distinct from it is the **schedulable set** — which
  rows reach the rule at all: `SCHEDULABLE` in `src/scheduling.ts` (card not Done
  AND `closed_at IS NULL`), mirrored by `schedulable` in
  `specs/lean/FrontDesk.lean` with the #89 invariant proven (a GitHub-closed item
  never ranks, whatever its card says). The Lean specs live in `specs/lean/`
  only — an earlier version of this line cited a `proofs/` directory that has
  never existed.
- Cloud-session environment facts (allowlisted domains, the `FDS_*` variables and
  their environment-scoped caveat) live in `.claude/cloud-environment.json`.
- **The MCP path validates its output; the CLI does not.** Whatever the read plane
  returns must be coerced in `assembleScheduling` — the DoltHub HTTP plane returns
  every column as a JSON string, `dolt sql -r json` returns real numbers, and
  `RawItem`'s numeric types describe the intent rather than the runtime. #101 was
  one missing `Number()` on `number`: `next`, `graph` and `list` all failed over
  MCP with `expected number, received string` while `node scripts/fds.ts next`
  printed a correct queue. **A green CLI is not evidence the tool works** — when
  you change a read, exercise it over MCP too.
- **Generalising that: run the path a real caller runs, not the one the tests
  run.** #101 was the first instance; 2026-08-03 produced three more in one
  afternoon, all invisible to a fully green suite:
  - **#112** — `lease-projection` had failed **24 times out of 24** and no claim
    had ever reached `claims`. Its workflowRef was missing from the broker
    allowlist. Nothing was wrong with the code; nobody had run it.
  - **#114** — the docs told callers to read a `fencing` field of the claim
    verdict that did not exist, and both ticket windows *required* it as input.
    Every test called `claimLease()` directly and got a typed token, so nothing
    exercised the shape a **workflow** caller receives — the verb's rendered
    JSON. The regression test now asserts the OUTPUT CONTRACT for that reason.
  - **#109** — `mirror-migrate` already opens the `mirror.live.sql`
    regeneration PR itself. Regenerating by hand duplicated it. **After a
    migration, merge the bot's PR; do not run `schema:export` yourself.**

  The common shape is a gap between what is tested and what is *used*, and it
  does not show up in a diff. When you finish something, dispatch the window,
  read the verdict line, query the mirror — the loop, not the unit.

  2026-08-04 added four more, all from #119/#129/#124 and none visible to a
  green suite. They are worth reading as a group, because three of them are
  *verification* failing rather than code failing:

  - **A defect that only exists BETWEEN runs cannot be caught by testing one
    run.** #119's watermark froze any interval projected mid-life: the row
    stayed `active` forever because the projector never re-read it. Every
    single-projection test passed. The regression test now drives
    project-live → close → project-again → converge, and the production proof
    was the session's own lease going `active` → `completed` across two runs.
  - **Forcing a race is a legitimate way to verify a retry path — but check
    that it exercised the code.** Verifying #129 by dispatching two writers
    together LOOKED like a pass: both green, genuinely overlapping. The
    projection had exited at its empty-diff guard and never reached the push.
    A live interval had to be created first. *A green run that never reached
    the code under test is the #112 shape wearing a pass.*
  - **A monitor's failure window must be TIME, not run count.** #124's
    watchdog counted the last N runs, which put `lease-projection` at exactly
    5-of-10 — all from the #112 and #129 eras, both already fixed. A
    run-count window reports a repaired lane as broken for days, which is
    precisely how `broker-drift` became a monitor nobody read. Found by
    checking real lane health before pushing, not by a test.
  - **Zero attempts is not evidence of failure.** On its first real run the
    #124 watchdog accused *itself*: `NEVER lane-watch.yml (0/0 runs failed)`.
    #112 was 24 attempts and 24 failures; a lane merged an hour ago has not
    failed, it has not been tried. Every newly-added lane would have tripped
    it. Distinguish "no data" from "bad data" in anything that alarms.

  Two smaller notes from the same day. `claim` latched the **top-ranked** ready
  item and had no item selector, so a named issue could not be claimed — #129
  was worked leaseless for that reason. **Fixed in #127: pass `item` to
  `claim-ticket.yml` as `repo#number`.** And `mirror-sync-delta` is
  webhook-driven, so its inter-run gaps ranged from ~90s to over an hour in one
  evening: for any lane like that, the cron is a *backstop*, and a tolerance
  derived from observed rate would call a quiet weekend an outage.
- **A fresh advisory is unfixable for 24h, and the failure is silent.** Deno's
  minimum dependency age policy (24h by default) refuses any npm version
  published less than a day ago. A plain `deno install` does not say it skipped
  one — it just resolves lower, so the tell is a lockfile that will not move
  onto a version the registry plainly lists and the parents plainly allow. #118
  lost time to this, concluding across three runs including `--reload` that it
  was "the resolver's choice"; it was the gate, and an explicit override is what
  makes the refusal speak. So a day-zero advisory reds the scan for its first
  day on *any* Deno repo, which is a property of the ecosystem, not of a repo.
  Two rules follow. **Never `--min-dep-age 0`** — it is global, not per-package,
  so it grabs the newest of everything: on #118 it took hono 4.13.0 published
  nineteen minutes earlier plus an unrelated `jose` bump, which is adopting a
  minutes-old minor while claiming to fix a vulnerability. Prefer waiting; if
  you cannot, use the **smallest** relaxation that admits the one version you
  want (`--min-dep-age 1170`, or a cutoff timestamp). And **check whether the
  parents' ranges already admit the fix before concluding you are blocked on
  upstream** — if they do, no release is coming to help you and the constraint
  is somewhere else, usually the clock. `--min-dep-age <cutoff>` set to a future
  boundary also lets you *verify* tomorrow's resolution today without committing
  it, which is how the `hono` outcome was known before it was reachable.
- **`osv` is not a required check; `test`, `vars` and `drift` are.** That is the
  org ruleset (20149487), read from the rule rather than inferred from
  `mergeable_state`. It also sets `strict_required_status_checks_policy`, and
  that combination produces a genuinely misleading failure: when `main` moves,
  the merge API rejects with `405 … 3 of 3 required status checks are expected`
  even though all three are green on your head. It means **your branch is
  stale**, not that checks are missing — rebase and let them re-report; do not
  re-run them. Main moves fast (twice in fifteen minutes on 2026-08-03) and this
  repo has **auto-merge disabled**, so nothing absorbs the race and every base
  move costs a manual rebase.

## Session start

`.claude/hooks/session-start.sh` provisions dolt, deno, Lean and the deps. It only
runs when this repo is the session's **project directory** — a multi-repo session
rooted above it never fires it, which is what the dispatcher in
`bounded-systems/.github` (`.claude/session-start-dispatch.mjs`) exists to fix. If
`node_modules` or `deno` is missing, that is the hook not having run; it is not a
broken checkout.
