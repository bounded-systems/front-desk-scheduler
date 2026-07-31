---
name: Task
about: A unit of work the scheduler can rank and an agent can claim
title: ""
labels: []
---
---
kind: task          # epic | room | door | task
effort: 3           # 1..10 — how long the queue is occupied: 1-2 tiny, 3-4 an afternoon, 5-6 days, 8+ decompose into an epic
value: 40           # 0..100 — cost of delay: what does a month of waiting cost? nothing≈20, blocks a lane≈70, correctness/security≈90
depends-on: []      # [repo#123, other-repo#45] — gates readiness AND feeds the unblocks bonus
needs: []           # [gh, github-api, dolt, deno] — what an ACTOR must HOLD to do this, not what must be DONE first
---

<!--
`needs` is the capability filter (#86). Leave it empty unless the work genuinely
requires a credential or a binary the caller might not have — empty means "anyone
can do this", which is the right answer for most items.

Declare it when the work shells out to `gh`, hits the live GitHub API, or needs a
local `dolt`/`deno`. `next` then keeps the item in the ranking (its score is
unchanged) but routes it to an actor that can execute it, instead of handing it
to a cloud session that will discover the dead end three files later.

BEFORE declaring it, ask whether a ticket window would remove the requirement
instead (#95). Putting the credential in a dispatched workflow turns "only some
actor can do this" into "anyone can dispatch this", and the item then needs
NOTHING — that is usually the better fix, and it is what claim-ticket.yml,
board-parity.yml and mirror-migrate.yml each did. A `needs:` that really means
"nobody has built the window yet" parks the item instead of prompting the change
that would unblock it.

Nothing detects a `needs:` that a later window made stale — a checker would have
to know a window exists, and nothing records that. So it is on you: delete the
declaration in the PR that builds the window.
-->


## What

<!-- One paragraph: what exists after this is done that doesn't exist now. -->

## Done when

<!-- Checkable criteria a claimant can verify without asking you. -->

- [ ]
