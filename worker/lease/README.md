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

## Authentication — not solved here

This Worker holds no credential, but it currently accepts unauthenticated
claims. **Deploy it only where that is acceptable.**

The obvious move is to reuse the broker's OIDC pins, and it is the wrong one:
the broker authenticates *workflows* (`job_workflow_ref@refs/heads/main`), and a
claimant is an interactive agent — a different caller shape. Widening the
broker's trust boundary to cover it would trade the property that makes "no
stored secret" true for convenience.

## Deploy

```
cd worker/lease && npx wrangler deploy
gh variable set FDS_CLAIM_ENDPOINT -R bounded-systems/front-desk-scheduler \
   -b "https://front-desk-lease.<subdomain>.workers.dev"
```

Deploying is **not** discharging A2. That takes `production-a2` going green: N
agents racing the real endpoint, exactly one grant.

## Status

Not deployed. The scheduler client adapter is not written — `writesGoToServer()`
still chooses between MySQL-wire and a local clone, and this is neither, so
`src/reads.ts` / `src/mirror.ts` need a third adapter that also surfaces the
fencing token to the effect side.
