# Two write surfaces

Front Desk is bidirectional: GitHub and the Dolt/DoltHub mirror are both write
surfaces, reconciled by a scoped **field authority** (`src/authority.ts`) so the
two masters never fight over the same field.

```
   ┌── intake ──────────────┐         ┌── planning ─────────────┐
   │ gh issue create        │         │ dolt / DoltHub edit     │
   │ (webhook → board)      │         │ (hidden or dolt-dirty)  │
   └───────────┬────────────┘         └───────────┬─────────────┘
               │ pull (gh→dolt, budget-gated)      │ push (dolt→gh, budget-gated)
               ▼                                    ▼
        ┌──────────────── Dolt mirror ────────────────┐
        │  origin ∈ {github, dolt}                     │
        │  sync_state ∈ {synced, dolt-dirty, hidden}   │
        └──────────────────────────────────────────────┘
               │ dolt push
               ▼
            DoltHub (public read plane + a write surface)
```

## The three kinds of work (the taxonomy)

| | Path | State |
|---|---|---|
| **Intake** | `gh` without dolt — create an issue; webhook lands it on the board; next pull absorbs it | `origin=github, sync_state=synced` |
| **Hidden** | dolt without gh — `insertHiddenItem`; `next` ranks it; never pushed; shared via DoltHub | `origin=dolt, sync_state=hidden` |
| **Captured** | dolt → gh (or gh → dolt → gh) — `syncPush` promotes hidden rows to issues and writes dolt-dirty field edits up to the board | `dolt-dirty → synced` after push |

## Field authority (the mutability scope)

After intake, **direct edits on the wrong surface are invalid** and reconcile
toward the owner:

- **GitHub-owned** — `title`, `body` (incl. frontmatter), `status`, `created_at`,
  `closed_at`, mined relations. Pull refreshes; push never writes them.
- **Dolt-owned** — `kind`, `effort`, `value`, `depends_on`. Push writes them up
  to the board project fields; a direct project-field UI edit is out-of-band →
  `detectFieldDrift` flags it, Dolt wins on the next push.

The **only** sanctioned way to set a Dolt-owned field from the GitHub side is
**body frontmatter** (structured intake), not the project-field UI:

```
---
kind: task
effort: 3
value: 70
depends-on: [prx#119, gh-project-room#83]
---
```

## Claiming: `leases` is the mechanism, `claims` is the record

An agent takes work by latching a row in **`leases`**, which has one row per held
item under `PRIMARY KEY (item_id)`. That key *is* the scheduler's S1 (mutual
exclusion): a second claimant collides and loses, with no check-then-act window
and no isolation-level assumption. Expiry is a TTL refreshed by `renewLease`, so
a dead worker's hold lapses and the item requeues — a lease, not a lock, which is
why convoys and priority inversion don't arise.

**`claims`** is the append-only history of those holds (audit, effort
calibration). It is written *after* a successful latch and is not load-bearing:
losing a claims row costs forensics, not correctness.

> Until 2026-07-27 `claims` was both, and mutual exclusion was attempted with
> `INSERT ... WHERE NOT EXISTS` over a table with no unique index — which enforced
> nothing, and whose confirmation query filtered on `agent`, so a double-insert
> reported success to *both* agents. The models in `specs/` prove an atomic CAS
> upholds S1; they cannot supply the atomicity. Only the schema can.
> See `schema/migrations/2026-07-27-leases.sql`.

## The schema is itself a projection with an owner

The S1 bug lived where a projection didn't. `items`, `claims` and `item_deps`
existed only in the deployed database — nothing in the repo stated their shape,
so nothing could review a change to it, and the missing unique index was
invisible until someone went looking. The habitat was the gap.

Closed with the api-extractor pattern (also `buf breaking`, `cargo-public-api`,
golden files): make the semantic object a **file**, gate drift in CI, own the
file. Two artifacts, and the distinction is load-bearing:

