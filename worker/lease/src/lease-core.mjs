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

/**
 * @typedef {{ kind: string, id: string }} Referent
 * The thing whose lifecycle IS the lease's lifecycle (#105). Typed and OPAQUE:
 * the DO stores it and compares it; only the reaper interprets `kind`. `pr`
 * (id `owner/repo#number`) is the kind recognised today; a `guest-room` room id
 * is the one to grow into. An unrecognised kind is NOT immortal — the reaper
 * skips what it cannot interpret and says so, and the backstop TTL still bounds
 * the lease.
 */

/** @typedef {{ holder: string|null, expiresAt: number|null, fencing: number, referent: Referent|null }} LeaseState */

/** The empty lease. `fencing` starts at 0 and only ever increases. */
export const EMPTY_STATE = Object.freeze({ holder: null, expiresAt: null, fencing: 0, referent: null });

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
 * Validate a referent: `{ kind, id }`, both non-empty strings, modest length
 * caps so junk cannot be parked in DO storage. Thrown messages are authored for
 * the CALLER (the shell maps TypeError to a 400).
 */
export function validateReferent(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new TypeError("referent must be an object of shape { kind, id }");
  }
  const { kind, id } = v;
  if (typeof kind !== "string" || kind.trim() === "" || kind.length > 32) {
    throw new TypeError("referent.kind must be a non-empty string (max 32 chars)");
  }
  if (typeof id !== "string" || id.trim() === "" || id.length > 256) {
    throw new TypeError("referent.id must be a non-empty string (max 256 chars)");
  }
  return { kind: kind.trim(), id: id.trim() };
}

/** Stored states written before the referent existed lack the key. Absent and
    null are the same fact: no referent has materialized. */
