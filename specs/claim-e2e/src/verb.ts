/**
 * The `claim` verb, verbspec-shaped, mirroring the real semantics in
 * this repo (scripts/claim.ts, src/mirror.ts claimNext/releaseClaim,
 * schema/migrations/2026-07-27-leases.sql, 2026-07-29-claims-fencing.sql).
 *
 * Two different Zod schemas live here, and keeping them distinct is the point:
 *
 *  - `claim.input` / `claim.output` — the VERB's exchange types. Validated by
 *    dispatch at the call boundary; never persisted.
 *  - `ClaimGrantDoc` — the capability INSTANCE: the lease as a document that
 *    crosses boundaries. This is what verbspec deliberately does not model
 *    ("verbspec is not a job runner") — the supervisor emits it, verbs read it.
 */
import { z } from "zod";

export const claim = {
  id: "claim",
  summary: "Lease the next eligible item for an agent (atomic CAS; S1-safe)",
  actor: "agent",
  input: z.object({
    agent: z.string().min(1),
    repo: z.string().optional(),
    ttl: z.number().int().positive().default(3600), // mirrors chk_ttl
  }).strict(),
  output: z.discriminatedUnion("won", [
    z.object({
      won: z.literal(true),
      itemId: z.string(),
      number: z.number().int().nullable(),
      title: z.string(),
      reason: z.string(),
      fencing: z.number().int().nonnegative(),
    }).strict(),
    z.object({ won: z.literal(false), reason: z.string() }).strict(),
  ]),
};

export const release = {
  id: "release",
  summary: "Release a held lease, with the fencing token from claim",
  actor: "agent",
  input: z.object({
    itemId: z.string(),
    agent: z.string().min(1),
    status: z.enum(["released", "completed"]),
    // Required on the lease plane: "a release without one is how a zombie
    // frees the NEW holder's lease" (src/mirror.ts releaseClaim).
    fencing: z.number().int().nonnegative(),
  }).strict(),
  output: z.object({ ok: z.boolean(), reason: z.string() }).strict(),
};

/** The grant document — layer-2 gate for the capability instance. */
const IRI = z.string().url();
const ISO_DATETIME = z.string().datetime({ message: "must be an ISO-8601 dateTime with timezone" });

export const ClaimGrantDoc = z.object({
  "@context": z.literal("https://bounded.tools/ns/claim/v1"),
  "@id": IRI,
  "@type": z.literal("ClaimGrant"),
  agent: IRI,
  item: z.object({
    "@id": IRI,
    "@type": z.literal("Item"), // renderer requirement 2 — see shapes/claim.ttl
  }).strict(),
  fencing: z.number().int().nonnegative(),
  ttlSec: z.number().int().positive(),
  claimedAt: ISO_DATETIME,
  expiresAt: ISO_DATETIME,
  plane: z.enum(["lease", "dolt"]),
}).strict();
