# ci-workflows — ⚠ DRAFT, not applied from this repository

The public home for shared CI workflows ([infra#104](https://github.com/bounded-systems/infra/issues/104)),
drafted here because `bounded-systems/ci-workflows` **does not exist yet and an agent
session cannot create it** (blocker 3 below). **Copy into that repo; nothing here runs.**

| file here | destination in `bounded-systems/ci-workflows` |
|---|---|
| `workflows/osv-scan.yml` | `.github/workflows/osv-scan.yml` |
| `workflows/self-test.yml` | `.github/workflows/self-test.yml` |
| `repo-README.md` | `README.md` |

## Why a new public repo

infra#104 offered three homes. The decision was **(a) a new public repo**.

- **(b) reuse `await-approval`** — it is already the de-facto public home for shared CI
  primitives, but it is a *single-purpose composite action*: root `action.yml` plus a
  README, nothing else. It is consumed **SHA-pinned by three privileged lanes**
  (infra#97, infra#98, front-desk#54). Adding an unrelated workflow means every scanner
  bump moves the SHA those lanes pin **for the approval gate** — re-reviewing the gate for
  reasons that have nothing to do with the gate. The name would also stop describing the
  contents.
- **(c) `bounded-systems/.github`** — conventional and the idiomatic GitHub answer, but
  unreachable from an agent session (blocker 1).

A new repo also matches the shape the org already uses for shared CI pieces:
`gh-action-brand-checks`, `gh-action-contracts`, `gh-action-node-uniqueness`,
`await-approval` — one repo per primitive.

## Blockers, for the record

1. **`bounded-systems/.github` cannot be attached to a session.** `add_repo` refuses any
   repo whose name begins with `.` — its clone directory would be a hidden path colliding
   with configuration directories. Recorded in infra#104.
2. **The workflow cannot live in `infra`.** `infra` is private, and private-repo workflows
   never resolve into public callers. Recorded in infra#104.
3. **An agent session cannot create the repo either.** `POST /orgs/bounded-systems/repos`
   returns `403 Resource not accessible by integration`; the session's GitHub App has no
   org `administration: write`. Nor does the existing `repo-admin-apply` lane help — that
   OpenTofu module is scoped to **deployment environments on `infra`**, not repo creation
   (`github-admin/README.md`). This blocker is **new**, found while acting on #104.

Blocker 3 shrinks (a) to a one-time human step but does not remove it. Option (b) remains
the only fully agent-executable home, if the coupling cost above is judged acceptable.

## Handoff — what a human needs to do

1. Create `bounded-systems/ci-workflows`, **public**, empty.
2. Copy the three files to the destinations in the table above.
3. Note the commit SHA — callers pin it.

Then the rest is agent-executable again.

## Then

- [ ] Adopt in `front-desk-scheduler`. **Worth knowing before you judge the result:** this
      repo's dependency surface is `deno.lock`, which OSV-Scanner **cannot read**. What
      would actually get scanned here is `specs/rust/Cargo.lock` (31 packages) and
      `specs/shacl/requirements.txt` (2 packages) — real, but not the main graph.
- [ ] Fan out to the repos carrying lockfiles. Identifying them needs an org-wide code
      search, which is outside this session's repo scope.
- [ ] Consider folding `infra`'s inline `deps` job in `infra-test.yml` into this workflow.
      A public reusable workflow **does** resolve into a private caller, so `infra` can
      consume it; the direction that fails is the other one. Deduplicating is optional —
      `infra`'s job works — but it removes the second copy of the digest pin.

## The deno.lock gap is the rollout's real limit

infra#104 estimates the value as "~90 repos — mostly public, mostly npm/**JSR**". Verified
against the v2.4.0 binary on 2026-07-30:

```
$ osv-scanner scan source --lockfile=deno.lock
could not determine extractor suitable to this file: ".../deno.lock"
```

So for the JSR/Deno share of those ~90 repos, this control scans **nothing**, and reports
a green check while doing it. That does not sink the rollout — the npm, Cargo, Go and
Python repos are covered, and a green check on a repo with no supported manifest is honest
about finding no supported manifest. But the headline "~90 repos now scanned" would be
wrong, and the gap should be sized (how many repos are Deno-only?) before this is called
done.
