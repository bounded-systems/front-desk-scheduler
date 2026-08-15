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

That four-line snapshot generalised on 2026-08-06: the whole raw-API surface
was probed — see `docs/api-reachability.md` for the matrix and the five refusal
classes, and re-derive it with `scripts/audit-api-reachability.sh`, which
asserts the posture **both ways** (routes the strategy relies on stay open,
routes it assumes closed stay closed) and exits nonzero on drift. The facts
that decide `needs:` and window design: repo-scoped reads AND issue/PR writes
are open over raw curl; content writes are proxy-blocked (`git push` is the
write path); **workflow dispatch is refused by the token, not the proxy**, so
windows are driven via the MCP `actions_run_trigger` tool only; job-log
*bodies* redirect to Azure blob, off the egress allowlist, so verdict lines are
read via MCP `get_job_logs`; and the MCP server holds its own credential —
search and collaborators answer over MCP while the same paths 403 raw, so
neither surface's reachability predicts the other's.

**That doc covers two identities now, and neither dominates the other.** A
session reads repository files and cannot touch ProjectV2; the Front Desk App
writes the board and cannot read a file — `contents` is deliberately absent from
the unpinned `front-desk` tier, so the App is *less* capable than a session on
exactly the axis you would assume it was more. "Can this be done?" therefore has
no answer until you say by whom, and the failure mode is assuming the App is a
superset and declaring `needs:` on that basis. Note the asymmetry in how well
the two are known: the session plane is asserted on demand by the audit script,
while the App plane **cannot be probed from a session at all** (`verifyOIDC`
pins `job_workflow_ref`, so only a runner mints those tokens) — so its table
can rot silently where the session's cannot.

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

**An item that needs retiring, not working, has its own window.** The board
ranks what it can see and cannot see that a PR's diff is already on `main`, so
a corpse keeps its score — on 2026-08-05/06 four of the top five executable
picks were already-done work, and prx#931 had ranked *first for over a month*.
`triage-ticket.yml` does claim → comment → close → release in one dispatch;
read `FDS-TRIAGE-RESULT`. It **never decides** an item is a corpse — you supply
`evidence` and it writes what you supply — and the claim is the guard, so
`not-eligible` (already Done/closed/blocked) and `not-granted` (someone holds
it) both write nothing. A failed close releases **`released`, not
`completed`**, so a half-run returns the item to the queue rather than
recording a retirement that did not happen.

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

**`item_id` on the lease plane is the ProjectV2 node id (`PVTI_…`), and a wrong
one reads back CLEAN** (2026-08-04). `canonicalItemId` in
`worker/lease/src/lease-core.mjs` accepts any non-empty string — it trims and
lowercases, nothing more — and the router derives the DO name from it. So
`GET /status?item_id=front-desk-scheduler%233` does not 404: it mints a fresh
Durable Object for a name nobody has ever claimed under and returns
`{"holder":null,"fencing":0,"live":false}`. That is indistinguishable from "this
item has never been claimed", and it is how this session first concluded — wrongly
— that no lease had ever existed for #3. With the real id the same call returned
`fencing: 3` and a history of three grants.

