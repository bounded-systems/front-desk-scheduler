/**
 * The lease decision, as a pure function.
 *
 * Same split the rest of this repo makes: `policy.ts` is pure and sequential,
 * and every race lives in the mechanism around it. Here the mechanism is a
 * Durable Object, which supplies serialization; this file supplies the decision
 * and knows nothing about storage, HTTP, or concurrency.
 *
 * The point of the split is testability of ORDERINGS. A pure
 * (state, request, now) → (state', response) can be driven through any
 * interleaving in a unit test, exhaustively and deterministically, with no
 * runtime. What it CANNOT establish is that only one caller applies a
 * transition at a time — that is the DO's job, and it is stated as an
 * assumption below rather than assumed silently.
 *
 * ASSUMPTIONS THIS FILE DOES NOT DISCHARGE
 * ----------------------------------------
 *   A1′  The DO runtime applies one request's read-modify-write at a time.
 *        Cloudflare input gates give this for handlers that only await storage.
 *        Await anything else mid-transition (a fetch, a timer) and the gate
 *        opens — which is why `applyTransition` in index.mjs awaits storage and
 *        nothing else.
 *
 *   A2′  Every claimant for one item reaches the SAME DO instance, i.e. the
 *        router derives the id via `idFromName(canonical(item_id))` and nothing
 *        else. Two namespaces, or a non-canonical key, and there are two
 *        serialization points again — the exact failure the Dolt design had,
 *        wearing different clothes. `canonicalItemId` exists to make the key
 *        one function rather than a convention.
 *
 * A1′ and A2′ are the DO analogues of A1/A2 in specs/lean/Leases.lean. Naming
 * them is the point: the old design's PRIMARY KEY was never wrong either, and
 * an unnamed precondition is one nobody checks.
 */

/** @typedef {{ holder: string|null, expiresAt: number|null, fencing: number }} LeaseState */

/** The empty lease. `fencing` starts at 0 and only ever increases. */
export const EMPTY_STATE = Object.freeze({ holder: null, expiresAt: null, fencing: 0 });

/**
 * The routing key. A2′ depends on every caller deriving the same DO name from
 * the same item, so this is a function and not a convention — trimmed and
 * lowercased, because `PRX#12` and `prx#12 ` reaching different instances would
 * silently give two serialization points for one item.
 */
export function canonicalItemId(itemId) {
  if (typeof itemId !== "string") throw new TypeError("item_id must be a string");
  const c = itemId.trim().toLowerCase();
  if (c === "") throw new TypeError("item_id must not be empty");
  return c;
}

/** A lease is LIVE while its TTL has not elapsed. Expiry is the whole reason
 *  this is a lease and not a lock: a dead holder's grip lapses on its own. */
export function isLive(state, now) {
  return state.holder !== null && state.expiresAt !== null && now < state.expiresAt;
}

function ttlMs(ttlSec) {
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new RangeError("ttl_sec must be a positive number");
  return Math.floor(ttlSec * 1000);
}

/**
 * Claim.
 *
 * Granted only when no LIVE lease exists. Every grant takes a strictly larger
 * fencing token — including a grant that follows an expiry, which is precisely
 * the case that makes the previous holder a zombie. The stale holder is not
 * notified and cannot be; the token is what lets everyone downstream tell the
 * two apart.
 */
export function decideClaim(state, { agent, ttlSec }, now) {
  if (typeof agent !== "string" || agent === "") throw new TypeError("agent must be a non-empty string");
  const ms = ttlMs(ttlSec);

  if (isLive(state, now)) {
    // Deliberately a denial even when `agent` already holds it. A re-claim by
    // the holder is a renew, and conflating them would let an agent silently
    // bump its own fencing token — which is the one number the effect side
    // relies on being stable for the life of a grant.
    return {
      state,
      response: {
        granted: false,
        holder: state.holder,
        fencing: state.fencing,
        expiresAt: state.expiresAt,
        reason: state.holder === agent ? "already-held-by-you" : "held",
      },
    };
  }

  const next = { holder: agent, expiresAt: now + ms, fencing: state.fencing + 1 };
  return {
    state: next,
    response: {
      granted: true,
      holder: next.holder,
      fencing: next.fencing,
      expiresAt: next.expiresAt,
      // Distinguishable so a caller can see it took over from a lapsed holder
      // rather than an idle item — the situations differ operationally even
      // though the grant is identical.
      reason: state.holder === null ? "free" : "expired",
    },
  };
}

/**
 * Renew (heartbeat).
 *
 * Requires the caller to be the holder AND to present the CURRENT fencing
 * token AND for the lease to still be live. A lapsed holder gets `false`, and
 * that false is the queue-side half of fencing: the signal to stop working.
 * The effect-side half — a sink refusing a stale token — is separate, and
 * neither substitutes for the other.
 */
export function decideRenew(state, { agent, fencing, ttlSec }, now) {
  const ms = ttlMs(ttlSec);
  if (!isLive(state, now)) {
    return { state, response: { renewed: false, reason: "expired", holder: state.holder, fencing: state.fencing } };
  }
  if (state.holder !== agent) {
    return { state, response: { renewed: false, reason: "not-holder", holder: state.holder, fencing: state.fencing } };
  }
  if (fencing !== state.fencing) {
    return { state, response: { renewed: false, reason: "stale-fencing", holder: state.holder, fencing: state.fencing } };
  }
  const next = { ...state, expiresAt: now + ms };
  return { state: next, response: { renewed: true, holder: next.holder, fencing: next.fencing, expiresAt: next.expiresAt } };
}

/**
 * Release.
 *
 * The fencing check here is load-bearing in a way that is easy to miss: without
 * it, a zombie that wakes up and releases would free a lease belonging to the
 * NEW holder, handing the item to a third agent while the second is still
 * working. The stale token makes that release a no-op instead.
 *
 * Releasing an already-free lease is idempotent, not an error — a retried
 * release must not be able to disturb a subsequent holder.
 */
export function decideRelease(state, { agent, fencing }, now) {
  if (!isLive(state, now)) {
    return { state, response: { released: false, reason: "not-held", fencing: state.fencing } };
  }
  if (state.holder !== agent) {
    return { state, response: { released: false, reason: "not-holder", holder: state.holder, fencing: state.fencing } };
  }
  if (fencing !== state.fencing) {
    return { state, response: { released: false, reason: "stale-fencing", holder: state.holder, fencing: state.fencing } };
  }
  // Holder and expiry clear; `fencing` is RETAINED. It is a monotonic counter
  // for the item, not a property of the current grant — resetting it on release
  // would let a later grant reuse a token an old zombie still carries.
  return {
    state: { holder: null, expiresAt: null, fencing: state.fencing },
    response: { released: true, fencing: state.fencing },
  };
}

/** Read-only view. Reports liveness rather than making the caller compare clocks. */
export function describe(state, now) {
  return {
    holder: isLive(state, now) ? state.holder : null,
    fencing: state.fencing,
    expiresAt: state.expiresAt,
    live: isLive(state, now),
  };
}
