# Is Dolt the queue, or the log?

Decided 2026-07-28. **The log.** A Cloudflare Durable Object becomes the queue.

This was never really a choice of serializer. It is a choice about whether the
thing that *enforces exclusion* and the thing that *records history* are the same
table — and until now they were. That conflation is why A2 has been hard to
discharge: `leases` had to be simultaneously the mechanism and the record, and
the mechanism's correctness then depended on every writer reaching one database.

## The state this replaces

`leases.item_id` is a PRIMARY KEY, so at most one lease row per item can exist
**within one database**. `writesGoToServer()` routes claim writes to a shared
`dolt sql-server` — when `DOLT_HOST` is set. In production it is not set. Claim
writes go to a per-agent local clone, so N agents latch N databases, each reads
back its own name, and every one of them believes it holds the item. The conflict
surfaces as a Dolt merge long after both have started working.

The PRIMARY KEY was never wrong. Its precondition was never met.

## The instrument was measuring a topology that does not exist

`claim-race.yml` provisioned its own `dolt sql-server` and then raced against it.
It passed. That pass was **an artifact of the harness**: CI satisfied A2 by
construction, so the test reported on CI, not on production. A green test whose
green-ness comes from its own scaffolding is worse than no test, because it
reports an assumption as discharged.

Split into two jobs on 2026-07-28. `harness-a1` keeps the self-provisioned server
and claims only what it establishes — A1, engine atomicity, plus the seam's
commit/retry mechanics, which is where two real bugs were caught. `production-a2`
provisions nothing, points at the deployed endpoint, and is **red until one
exists**. That red is the accurate state of the world.

## Why a Durable Object, not a `dolt sql-server`

- **`dolt sql-server` makes A2 true by configuration and discipline.** One agent
  pointed at a local clone, one merge path left open, and we are back here — with
  a green test. A DO makes it true **by construction**: there is no configuration
  under which two invocations run concurrently for one `item_id`.
- **It collapses the fencing-ordinal problem.** Fencing needs a total order, and
  a Dolt commit hash is not one — it is content-addressed, an identity, never an
  ordering. A DO gives a monotonic counter for free. (`AUTO_INCREMENT` also
  works — under a single server, which is the assumption in question.)
- **This project's thesis is correctness contracts.** Choosing the option that is
  correct only if operated correctly is the same class of error the project
  exists to eliminate.

## The named weakening

Moving the queue out of Dolt does **not** delete `dolt log`. It **demotes** it.

> **The log records decisions rather than being the decision.**

DO storage becomes ground truth for exclusion. The Dolt row becomes a *derived
projection* that the DO writes. This is a real trust edge between two layers, and
naming it is the point: an unnamed one goes unchecked.

What that requires, concretely:

- The projection write must be **idempotent** — keyed on (item_id, fencing
  ordinal), so a replay overwrites rather than duplicates.
- It must be **replayable** — the DO retains enough to re-emit any projection
  write that failed.
- A failed write is therefore a **catch-up, not a divergence**. It is only that
  if both properties above actually hold; if either lapses, the audit trail can
  disagree with what happened and nothing will notice.

`commit_attestations` already carries a weaker version of this same edge: its
claims are asserted by the writer, not verifiable by a reader. Worth keeping the
two straight — they are separate edges, and neither discharges the other.

## Acceptance criterion

Not "the DO is deployed". Not "the code looks right".

**`production-a2` goes green**: N agents race the real endpoint and exactly one
receives a grant. Until that run happens, "the DO enforces exclusion" is a design
claim — the same status the PRIMARY KEY had while `DOLT_HOST` was unset.

## Order of work

1. ✅ Split `claim-race` so the assumption is a failing test, not a vibe.
2. ✅ Build the DO: claim / renew / release, monotonic fencing counter (#34).
3. ✅ Route the claim path at it — `src/claim-plane.ts`, three named planes (#35).
4. ✅ Projection writer (2026-07-29). Grants are recorded in the DO's history
   in the SAME storage transaction as the decision, and projected into
   `claims` keyed by `(item_id, fencing)` under a UNIQUE index —
   `INSERT … ON DUPLICATE KEY UPDATE`, verified idempotent against real
   Dolt before the design was committed. The watermark is THE PROJECTION
   ITSELF (max projected fencing per item), so there is no cursor to lose
   and a failed run is a catch-up by construction. Retention is what
   replayability rests on: the DOs keep every record; pruning waits for a
   projector acknowledgement design. `claim-race` phase 4 audits that
   history agrees with the grants the race observed.
5. Turn `production-a2` green — set `FDS_CLAIM_ENDPOINT` and watch it pass.

Step 1 exists so that steps 2–4 have something to satisfy other than taste.

---

*A note on how this was framed.* An earlier draft of this argument called "a proof
whose precondition the implementation quietly fails to satisfy" the recurring
theme of the work. It is two instances — A2, and a signing guarantee that had
never run. Two is not a theme, and a phrase tidy enough to feel like one is worth
distrusting, particularly when it starts steering what gets worked on first.
