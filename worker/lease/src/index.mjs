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

import {
  canonicalItemId,
  decideClaim,
  decideRelease,
  decideRenew,
  describe,
  EMPTY_STATE,
} from "./lease-core.mjs";

const STATE_KEY = "lease";

export class LeaseObject {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
   * Load → decide → store, awaiting storage and NOTHING else.
   *
   * Introducing any non-storage await between the get and the put would open
   * the input gate and let a second request interleave — reintroducing exactly
   * the check-then-act race the whole design exists to remove. Keeping the
   * critical section in one function makes that reviewable in one place.
   */
  async applyTransition(decide) {
    const state = (await this.ctx.storage.get(STATE_KEY)) ?? EMPTY_STATE;
    const now = Date.now();
    const { state: next, response } = decide(state, now);
    if (next !== state) await this.ctx.storage.put(STATE_KEY, next);
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
        case "/claim":
          return json(
            await this.applyTransition((s, now) =>
              decideClaim(s, { agent: body.agent, ttlSec: body.ttl_sec }, now)
            ),
          );
        case "/renew":
          return json(
            await this.applyTransition((s, now) =>
              decideRenew(s, { agent: body.agent, fencing: body.fencing, ttlSec: body.ttl_sec }, now)
            ),
          );
        case "/release":
          return json(
            await this.applyTransition((s, now) =>
              decideRelease(s, { agent: body.agent, fencing: body.fencing }, now)
            ),
          );
        case "/status": {
          const state = (await this.ctx.storage.get(STATE_KEY)) ?? EMPTY_STATE;
          return json(describe(state, Date.now()));
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

    const id = env.LEASE.idFromName(name);
    return env.LEASE.get(id).fetch(request);
  },
};
