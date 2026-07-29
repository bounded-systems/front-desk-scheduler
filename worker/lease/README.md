# front-desk-lease

The scheduler's serialization point. One Durable Object per `item_id`; it grants,
renews, and releases leases, and hands out the monotonic fencing token.

## Why this exists

`leases.item_id` is a PRIMARY KEY, which excludes at most one holder per item
**within one database**. Production had no shared one — claim writes went to a
per-agent local Dolt clone, so N agents latched N databases and each read back
its own name. The key was never wrong; its precondition was never met.

A `dolt sql-server` would fix that **by configuration**: one agent pointed
somewhere else and the property is gone, with a green test to match. A Durable
Object fixes it **by construction** — one instance per item, single-threaded,
with no configuration under which two claims for one item run concurrently.

See [`docs/queue-vs-log.md`](../../docs/queue-vs-log.md). The decision recorded
there is not "which serializer" but "is Dolt the queue or the log". It is the
log: this is ground truth for exclusion, and the Dolt row becomes a derived
projection.

## Shape

| file | role |
|---|---|
| `src/lease-core.mjs` | the decision, as pure functions of `(state, request, now)` |
| `src/index.mjs` | a thin DO shell — supplies serialization, decides nothing |

Same split the rest of the repo makes: `policy.ts` is pure and every race lives
in the mechanism around it. It buys exhaustive ordering tests with no runtime.

## API

All endpoints take `?item_id=` and a JSON body.

| endpoint | body | returns |
|---|---|---|
| `POST /claim` | `{agent, ttl_sec}` | `{granted, holder, fencing, expiresAt, reason}` |
| `POST /renew` | `{agent, fencing, ttl_sec}` | `{renewed, holder, fencing, expiresAt}` |
| `POST /release` | `{agent, fencing}` | `{released, fencing}` |
| `GET /status` | — | `{holder, fencing, expiresAt, live}` |
| `GET /health` | — | `{ok: true}` |

`reason` distinguishes cases that look identical from the outside: `free` vs
`expired` on a grant, and `held` vs `already-held-by-you` / `not-holder` /
`stale-fencing` on a refusal.

## Fencing

Every **grant** takes a strictly larger token. Renew and release require the
current one.

That check is load-bearing in a way that is easy to miss. Without it, a zombie —
a holder whose lease lapsed while it was still working — could wake up and
`release`, freeing a lease belonging to the **new** holder and handing the item
to a third agent mid-flight. The stale token makes that a no-op.

The counter is **retained across release**. It is a property of the item, not of
the grant; resetting it would let a later grant reuse a token some zombie is
still carrying.

This is also why a Dolt commit hash could never serve here: it is
content-addressed — an identity, never an ordering — and fencing needs a total
order.

## Assumptions it does not discharge

Named rather than assumed, because the design this replaces failed on an unnamed
precondition:

- **A1′** — the DO runtime applies one read-modify-write at a time. Cloudflare
  input gates give this for handlers that await *only storage*. Await a fetch or
  a timer mid-transition and the gate opens, so `applyTransition` awaits storage
  and nothing else. That is a correctness property, not a style choice.
- **A2′** — every claimant for one item reaches the *same* instance. The id is
  derived by `canonicalItemId` in exactly one place; two namespaces, or a caller
  that forgot to normalise, and there are two serialization points again.

Neither is established by the unit tests, and they don't pretend to be. S1 is a
property of the mechanism. The experiment that binds it is `production-a2` in
`.github/workflows/claim-race.yml`.

## Authentication

Writes (`/claim`, `/renew`, `/release`) require `Authorization: Bearer` with a
**GitHub token the caller already holds** — a session's `GH_TOKEN`, a
workflow's `github.token`, a broker-minted App token. The worker validates it
against GitHub in the **router** (never the DO — validation awaits the network,
and A1′ forbids non-storage awaits in the critical section):

| token kind | check |
|---|---|
| user token | `GET /user` → login, then `permissions.push` on the repo |
| installation token | installation's repo list must cover the repo |

**The public-repo trap is the design's spine**: this repo is public, so *"the
token can read the repo"* authenticates everyone on GitHub. The `permissions`
field / installation coverage is the real check, absence of evidence is
refusal, and the test suite pins a stranger's *valid* token being turned away.

No new secret exists anywhere — the house rule holds. The broker's trust
boundary is untouched: it keeps authenticating *workflows*; this authenticates
*whoever GitHub will vouch for*, which is the right shape for interactive
claimants.

**Attribution bonus:** the `agent` field was the last self-asserted string in
the system. Verified callers get their alias **namespaced under their
identity** (`bdelanghe/r1-3`, `gha/worker-2`), so history, projection, and
effort calibration attribute work to a proven identity while race tests keep
synthetic multi-agent names. Aliases containing `/` are refused — nesting would
blur which part was verified.

Reads (`/status`, `/history`) stay open: their content reaches the public Dolt
mirror through the projection anyway, so a gate would protect nothing and break
the projector.

`AUTH_MODE=none` (wrangler var) disables the gate for scratch deployments —
deliberately a **visible, reviewable config choice**, and unset fails closed to
`github`.

## Deploy

```
cd worker/lease && npx wrangler deploy
gh variable set FDS_CLAIM_ENDPOINT -R bounded-systems/front-desk-scheduler \
   -b "https://front-desk-lease.<subdomain>.workers.dev"
```

Deploying is **not** discharging A2. That takes `production-a2` going green: N
agents racing the real endpoint, exactly one grant.

## Status

Not yet deployed (blocked on the broker's Workers-edit tier — see
`lease-deploy.yml`). The client adapter exists (`src/lease-client.ts`, the
`lease` plane in `src/claim-plane.ts`), grants are recorded in the DO and
projected to Dolt (`lease-projection.yml`), and writes are authenticated. The
first deploy exercises all of it at once, which is what `lease-deploy`'s
race-after-deploy step is for.