Two rules follow. **Resolve the id from the mirror**, never construct it:
`SELECT item_id FROM items WHERE repository='<repo>' AND number=<n>` (note the
column is `repository`, not `repo`). And **read `fencing`, not just `holder`**:
`fencing: N` with `holder: null` is positive evidence you reached the right
object — it has issued N grants and is free now. `fencing: 0` is the ambiguous
one: it means no grant has *ever* been issued under that name, which is equally
consistent with a never-claimed item and with a typo, and **the read cannot tell
you which**. Treat 0 as "unconfirmed" rather than "free", and confirm the id
against the mirror before concluding anything from it. Nothing can close that
gap for you — a `DurableObjectNamespace` cannot be enumerated (#84), so there is
no route that reports a name as not-a-real-item.

**#127 fixed named claims; it does not make anyone use them.** On 2026-08-04 two
sessions worked #143 concurrently and opened PR #145 and PR #146 **seventeen
seconds apart**, neither aware of the other, and #146 was merged before #145 was
noticed. Both had reached the same decision independently, so nothing was lost
but the duplicated afternoon — that was luck, not the process working. Neither
session held a lease. The apparatus that exists precisely to prevent this
(`claim-ticket.yml` + `item: repo#number`) was available to both and dispatched
by neither; #129 was worked leaseless because no item selector existed, and that
excuse died with #127. So this is the #112 shape aimed at the claiming path
itself: nothing is broken, nobody runs it. **Dispatch `claim-ticket.yml` with
`item:` before you start, and `bind-ticket.yml` the moment the PR exists** — a
bound lease is the only thing that would have made either session visible to the
other, because `next` only excludes what the DO says is held (#135). 2026-08-05
added the backlog-branch variant: prx#931 duplicated already-merged prx#747 and
ranked top of the queue for a month; the claim taken to close it read
`fencing: 1`, so no lease had ever existed on the item either.

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

## Status is derived, not owned (#148)

**The board card is output.** `deriveStatus` in `src/status.ts` computes it from
state the system already holds, so there is exactly one authority per component
and no merge rule anywhere:

| value | derived from | already computed in |
|---|---|---|
| Done | `closed_at IS NOT NULL` | `SCHEDULABLE`, the #89 Lean invariant |
| Blocked | `openBlockers > 0` | `assembleScheduling`; D2/D3 in the shapes |
| In Progress | a held lease | the DO (#135/#115) |
| Todo | none of the above | — |

The shapes said this already and only lacked a direction: **D2** ("a Blocked item
must have at least one non-Done dependency") and **D3** ("a Todo item with an open
dependency should be Blocked") are together the biconditional
`Blocked ⟺ openBlockers > 0`. The derivation is those rules pointed at the card
instead of at a validator, which is why disagreement stops being something to
resolve and becomes unrepresentable.

**Don't reach for a merge rule.** Both obvious ones are wrong, and knowing why
saves rediscovering it: a join/max over a status lattice is *monotone* and cannot
express a reopen (`closed_at` going NULL is a decrease), and "most recent
transition wins" needs a per-field timestamp neither the mirror nor ProjectV2
carries — ProjectV2 exposes item-level `updatedAt` only.

**`board-writeback.yml` renders it** with the Front Desk App identity
(`organization_projects:write`, the same token the syncer mints). `apply` defaults
to **false** and the first dispatch prints the plan, which matters more here than
for a repair: deriving moves *every* disagreeing card, including ones reading
Blocked with nothing in the graph to justify them.

**The #5 example this paragraph originally carried was wrong, and the way it was
wrong is the point.** It read `status="Blocked"`, `depends_on` empty, *zero
`item_deps` rows*, a standing D2 violation deriving to Todo. Measured on the same
board on 2026-08-04: `depends_on` is indeed empty, but `item_deps` has **one** row
(#5 → #1), #1 is open, so `openBlockers = 1` and #5 derives to **Blocked** —
which is what its card already says. There is no disagreement on #5 and nothing
to move.

`depends_on` is the free-text column; `item_deps` is the typed edge table, and
they are not redundant — an item can have edges with an empty `depends_on`, which
is exactly #5. `openBlockersOf` in `src/writeback.ts` reads the **edges**, same as
`assembleScheduling`, so the code was never at risk; only the prose was. That is
the trap worth remembering: **reading `depends_on` to predict what the derivation
will do gives a different answer than the derivation**, and the live SHACL lane
agreed with the code — `0 warnings` at 12:53Z, whereas a Blocked item with no open
dependency is precisely what D2 would have reported.

**Two things it deliberately refuses to derive.** `deriveStatus` returns `null`
for both, meaning "leave the card alone":

- **dolt-origin rows.** A hidden/planning row has no GitHub issue, so `closed_at`
  has nothing to say about it. Its card *is* the record. Same scoping
  `SQL.statusDrift` uses.
- **In Progress, when the lease plane was not consulted.** There is no batch route
  to the DO (#84), so a whole-board pass passes `null` — *not* an empty Set. The
  two differ and the difference is load-bearing: an empty Set asserts "nothing is
  held" and would downgrade every held card to Todo. So the pass derives Done and
  Blocked, preserves In Progress, and never promotes Todo → In Progress until #84
  lands a batch route. The rule for it is already written and tested; only the
  input is missing.

**Both of its reads page.** The derivation needs every item and every edge — a
Done row is what confirms a dependency is satisfied — so it walks `items` and
`item_deps` through `readPaged` (keyset, pinned with `AS OF`). Measured
2026-08-04: **1796 items**, well past both the 1000-row cap and the 900-row
`CAP_GUARD`. `item_deps` is keyed on `(item_id, dep_item_id)`, so its cursor is
composite — a keyset on `item_id` alone silently drops every edge sharing an
item_id across a page boundary.

**It is new, so it is not on the broker's allowlist until someone adds it.**
`verifyOIDC` pins `job_workflow_ref`; until `board-writeback.yml` is in the
`front-desk` tier's `GH_APPS` entry, every run fails at the mint step. That is
the #112 shape exactly, so the mint step names that cause instead of failing with
a bare curl error — and the first dispatch is what proves the entry landed.
Dispatch it; don't assume it.

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

  2026-08-06 added the version where **the two paths are two PROCESSES**, not two
  call sites. #160: `mcp__front-desk__next` reported `missing: [deno]`, `why: no
  \`deno\` binary on PATH`, while the same session's shell had deno 2.9.4 at
  `$HOME/.deno/bin/deno`. Nothing was wrong with the probe's logic — it read the
  wrong PATH. `session-start.sh` provisions deno and elan under `$HOME` and puts
  them on the **shell's** PATH by appending to `$CLAUDE_ENV_FILE`; a process the
  harness spawned itself never sees that. `dolt` was held in the same reading
  only because its installer targets `/usr/local/bin`, and that split is the
  whole diagnosis.

  Two things generalise. **The actor a capability describes is the SESSION, not
  the process asking** — so `resolveBinary` now searches PATH plus the dirs the
  hook provisions into, and *reports which*, because "held by the actor" and
  "spawnable from here" are different facts and a caller that shells out needs
  the second one. And **an all-empty predicate hides its own breakage**: every
  queued item has empty `needs:`, so the probe failed open and nothing was
  filtered — the bug was invisible until the first `needs: [deno]` would have
  routed every cloud session to `otherActors`. A predicate nobody exercises is
  not verified, it is unobserved.
- **A board FIELD change does not ride the delta lane at all — it is up to 6h
  behind** (2026-08-04). Read the previous note carefully: it is about the delta
  lane's *gaps*, and it invites the inference that any board change lands within
  the hour. For a Status edit that is false. `mirror-sync-delta.yml` fires on
  `repository_dispatch: [board-changed]`, which the webhook Worker sends on
  issue/PR **open/close/reopen**, and its hourly backstop is a Search-API delta
  keyed off issue state. A ProjectV2 field edit is neither. Status only reaches
  the mirror through the full `mirror-sync.yml`, `cron: "17 */6 * * *"`.

  Three consequences. **A successful delta run is not evidence your change
  synced** — dragging a card to `Blocked` and then watching a delta run complete
  two minutes later carried nothing, and nine minutes of polling a healthy lane
  produced no change because that lane was never going to deliver it. That is
  the #112 shape again: nothing broken, nobody had run that path. **The board
  and the mirror can legitimately disagree about a card for six hours**, so
  `shacl-mirror.yml` can warn about a card fixed hours earlier — "the lane is
  warning" and "the board is untidy" are not the same claim at a given moment.
  And **you can close the gap yourself**: `mirror-sync.yml` has
  `workflow_dispatch: {}`, so dispatch it rather than waiting for `:17`. It is a
  production write lane (full pull, DoltHub push, shared API budget, serialises
  on `mirror-write`), so dispatch it deliberately, not reflexively — but it took
  the convergence above from ~5h40m to two minutes.
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

<!-- bounded-systems-org:begin — managed by adopt-claude-harness; do not hand-edit this block -->
## bounded-systems sessions — before anything else

1. **Bootstrap**: run `bash .claude/org-repair.sh` (pre-approved; verifies every
   byte against `$ORG_BOOT_SHA256`, refuses unverified code). `bootstrap in
   effect` → continue. `REFUSED` or a permission denial → stop and report; do
   not work around it.
2. **Claim before working**: dispatch `claim-ticket.yml` in
   `bounded-systems/.github` (workflow_dispatch: `repo`, `issue`, `claimant`),
   then confirm the claim comment ON THE ISSUE names your claimant. Any
   assignee or `claimed` label → someone else's. Window unreachable → claim by
   hand (assign + comment) and say the window was down. No issue → open one.
3. **Degraded mode**: no "bounded-systems — Claude context" block in your
   session context means the org context did not load. You may claim and work
   THIS repo only — no org-level `[settings]`/`[org]` changes, no cross-repo
   work.
<!-- bounded-systems-org:end -->