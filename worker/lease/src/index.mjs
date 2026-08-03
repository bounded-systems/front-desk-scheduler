/**
 * front-desk-lease — the scheduler's serialization point.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * `leases.item_id` is a PRIMARY KEY, which excludes at most one holder per item
 * WITHIN ONE DATABASE. In production there was no shared one: claim writes went
 * to a per-agent local Dolt clone, so N agents latched N databases and each read
 * back its own name. The key was never wrong; its precondition was never met.
 *
 * A `dolt sql-server` would fix that by CONFIGURATION — one agent pointed
 * somewhere else and the property is gone, with a green test. A Durable Object
 * fixes it by CONSTRUCTION: one instance per item_id, single-threaded, no
 * configuration under which two claims for one item run concurrently.
 *
 * See docs/queue-vs-log.md. The decision recorded there is not "which
 * serializer" but "is Dolt the queue or the log". It is the log now: this is
 * ground truth for exclusion, and the Dolt row becomes a derived projection.
 * The named weakening — the log records decisions rather than being the
 * decision — is a trust edge that holds only if the projection write is
 * idempotent and replayable.
 *
 * WHAT THIS FILE IS AND IS NOT
 * ----------------------------
 * It is a shell. Every decision lives in lease-core.mjs as a pure function, so
 * orderings can be tested exhaustively without a runtime. This file supplies
 * exactly one thing the pure core cannot: the guarantee that one caller applies
 * a transition at a time.
 *
 * That guarantee has a precondition of its own (A1′ in lease-core.mjs):
 * Cloudflare's input gates serialize handlers that await ONLY storage. Await a
 * fetch or a timer inside a transition and the gate opens mid-flight. So
 * `applyTransition` below awaits storage and nothing else, and that is a
 * correctness property rather than a style choice.
 */

import { authenticate, namespaceAgent } from "./auth.mjs";
import {
  canonicalItemId,
  decideBind,
  decideClaim,
  decideReap,
  decideRelease,
  decideRenew,
  describe,
  effectiveStatus,
  EMPTY_STATE,
  historyStep,
} from "./lease-core.mjs";

const STATE_KEY = "lease";
const HISTORY_KEY = "history";

