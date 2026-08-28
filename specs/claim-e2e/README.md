# claim, end to end

The front-desk `claim` verb carried across every validation layer the org runs,
as one executable example. `npm run claim:fixtures` (from the repo root)
executes the whole pipeline and asserts the fixture expectations (clean
conforms, violations reject) — the fixture discipline from
[`../shacl/front-desk-shapes.ttl`](../shacl/front-desk-shapes.ttl), applied to
the example itself.

## Why `claim`

It is the org's realest capability verb: an atomic CAS on the mirror
(`leases` PRIMARY KEY = the proven S1 invariant), a TTL lease, and a fencing
ordinal whose absence has a documented attack — *"a release without one is how
a zombie frees the NEW holder's lease"* ([`src/mirror.ts`](../../src/mirror.ts)).
Nothing here is invented; every constraint traces to a migration
([`2026-07-27-leases.sql`](../../schema/migrations/2026-07-27-leases.sql),
[`2026-07-29-claims-fencing.sql`](../../schema/migrations/2026-07-29-claims-fencing.sql)),
a shape, or a comment elsewhere in this repo.

## The layers, and what each one caught

| layer | artifact | catches (from the actual run) |
|---|---|---|
| 2 — Zod gate, per document | `src/verb.ts` | `fencing` as string, `ttlSec 0`, bad dateTime, **unknown key `notes`** |
| 3 — JSON-LD expansion | `context/claim-v1.jsonld` | nothing — *and that is the finding, below* |
| 5 — SHACL, per document | `shapes/claim.ttl` | same field violations, independently (defense in depth) |
| 5 — SHACL, merged graph | `fd:LeaseExclusivityShape` | **S1: two individually-clean grants for one item** |

The merged-graph check is the one no per-document validator can make:
`grant-valid.json` (alice) and `grant-second.json` (bob) each pass the gate and
each conform alone; their union violates `sh:maxCount 1` on the inverse of
`fd:item`. In the mirror this is `PRIMARY KEY (item_id)`; here it is the same
invariant stated declaratively.

## The finding: expansion eats what the closed world would refuse

The violations fixture carries `"notes": "…"`, an unrecognized key. The Zod
gate rejects it. The SHACL `sh:closed` shape — which exists to reject exactly
this — **never sees it**: `notes` is unmapped in the @context, and JSON-LD
expansion silently drops unmapped terms. Layer 3 swallowed the evidence before
layer 5 could refuse it.

This is the same class as the renderer traps documented at the top of
[`../shacl/front-desk-shapes.ttl`](../shacl/front-desk-shapes.ttl) (vacuous
`sh:disjoint fd:self`, failing-open
`fd:origin`): the tree→graph transform does not merely translate — it decides
what exists, and its omissions convert downstream checks into vacuous passes.
Consequences:

- **The layer-2 gate is not redundant.** "Run airtight checks at 2 and 5" is
  not defense in depth for unknown keys — layer 2 is the *only* place they are
  visible at all.
- **Any JSON-LD renderer needs a contract**, exactly as the Python renderer
  ([`scripts/shacl_validate.py`](../../scripts/shacl_validate.py)) has one: here, (1) numeric fields must be typed through the @context, or
  clean grants fail `sh:datatype`; (2) the item node must carry `rdf:type
  fd:Item`, or S1 checking is vacuous — guarded non-silent by `sh:class` on
  `fd:item`, the same keep-both pairing as front-desk's `fd:origin` minCount.

## What the shapes deliberately do not check

The verbspec split (verbs read state; supervisors own time) holds here:
expiry-vs-now belongs to the reaper (`reap-leases`), fencing monotonicity to
the Dolt `UNIQUE (item_id, fencing)` key, authorization to the interpreter.
Shapes check well-formedness of the claim, never whether the agent may make it.

## Naming rulings this exercise forced

- **`fd:` reused as minted**: `https://bounded.tools/ns/front-desk#` — already
  in production in [`../shacl/front-desk-shapes.ttl`](../shacl/front-desk-shapes.ttl).
  Not re-minted.
- **`verb:` newly minted** as `https://bounded.tools/ns/verb#` — following the
  org NAMESPACES.md registry pattern (bounded.tools, not bounded.systems: the
  registry and 276:7 code usage settle the base).
- **The context IRI resolves locally** through a documentLoader that refuses
  the network — vendored-and-pinned, the same answer conformance-kit gives.
  A minted IRI is a governance commitment; the loader is what makes it not
  also a runtime dependency.
- **Instance IRIs** (`…/id/grant/…`, `…/id/agent/…`) follow no registered
  scheme — the org NAMESPACES.md registry covers vocabulary only. Open
  question, flagged.

## Both shape engines, one contract

`shapes/claim.ttl` executes (shacl-engine 1.1.2 — the same engine as
conformance-kit's shared runner, prefixes `sh:declare`d for it).
`shapes/claim.shex` is the identical contract in ShExC — the parse-view the
org also runs (fold-engine's hand-rolled validator). ShEx states S1 more
naturally (`^fd:item @verb:ClaimGrantShape {0,1}` on the item's own shape);
SHACL is what the boundary infrastructure runs. Same Schemarama-style pairing
fold-engine's beads issues already describe.

## Run

From the repo root, the same way as everything else here (deps come from the
tracked lock; the script runs under Node >= 22.18, native TS):

```sh
deno install --frozen     # deps FROM the lock (also creates node_modules)
npm run claim:fixtures    # exit 0 iff every fixture expectation holds
```
