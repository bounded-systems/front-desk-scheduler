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

**A ranked item is not necessarily one you can do.** The score weighs effort and
value; it does not ask whether *you* hold the credentials or binaries the item
needs. From a cloud session in particular, anything requiring `gh` against the live
GitHub API cannot run — see below. Check before you start. (front-desk-scheduler#86)

## Claiming — read this before you try

`claim` **does not work from a Claude Code cloud session today.** The lease Worker
authenticates writes against `api.github.com`; a cloud session's ambient `GH_TOKEN`
is proxy-local and is not valid there. Verified live, 2026-07-31:

```
POST /claim  (no auth)              → 401  writes require `Authorization: Bearer <github token>`
POST /claim  (ambient GH_TOKEN)     → 403  token is neither a valid user token (401) nor an installation token (401)
```

Both refuse in the router, before the Durable Object is touched — a failed claim
writes nothing. This is by design (`AUTH_MODE=github`, fail-closed) and the gap is
tracked as #61, the ticket-window pattern. **Reads are unaffected** — `/status` and
`/history` are open, and the whole `next`/`graph`/`list` path needs no credential.

So: from a cloud session, use `next` to decide what to work on, then do the work.
Don't burn a pass rediscovering the 403.

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