function currentReferent(state) {
  return state.referent ?? null;
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

  // A fresh grant NEVER inherits the previous grant's referent: the old PR was
  // the old holder's work, and pinning the new grant to it would let the reaper
  // collect a lease because of somebody else's merge. The lease starts
  // referent-less on its (short) claim TTL; `decideBind` is how a referent
  // materializes and how the expiry grows into a backstop (#105).
  const next = { holder: agent, expiresAt: now + ms, fencing: state.fencing + 1, referent: null };
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
 * Bind — attach the referent, and re-size the expiry into a backstop.
 *
 * This is the "first push upgrades the lease" half of #105. A claim cannot know
 * a PR number that does not exist yet, so the lease starts referent-less on a
 * SHORT TTL (the time to produce a referent, not an estimate of the task). Once
 * the work exists somewhere with a queryable lifecycle, the holder binds it:
 * from then on the PRIMARY release path is the reaper observing the referent
 * close, and `expiresAt` is demoted to a backstop sized to "the reaper has been
 * broken for a day" — which is why binding takes a ttl and is expected to pass
 * a large one.
 *
 * Gated exactly like renew (holder + current fencing + live): a referent
 * determines when the lease DROPS, so letting a non-holder set it would hand
 * strangers a release trigger. Re-binding by the holder is allowed — a PR can
 * be closed and superseded by another — and is fenced the same way.
 */
export function decideBind(state, { agent, fencing, ttlSec, referent }, now) {
  const ms = ttlMs(ttlSec);
  const ref = validateReferent(referent);
  if (!isLive(state, now)) {
    return { state, response: { bound: false, reason: "expired", holder: state.holder, fencing: state.fencing } };
  }
  if (state.holder !== agent) {
    return { state, response: { bound: false, reason: "not-holder", holder: state.holder, fencing: state.fencing } };
  }
  if (fencing !== state.fencing) {
    return { state, response: { bound: false, reason: "stale-fencing", holder: state.holder, fencing: state.fencing } };
  }
  const next = { ...state, referent: ref, expiresAt: now + ms };
  return {
    state: next,
    response: { bound: true, holder: next.holder, fencing: next.fencing, referent: ref, expiresAt: next.expiresAt },
  };
}

/**
 * Reap — the garbage collector's release (#105, "GC as ref").
 *
 * The reaper observed the lease's referent to be merged, closed, or gone, and
 * asks the DO to drop the lease. Deliberately NOT gated on holder identity —
 * the whole premise is that the holder is finished or dead and cannot speak.
 * What gates it instead:
 *
 *   fencing    must be the CURRENT token, read from /status in the same sweep
 *              as the referent. A reap decided against grant N cannot collect
 *              grant N+1 — the same staleness check that stops a zombie's
 *              release, applied to the collector.
 *   referent   must equal the STORED referent. A reaper acting on a referent
 *              the lease is no longer pinned to (the holder re-bound) is acting
 *              on stale evidence, and is refused.
 *
 * A referent-less lease is never reapable: nothing materialized, so there is
 * nothing whose closure could mean anything. That lease is the backstop TTL's
 * to collect — `no-referent` here, `expired` there, and the two stay
 * distinguishable in history.
 *
 * Reaping frees; it never grants. Fencing is retained exactly as release
 * retains it, so a wrongful reap cannot mint a reusable token — the worst case
 * is an item returning to the queue early, which is the TTL's existing failure
 * mode. Idempotent for the caller: a repeated reap lands on `not-held`.
 */
export function decideReap(state, { fencing, referent }, now) {
  const ref = validateReferent(referent);
  if (!isLive(state, now)) {
    return { state, response: { reaped: false, reason: "not-held", fencing: state.fencing } };
  }
  if (fencing !== state.fencing) {
    return { state, response: { reaped: false, reason: "stale-fencing", holder: state.holder, fencing: state.fencing } };
  }
  const cur = currentReferent(state);
  if (cur === null) {
    return { state, response: { reaped: false, reason: "no-referent", holder: state.holder, fencing: state.fencing } };
  }
  if (cur.kind !== ref.kind || cur.id !== ref.id) {
    return {
      state,
      response: { reaped: false, reason: "referent-mismatch", holder: state.holder, fencing: state.fencing, referent: cur },
    };
  }
  return {
    state: { holder: null, expiresAt: null, fencing: state.fencing, referent: null },
    response: { reaped: true, holder: state.holder, fencing: state.fencing, referent: cur },
  };
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
export function decideRelease(state, { agent, fencing, status }, now) {
  // `status` restores the released-vs-completed distinction the lease plane
  // used to DROP (effort calibration reads it). Validated here because it goes
  // into the history record verbatim; an unknown value is a caller bug, not a
  // value to store.
  const st = status ?? "released";
  if (st !== "released" && st !== "completed") {
    throw new TypeError("status must be 'released' or 'completed'");
  }
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
  //
  // `status` is ECHOED so a caller can tell whether the worker it reached
  // records statuses at all: an older deployment ignores the field and its
  // response carries no echo, which is the client's version-skew signal.
  return {
    state: { holder: null, expiresAt: null, fencing: state.fencing, referent: null },
    response: { released: true, fencing: state.fencing, status: st },
  };
}

/** Read-only view. Reports liveness rather than making the caller compare
    clocks. The referent is reported alongside — it is what the reaper polls,
    and it must come from the same snapshot as the fencing it will present. */
export function describe(state, now) {
  return {
    holder: isLive(state, now) ? state.holder : null,
    fencing: state.fencing,
    expiresAt: state.expiresAt,
    live: isLive(state, now),
    referent: currentReferent(state),
  };
}

/*
  ── GRANT HISTORY (the projection's source) ───────────────────────────────────

  docs/queue-vs-log.md names the weakening this plane accepts: the log records
  decisions rather than being the decision — and it holds only if the projection
  write is IDEMPOTENT and REPLAYABLE. Replayable means the DO retains what
  happened; this fold is that record. One entry per GRANT, keyed by the fencing
  ordinal (unique and monotonic per item, which is what makes `(item_id,
  fencing)` the projection's idempotency key), updated in place as the grant is
  renewed and closed — a complete interval, the shape effort calibration reads.

  A separate pure function rather than a change to decide*'s signatures: the
  exclusion decision and the record of it are different concerns, and the
  existing decision theorems/tests stay untouched. The shell applies both inside
  ONE storage transaction (see index.mjs), so they cannot diverge.

  Retention: everything, for now. A grant record is ~120 bytes and DO storage is
  per-item; pruning behind a projector acknowledgement is future work and is
  NOT needed for replayability — the opposite: retention is what replayability
  currently rests on.
*/

const COMMIT_SHAPE = /^[a-z0-9]{32}$/;

/** Normalise a decided_at_commit: a well-formed Dolt hash or null. Invalid
    input degrades to null — "basis not reconstructible", never a fabricated
    stamp; the same rule src/mirror.ts applies before interpolating. */
export function normalizeDecidedAt(v) {
  return typeof v === "string" && COMMIT_SHAPE.test(v) ? v : null;
}

/**
 * Fold one adjudicated event into the grant history. Pure; returns a NEW array.
 * Only SUCCESSFUL transitions touch history — a refusal changes no state, so it
 * has nothing to record (refusals are the caller's log line, not the item's).
 */
export function historyStep(history, { type, request, before, after, response }, now) {
  const h = history ?? [];

  if (type === "claim" && response.granted) {
    const closedOver = h.map((r) =>
      // A grant over a LAPSED holder is the moment the DO learns the old grant
      // died. Close it as 'expired' AT ITS RECORDED EXPIRY — the factual lapse
      // time — not at `now`, which is merely when somebody next showed up.
      r.fencing === before.fencing && r.status === "active"
        ? { ...r, status: "expired", releasedAt: r.expiresAt }
        : r
    );
    return [
      ...closedOver,
      {
        fencing: after.fencing,
        agent: after.holder,
        decidedAtCommit: normalizeDecidedAt(request.decidedAtCommit),
        grantedAt: now,
        ttlSec: request.ttlSec,
        expiresAt: after.expiresAt,
        releasedAt: null,
        status: "active",
        reason: response.reason, // free | expired — how the grant was obtained
        referent: null, // materializes at bind, never at claim
      },
    ];
  }

  if (type === "renew" && response.renewed) {
    return h.map((r) =>
      r.fencing === after.fencing ? { ...r, expiresAt: after.expiresAt, ttlSec: request.ttlSec } : r
    );
  }

  if (type === "bind" && response.bound) {
    // Bind is renew-shaped for the record: the interval stays open, its expiry
    // and ttl move, and the referent lands on it — so the projected row can say
    // WHAT the grant was pinned to, not just that it ended.
    return h.map((r) =>
      r.fencing === after.fencing
        ? { ...r, expiresAt: after.expiresAt, ttlSec: request.ttlSec, referent: after.referent }
        : r
    );
  }

  if (type === "release" && response.released) {
    return h.map((r) =>
      r.fencing === before.fencing ? { ...r, status: response.status, releasedAt: now } : r
    );
  }

  if (type === "reap" && response.reaped) {
    // 'reaped' is its own terminal status, distinct from released/completed
    // (the holder said so) and from expired (the backstop fired). Keeping the
    // three apart is what makes a backstop expiry a monitorable anomaly (#105)
    // instead of normal operation.
    return h.map((r) =>
      r.fencing === before.fencing ? { ...r, status: "reaped", releasedAt: now } : r
    );
  }

  return h;
}

/** A record's status AS OF `now`: an 'active' record past its expiry is
    'expired' even though nothing has touched the item since — expiry is a fact
    about the clock, not about contention. Computed on read so the stored record
    is never mutated by observation. */
export function effectiveStatus(record, now) {
  if (record.status === "active" && now >= record.expiresAt) return "expired";
  return record.status;
}
