# What a Worker mount has to satisfy

#59 ratified mounting the verbspec registry on `worker/lease` — the "projection
form": all five verbs served from one mount, so `isEligible` is *imported* rather
than restated. This file records the constraints that hold **whichever shape
implements it**, because each one cost a measurement to find and none of them is
visible from the code you would naturally read first.

It is not a design. The shape is still an open call on #59.

## The node coupling is one edge

Traced from `src/verbs.ts`, counting **runtime** edges only:

| | modules reachable | node-only specifiers |
|---|---|---|
| today | 12 | `node:child_process`, `node:util` via `mirror.ts`; `node:child_process`, `node:fs`, `node:util` via `mirror.ts → board.ts` |
| without `import { claimNext, releaseClaim } from "./mirror.ts"` | 6 | none |

Residual set: `verbs.ts`, `reads.ts`, `dolthub.ts`, `scheduling.ts`, `policy.ts`,
`status.ts`. None of the six references `process.env` either. After #76 and #79
the entire remaining question is that one import — and it is exactly the line
`claim`/`release` run on, which is why it is a design call and not a cleanup.

**The trap when re-measuring:** `import type` and all-`type` named clauses are
erased before runtime. `scheduling.ts` has `import type { BoardItem } from
"./board.ts"`, so `scheduling → board.ts` is **not** a coupling. An import tracer
that matches `from "…"` without excluding type-only forms reports it as one and
tells you the read verbs are still node-bound. They are not.

## verbspec resolves `deps` itself — there is no injection seam at the mount

The most expensive thing to re-derive, because the types imply the opposite.
`VerbSpec` declares `run: (input, deps?: C)`, which reads like a mount can supply
deps. It cannot. Every dispatcher builds them from the verb's own factory:

```js
// @bounded-systems/verbspec@0.4.0 — src/index.js
const result = await v.run(parsed.data, v.deps?.());   // :152, handleJsonRpc
const output = await v.run(input, v.deps?.());         // :324, dispatch
```

and none of `handleJsonRpc(reg, req)`, `dispatchNdjson(reg, line)` (which routes
through `handleJsonRpc`), or `dispatch(reg, argv, bin)` takes a deps argument. So
mounting the registry gets you whatever `deps?.()` returns: **synchronous,
zero-argument, module-scope**.

That is the whole difficulty. The Worker's write plane is `env.LEASE`, a Durable
Object binding that exists only inside `fetch(request, env)`. Request-scoped state
cannot be reached from a zero-argument module-scope factory.

**Why the read seam's answer does not transfer.** `setReadsFactory` works because
`dolthubReads` is stateless and env-free — plain `fetch` against a public URL,
constructible at import time. A claim plane is not, so "do what `reads.ts` did"
is an incomplete instruction rather than a wrong one.

Reading the `.d.ts` will not show this. Read `src/index.js`.

## The DO is per-item, and DO namespaces are not enumerable

`worker/lease/src/index.mjs` routes every request by item:
`canonicalItemId(url.searchParams.get("item_id"))` → `env.LEASE.idFromName(name)`
→ `stub.fetch(...)`. The only routes are `/claim`, `/renew`, `/release`,
`/status`, `/history`, `/health`. There is no aggregate route, and a
`DurableObjectNamespace` cannot be enumerated.

So **the Worker cannot ask "which items are leased."** It can only ask about items
it already names. This matters because #59's decision comment states that (b)
closes #43 "by construction" — that the Worker computing ready-minus-leased does
so against ground truth. It does not: `next` on the Worker would still take
`leased` from the same lagging Dolt projection it takes today. #43 survives the
mount. Its option 1 ("read the DO directly", possibly "a batch") is still the work
— minus the batch, which the topology does not offer.

Two things bound how much that costs, and they point opposite ways for the two
verb families:

- **`claim` is already unaffected.** `claimNext` walks the ranked candidates and
  takes the first *grant*. A stale `leased: false` costs one refused DO
  round-trip and the walk continues; a stale `leased: true` skips an item that is
  actually free — a missed pick, not a double-grant. The walk **is** the
  exclusion; the projection only shortens it. (#43 says this too, under "why this
  isn't a correctness bug"; it is restated here because the projection-lag framing
  makes it easy to re-derive backwards.)
- **`next` closes at bounded cost, not for free.** The visible symptom is the
  *pick*, and the head of the queue, naming items someone already holds.
  Verifying the top N candidates against `/status` is N bounded subrequests —
  cheap at the default `top=10` — and makes the pick truth rather than a hint.
  Whole-board exclusion needs a lease index (an aggregate DO, or one maintained
  by DO alarms) and is its own unit of work.

## Identity has to be bound before dispatch

`index.mjs` authenticates writes and then namespaces the caller:

```js
body.agent = namespaceAgent(verdict.identity, body.agent);
```

described in the router as binding "the last self-asserted string in the system"
under an identity that proved itself. `claimVerb` takes `agent` as an ordinary
input field. **A mount that parses input and calls `run` without re-running that
namespacing turns the verb surface into a way to claim as anyone** — it routes
around the gate rather than through it. Whichever shape wins, the mount
authenticates and namespaces before it dispatches.

## There is no `nodejs_compat`

`worker/lease/wrangler.jsonc` sets no such compatibility flag, while
`claim-plane.ts` (`resolveClaimPlane`) and `lease-client.ts` (`leaseEndpoint`,
`leaseAuthToken`) read `process.env`. Both do so *inside functions*, so importing
them on a Worker is fine and **calling** them throws.

This is not a gap to patch with a compat flag. On the Worker the claim plane is
not resolved from the environment — it is *known*. The Worker's write
implementation should bind the DO stub directly and never call
`resolveClaimPlane()`, which exists to answer a question the Worker does not have.

## What the constraints rule out

The shape that looks free: point the existing `lease-client.ts` at the Worker's
own origin, since it is already pure `fetch` and needs no new adapter. It is not
free. The Worker would call itself through the public edge, and `index.mjs` runs
`authenticate()` on every POST — **a GitHub API call per claim**, which is the
precise rate-limit budget this whole surface exists to stay off. It would also
need a token to present to itself, on a Worker whose `wrangler.jsonc` states that
no secret lives there.

## Verifying any of this again

There is no bundler or `wrangler` in the dev dependency set, so a true
Worker-runtime import test cannot be run locally — the module graph has to be
established statically, excluding type-only imports as above. `verbspec` resolves
through `node_modules/.deno/`; use `readlink -f
node_modules/@bounded-systems/verbspec` to reach its source. The version pin is
`^0.4.0`, so a minor release upstream would be picked up without a manifest edit —
relevant if the dispatchers ever gain a deps parameter.