| file | is | written by |
|---|---|---|
| `schema/mirror.sql` | **intent** — schema of record, with the rationale | hand |
| `schema/mirror.live.sql` | **reality** — projection of what is deployed | `scripts/schema-export.ts` |

`schema-drift.yml` fails when `mirror.live.sql` and the live database disagree,
and runs on a **schedule** as well as on PRs — an out-of-band `dolt sql` against
the mirror produces no pull request to gate, so the scheduled run is the one that
catches it. Divergence between *intent* and *reality* is reported rather than
failed: that is a pending migration, a legitimate state, but one worth seeing.

`CODEOWNERS` then owns `/schema/`, which buys semantic granularity from a
path-granular namespace: any change to the deployed queue schema, by any route,
surfaces as a diff on an owned file.

> This is merge-time authorization of **contract changes** — a different clock
> from `prx`'s runtime authorization of **effects**. Who may change the contract
> vs. who may exercise it; complementary, not overlapping.

## Credentials: the session gets a button, not a secret

The broker's trust boundary is a GitHub Actions OIDC JWT. `verifyOIDC` pins
`iss`, `aud`, `repository_owner`, `repository` and **`job_workflow_ref`** — which
carries `@refs/heads/main`, so only a named workflow file, running on main, can
obtain a credential.

A Claude Code cloud session is **not** an Actions runner: it has no
`ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` and cannot mint a GitHub-signed OIDC
token, so it cannot authenticate to the broker at all. That is the design
working, not a gap to route around. Issuing the session a long-lived credential
instead would delete the exact property the broker exists to provide, and would
put a production write credential inside a process that reads untrusted issue
text.

So privileged mirror writes go through `mirror-migrate.yml`, which the session
**dispatches** rather than performs. The workflow holds the pinned identity; the
session holds only the ability to ask. Two gates stand in front of it, both
fail-closed:

| gate | enforced by | effect if absent |
|---|---|---|
| `job_workflow_ref` on the broker's DoltHub allowlist | the broker | 401, no credential |
| `mirror-write` Environment, required reviewers | GitHub | run waits for approval |
| `job_workflow_ref` on the broker's GH_APPS allowlist | the broker | migration still applies; the projection PR is not opened, only warned |

The projection PR is opened with a **GitHub App installation token from the
broker** where available, falling back to the Actions `GITHUB_TOKEN`.

The org enables "Allow GitHub Actions to create and approve pull requests" (set
2026-07-28), so the fallback works today. The App token remains preferred for
two reasons: the PR is authored by the Front Desk App rather than
`github-actions[bot]`, and it does not depend on an org-wide setting that also
grants the **approve** half. GitHub bundles *create* with *approve* in that one
switch, so before relying on branch protection + CODEOWNERS, verify empirically
whether an Actions-issued approval can satisfy a required code-owner review in
this configuration — the answer decides whether that gate is real.

Every workflow that writes the mirror shares the `mirror-write` concurrency
group, so a migration cannot interleave with a sync push.

> Note the shape: this is the same "who may exercise the capability" question as
> the runtime authorization of effects — resolved the same way, by making the
> credential reachable only from an identity that can be pinned.

## Invariants the mirror enforces

Column constraints (ENUM/CHECK/FK) + SQL shape checks D1–D6, declared once more
in `specs/shacl/front-desk-shapes.ttl`. D6 flags unpushed `dolt-dirty` edits;
D1 (acyclic deps) is the data precondition for the scheduler's proven L1.

## Conflict posture

Field partitioning removes most conflicts by construction. Where the *same*
Dolt-owned field is edited on both surfaces between syncs, Dolt is authoritative
(push overwrites the board); the DoltHub Dolt history (`dolt diff`) is the audit
trail. Dolt's git-style merge handles DB-level divergence when two syncers race;
schema-evolution merges currently resolve by force-push of the newer superset
(see the 2026-07-26 ENUM-migration note).