export class LeaseObject {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
   * Load → decide → record → store, awaiting storage and NOTHING else.
   *
   * Introducing any non-storage await between the get and the puts would open
   * the input gate and let a second request interleave — reintroducing exactly
   * the check-then-act race the whole design exists to remove. Keeping the
   * critical section in one function makes that reviewable in one place.
   *
   * The grant HISTORY is folded in the SAME critical section as the decision,
   * so the record can never disagree with the state it records — the exclusion
   * transition and its audit entry commit together or not at all. That is the
   * DO-side half of "the log records decisions rather than being the decision"
   * (docs/queue-vs-log.md): the record is written where the decision is
   * serialized, and the Dolt row is derived from it later, idempotently.
   */
  async applyTransition(type, request, decide) {
    const state = (await this.ctx.storage.get(STATE_KEY)) ?? EMPTY_STATE;
    const history = (await this.ctx.storage.get(HISTORY_KEY)) ?? [];
    const now = Date.now();
    const { state: next, response } = decide(state, now);
    if (next !== state) {
      const nextHistory = historyStep(
        history,
        { type, request, before: state, after: next, response },
        now,
      );
      await this.ctx.storage.put(STATE_KEY, next);
      await this.ctx.storage.put(HISTORY_KEY, nextHistory);
    }
    return response;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return json({ error: "body must be JSON" }, 400);
      }
    }

    try {
      switch (url.pathname) {
        case "/claim": {
          const req = { agent: body.agent, ttlSec: body.ttl_sec, decidedAtCommit: body.decided_at_commit };
          return json(await this.applyTransition("claim", req, (s, now) => decideClaim(s, req, now)));
        }
        case "/renew": {
          const req = { agent: body.agent, fencing: body.fencing, ttlSec: body.ttl_sec };
          return json(await this.applyTransition("renew", req, (s, now) => decideRenew(s, req, now)));
        }
        case "/bind": {
          // Attach the referent and re-size the expiry into the backstop. The
          // holder-facing half of #105; gated like /renew.
          const req = { agent: body.agent, fencing: body.fencing, ttlSec: body.ttl_sec, referent: body.referent };
          return json(await this.applyTransition("bind", req, (s, now) => decideBind(s, req, now)));
        }
        case "/reap": {
          // The collector's release. No agent field on purpose — the reaper is
          // not the holder and does not pretend to be; the router's auth gate
          // still applies (it is a POST), and the DO checks fencing + referent.
          const req = { fencing: body.fencing, referent: body.referent };
          return json(await this.applyTransition("reap", req, (s, now) => decideReap(s, req, now)));
        }
        case "/release": {
          const req = { agent: body.agent, fencing: body.fencing, status: body.status };
          return json(await this.applyTransition("release", req, (s, now) => decideRelease(s, req, now)));
        }
        case "/status": {
          const state = (await this.ctx.storage.get(STATE_KEY)) ?? EMPTY_STATE;
          return json(describe(state, Date.now()));
        }
        case "/history": {
          // The projection's read surface. `since_fencing` lets a projector
          // resume from its watermark — which is the PROJECTION ITSELF (max
          // projected fencing per item), so there is no separate cursor to
          // lose. `effective_status` is computed as-of-now on read: an
          // 'active' record past its expiry reads as 'expired' without any
          // write having happened, because expiry is a fact about the clock.
          const since = Number(url.searchParams.get("since_fencing") ?? 0);
          const history = (await this.ctx.storage.get(HISTORY_KEY)) ?? [];
          const now = Date.now();
          return json({
            now,
            records: history
              .filter((r) => r.fencing > since)
              .map((r) => ({ ...r, effective_status: effectiveStatus(r, now) })),
          });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      // TypeError/RangeError from the core are CALLER errors — bad agent, bad
      // ttl — and their messages are authored in lease-core.mjs for exactly
      // this audience. "ttl_sec must be a positive number" is the useful reply.
      if (e instanceof TypeError || e instanceof RangeError) {
        return json({ error: e.message }, 400);
      }
      // Anything else is OUR bug, and its message is not the caller's business:
      // echoing it hands them our internals (CodeQL: information exposure
      // through a stack trace) and is not actionable for them either. Log it
      // where an operator can see it; return a reply whose content does not
      // vary with the shape of the failure.
      console.error("lease: unhandled error", e);
      return json({ error: "internal error" }, 500);
    }
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Positive auth results, per isolate. Bounded by eviction below; keyed by a
 *  hash of the token, never the token (see auth.mjs). */
const authCache = new Map();
const AUTH_CACHE_MAX = 512;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true });

    // A2′ — the routing key. Every claimant for one item MUST reach the same
    // instance, so the id is derived from a canonicalised item_id by one
    // function. A second namespace, or a caller that forgot to normalise, would
    // give two serialization points for one item: the original bug in new
    // clothes. This is the only place a DO id is constructed.
    const itemId = url.searchParams.get("item_id") ?? "";
    let name;
    try {
      name = canonicalItemId(itemId);
    } catch (e) {
      return json({ error: `item_id: ${e.message}` }, 400);
    }

    // ── auth: WRITES prove a GitHub identity; reads stay open ────────────────
    //
    // Reads (/status, /history) are open because their content ends up in the
    // PUBLIC Dolt mirror via the projection anyway — gating them would protect
    // nothing while breaking the projector. Writes are the mutations that S1
    // exists to arbitrate, so they carry the gate.
    //
    // This runs HERE, in the router, and never in the DO: authenticate() awaits
    // the GitHub API, and a non-storage await inside the DO's critical section
    // would open the input gate (A1′). By the time the DO sees the request, the
    // identity work is done and serialized-world rules hold again.
    //
    // AUTH_MODE unset means "github" — the fail-CLOSED default. "none" must be
    // written into the deployment's config on purpose, for a scratch/race
    // deployment where unauthenticated claims are an accepted property, and it
    // is visible in wrangler.jsonc precisely so that acceptance is reviewable.
    let body = null;
    if (request.method === "POST") {
      const mode = env.AUTH_MODE ?? "github";
      if (mode !== "none") {
        const m = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "");
        if (!m) {
          return json({
            error: "writes require `Authorization: Bearer <github token>` — a session's GH_TOKEN " +
              "or a workflow's github.token; the token must have push permission on the repo",
          }, 401);
        }
        if (authCache.size > AUTH_CACHE_MAX) authCache.clear();
        const verdict = await authenticate(m[1], {
          repo: env.ALLOWED_REPO ?? "bounded-systems/front-desk-scheduler",
          cache: authCache,
        });
        if (!verdict.ok) return json({ error: `authentication failed: ${verdict.reason}` }, 403);
        // Bind the last self-asserted string in the system: the alias survives
        // only namespaced under the identity that proved itself.
        try {
          body = await request.json().catch(() => ({}));
          body.agent = namespaceAgent(verdict.identity, body.agent);
        } catch (e) {
          return json({ error: e instanceof TypeError ? e.message : "bad request" }, 400);
        }
      }
    }

    const id = env.LEASE.idFromName(name);
    const stub = env.LEASE.get(id);
    if (body !== null) {
      // Re-serialize with the namespaced agent; everything else passes through.
      return stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    }
    return stub.fetch(request);
  },
};
