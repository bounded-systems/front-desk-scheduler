/**
 * The lease decision, driven through orderings.
 *
 * These tests establish what a pure function CAN establish: that every
 * transition is correct given the state it is handed, across every interleaving
 * that matters. They deliberately do NOT establish S1 — "at most one live
 * holder" is a property of the mechanism, not the decision, and asserting it
 * here would be the same error as `claim-race` provisioning the topology it
 * claimed to measure. S1 rests on A1′/A2′ in lease-core.mjs, and the experiment
 * that binds it is `production-a2` in .github/workflows/claim-race.yml.
 *
 * What IS worth testing exhaustively here is fencing, because fencing is the
 * part where a plausible implementation is quietly wrong: a zombie releasing a
 * lease it no longer holds, or a counter reset that lets a token be reused.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  canonicalItemId,
  decideClaim,
  decideRelease,
  decideRenew,
  describe,
  EMPTY_STATE,
  isLive,
} from "./lease-core.mjs";

const T0 = 1_800_000_000_000; // a fixed clock; nothing here may depend on real time
const claim = (s, agent, now, ttlSec = 60) => decideClaim(s, { agent, ttlSec }, now);

test("a free item grants, and the grant is fenced", () => {
  const { state, response } = claim(EMPTY_STATE, "alice", T0);
  assert.equal(response.granted, true);
  assert.equal(response.holder, "alice");
  assert.equal(response.fencing, 1, "the first grant is fencing 1, not 0");
  assert.equal(response.reason, "free");
  assert.equal(state.expiresAt, T0 + 60_000);
});

test("a live lease excludes everyone else", () => {
  const held = claim(EMPTY_STATE, "alice", T0).state;
  const { state, response } = claim(held, "bob", T0 + 1_000);
  assert.equal(response.granted, false);
  assert.equal(response.holder, "alice", "the loser learns who holds it");
  assert.equal(state, held, "a denied claim must not mutate state");
});

test("the holder re-claiming is denied, not silently re-fenced", () => {
  // Conflating re-claim with renew would let an agent bump its own fencing
  // token mid-grant — the one number the effect side needs to be stable.
  const held = claim(EMPTY_STATE, "alice", T0).state;
  const { state, response } = claim(held, "alice", T0 + 1_000);
  assert.equal(response.granted, false);
  assert.equal(response.reason, "already-held-by-you");
  assert.equal(state.fencing, 1, "fencing must not move");
});

test("expiry frees the item, and the new grant is strictly higher-fenced", () => {
  const held = claim(EMPTY_STATE, "alice", T0).state;
  const after = T0 + 61_000; // alice's 60s lapsed
  assert.equal(isLive(held, after), false);
  const { state, response } = claim(held, "bob", after);
  assert.equal(response.granted, true);
  assert.equal(response.holder, "bob");
  assert.equal(response.fencing, 2, "a takeover must out-fence the lapsed holder");
  assert.equal(response.reason, "expired", "distinguishable from claiming an idle item");
  assert.ok(state.fencing > held.fencing);
});

// ── the zombie, which is the whole reason fencing exists ─────────────────────

test("a lapsed holder's renew returns false — the signal to stop", () => {
  const alice = claim(EMPTY_STATE, "alice", T0);
  const after = T0 + 61_000;
  const bob = claim(alice.state, "bob", after);

  const r = decideRenew(bob.state, { agent: "alice", fencing: 1, ttlSec: 60 }, after + 1);
  assert.equal(r.renewed, undefined);
  assert.equal(r.response.renewed, false);
  assert.equal(r.response.reason, "not-holder");
  assert.equal(r.state, bob.state, "a failed renew must not disturb the live holder");
});

test("a zombie CANNOT release the new holder's lease", () => {
  // Without the fencing check this is a real incident: alice wakes, releases,
  // and the item is handed to a third agent while bob is still working on it.
  const alice = claim(EMPTY_STATE, "alice", T0);
  const after = T0 + 61_000;
  const bob = claim(alice.state, "bob", after);

  const r = decideRelease(bob.state, { agent: "alice", fencing: 1 }, after + 1);
  assert.equal(r.response.released, false);
  assert.equal(r.response.reason, "not-holder");
  assert.equal(r.state.holder, "bob", "bob still holds it");
});

test("a stale fencing token from the RIGHT agent is still refused", () => {
  // The subtler case: alice held it, lapsed, and re-acquired. Her OLD token
  // must not work, or a delayed retry could act with a superseded grant.
  const first = claim(EMPTY_STATE, "alice", T0);
  const after = T0 + 61_000;
  const second = claim(first.state, "alice", after);
  assert.equal(second.response.fencing, 2);

  for (const [op, decide] of [["renew", decideRenew], ["release", decideRelease]]) {
    const r = decide(second.state, { agent: "alice", fencing: 1, ttlSec: 60 }, after + 1);
    const ok = r.response.renewed ?? r.response.released;
    assert.equal(ok, false, `${op} with a stale token must fail`);
    assert.equal(r.response.reason, "stale-fencing");
  }
});

test("fencing never decreases and never repeats, across many cycles", () => {
  // Monotonicity is the property the effect side depends on for a TOTAL ORDER.
  // A Dolt commit hash cannot supply this: it is content-addressed, an
  // identity, never an ordering. That is a large part of why the DO won.
  let state = EMPTY_STATE;
  let now = T0;
  const seen = [];
  for (let i = 0; i < 25; i++) {
    const c = claim(state, `agent-${i}`, now);
    assert.equal(c.response.granted, true);
    seen.push(c.response.fencing);
    state = c.state;
    // alternate between an explicit release and letting it lapse
    if (i % 2 === 0) {
      state = decideRelease(state, { agent: `agent-${i}`, fencing: c.response.fencing }, now).state;
      now += 1_000;
    } else {
      now += 61_000;
    }
  }
  assert.deepEqual(seen, [...Array(25).keys()].map((i) => i + 1));
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], "strictly increasing");
});

test("release retains the counter — resetting it would let a token be reused", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const freed = decideRelease(c.state, { agent: "alice", fencing: 1 }, T0 + 1).state;
  assert.equal(freed.holder, null);
  assert.equal(freed.fencing, 1, "counter survives release");
  assert.equal(claim(freed, "bob", T0 + 2).response.fencing, 2, "next grant still out-fences");
});

test("releasing a free lease is a no-op, not an error", () => {
  // A retried release must never be able to disturb a subsequent holder.
  const r = decideRelease(EMPTY_STATE, { agent: "alice", fencing: 1 }, T0);
  assert.equal(r.response.released, false);
  assert.equal(r.response.reason, "not-held");
  assert.equal(r.state, EMPTY_STATE);
});

// ── renew ────────────────────────────────────────────────────────────────────

test("the holder renews and the expiry moves out", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const r = decideRenew(c.state, { agent: "alice", fencing: 1, ttlSec: 60 }, T0 + 30_000);
  assert.equal(r.response.renewed, true);
  assert.equal(r.state.expiresAt, T0 + 90_000);
  assert.equal(r.state.fencing, 1, "renewing does not re-fence");
});

test("renewing an expired lease fails even for the last holder, with nobody else waiting", () => {
  // Expiry is a fact about the clock, not about contention. A holder that let
  // its lease lapse has lost it whether or not anyone took over.
  const c = claim(EMPTY_STATE, "alice", T0);
  const r = decideRenew(c.state, { agent: "alice", fencing: 1, ttlSec: 60 }, T0 + 61_000);
  assert.equal(r.response.renewed, false);
  assert.equal(r.response.reason, "expired");
});

// ── the referent (#105): bind, then reap ─────────────────────────────────────
// TTL used to be asked two questions at once — "how long is the task?" and
// "when is the holder dead?" — and no number answers both. What is pinned here:
// the referent materializes only through a fenced bind, the reaper can collect
// only against the CURRENT fencing AND the CURRENT referent, and a lease that
// never materialized a referent is the backstop's to collect, never the
// reaper's.

import { decideBind, decideReap, validateReferent } from "./lease-core.mjs";

const PR = { kind: "pr", id: "bounded-systems/front-desk-scheduler#103" };

test("a claim starts referent-less; the holder binds one and the expiry re-sizes", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  assert.equal(c.state.referent, null, "a fresh grant never has a referent");
  const b = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 10_000);
  assert.equal(b.response.bound, true);
  assert.deepEqual(b.state.referent, PR);
  assert.equal(b.state.expiresAt, T0 + 10_000 + 86_400_000, "binding re-sizes the expiry into the backstop");
  assert.equal(b.state.fencing, 1, "binding does not re-fence");
});

test("bind is gated like renew: non-holder, stale token, and lapsed lease are all refused", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const notHolder = decideBind(c.state, { agent: "bob", fencing: 1, ttlSec: 60, referent: PR }, T0 + 1);
  assert.equal(notHolder.response.bound, false);
  assert.equal(notHolder.response.reason, "not-holder");
  assert.equal(notHolder.state, c.state, "a refused bind must not set the release trigger");

  const stale = decideBind(c.state, { agent: "alice", fencing: 99, ttlSec: 60, referent: PR }, T0 + 1);
  assert.equal(stale.response.reason, "stale-fencing");

  const lapsed = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 60, referent: PR }, T0 + 61_000);
  assert.equal(lapsed.response.reason, "expired");
});

test("the holder may re-bind — a PR can be closed and superseded", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const b1 = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 1);
  const PR2 = { kind: "pr", id: "bounded-systems/front-desk-scheduler#110" };
  const b2 = decideBind(b1.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR2 }, T0 + 2);
  assert.equal(b2.response.bound, true);
  assert.deepEqual(b2.state.referent, PR2, "last fenced bind wins");
});

test("the reaper collects a bound lease against the current fencing and referent", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const b = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 1);
  const r = decideReap(b.state, { fencing: 1, referent: PR }, T0 + 500_000);
  assert.equal(r.response.reaped, true);
  assert.equal(r.response.holder, "alice", "the reap reports whose grip it broke");
  assert.equal(r.state.holder, null);
  assert.equal(r.state.referent, null);
  assert.equal(r.state.fencing, 1, "reap retains the counter exactly as release does");
  assert.equal(claim(r.state, "bob", T0 + 500_001).response.fencing, 2, "next grant still out-fences");
});

test("a referent-less lease is NEVER reapable — that corpse belongs to the backstop", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const r = decideReap(c.state, { fencing: 1, referent: PR }, T0 + 1);
  assert.equal(r.response.reaped, false);
  assert.equal(r.response.reason, "no-referent");
  assert.equal(r.state, c.state);
});

test("a reap on stale evidence is refused: old fencing, or a referent since re-bound", () => {
  // The reaper read /status, then the world moved. Both staleness axes refuse.
  const c = claim(EMPTY_STATE, "alice", T0);
  const b = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 1);

  const staleFence = decideReap(b.state, { fencing: 0, referent: PR }, T0 + 2);
  assert.equal(staleFence.response.reaped, false);
  assert.equal(staleFence.response.reason, "stale-fencing");

  const PR2 = { kind: "pr", id: "bounded-systems/front-desk-scheduler#110" };
  const rebound = decideBind(b.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR2 }, T0 + 3);
  const staleRef = decideReap(rebound.state, { fencing: 1, referent: PR }, T0 + 4);
  assert.equal(staleRef.response.reaped, false);
  assert.equal(staleRef.response.reason, "referent-mismatch");
  assert.deepEqual(staleRef.response.referent, PR2, "the refusal names what the lease is actually pinned to");
  assert.equal(staleRef.state, rebound.state, "no refused reap may free the lease");
});

test("a repeated reap is idempotent — the second lands on not-held", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  const b = decideBind(c.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 1);
  const first = decideReap(b.state, { fencing: 1, referent: PR }, T0 + 2);
  const second = decideReap(first.state, { fencing: 1, referent: PR }, T0 + 3);
  assert.equal(second.response.reaped, false);
  assert.equal(second.response.reason, "not-held");
});

test("a takeover after a reap works, and the zombie's old token stays dead", () => {
  // The end-to-end #105 story: alice binds her PR, it merges, the reaper frees
  // the item, bob claims it — and alice's grant-1 token can do nothing.
  const alice = claim(EMPTY_STATE, "alice", T0);
  const bound = decideBind(alice.state, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 1);
  const reaped = decideReap(bound.state, { fencing: 1, referent: PR }, T0 + 2);
  const bob = claim(reaped.state, "bob", T0 + 3);
  assert.equal(bob.response.granted, true);
  assert.equal(bob.response.fencing, 2);
  assert.equal(bob.response.reason, "free", "a reaped lease reads as free, not as a corpse takeover");
  const zombie = decideRelease(bob.state, { agent: "alice", fencing: 1 }, T0 + 4);
  assert.equal(zombie.response.released, false);
});

test("referent validation refuses junk rather than storing it", () => {
  const held = claim(EMPTY_STATE, "alice", T0).state;
  for (const bad of [null, undefined, "pr", 42, [], {}, { kind: "pr" }, { id: "x" },
    { kind: "", id: "x" }, { kind: "pr", id: "" }, { kind: "x".repeat(33), id: "y" },
    { kind: "pr", id: "y".repeat(257) }]) {
    assert.throws(() => decideBind(held, { agent: "alice", fencing: 1, ttlSec: 60, referent: bad }, T0 + 1), /referent/);
    assert.throws(() => decideReap(held, { fencing: 1, referent: bad }, T0 + 1), /referent/);
  }
  assert.deepEqual(validateReferent({ kind: " pr ", id: " a#1 " }), { kind: "pr", id: "a#1" }, "trimmed, same as item ids");
});

test("a pre-referent stored state (no referent key) reads and transitions cleanly", () => {
  // States written by the deployed worker predate the field. Absent and null
  // must be the same fact everywhere.
  const legacy = { holder: "alice", expiresAt: T0 + 60_000, fencing: 3 };
  assert.equal(describe(legacy, T0).referent, null);
  const r = decideReap(legacy, { fencing: 3, referent: PR }, T0 + 1);
  assert.equal(r.response.reason, "no-referent");
  const b = decideBind(legacy, { agent: "alice", fencing: 3, ttlSec: 86_400, referent: PR }, T0 + 1);
  assert.equal(b.response.bound, true);
  assert.deepEqual(b.state.referent, PR);
});

// ── the routing key (A2′) ────────────────────────────────────────────────────

test("canonicalItemId collapses the variants that would split the item", () => {
  // If `PRX#12` and `prx#12 ` produced different DO names there would be two
  // serialization points for one item — the original defect, in new clothes.
  const want = "prx#12";
  for (const v of ["prx#12", "PRX#12", " prx#12 ", "Prx#12\n"]) {
    assert.equal(canonicalItemId(v), want, `${JSON.stringify(v)} must canonicalise`);
  }
  for (const bad of ["", "   ", null, undefined, 12]) {
    assert.throws(() => canonicalItemId(bad), /item_id/);
  }
});

// ── input validation ─────────────────────────────────────────────────────────

test("a bad ttl or agent is rejected rather than stored", () => {
  for (const ttl of [0, -1, NaN, Infinity, "60"]) {
    assert.throws(() => claim(EMPTY_STATE, "alice", T0, ttl), /ttl_sec/);
  }
  for (const agent of ["", null, 42]) {
    assert.throws(() => decideClaim(EMPTY_STATE, { agent, ttlSec: 60 }, T0), /agent/);
  }
});

test("describe reports liveness rather than making callers compare clocks", () => {
  const c = claim(EMPTY_STATE, "alice", T0);
  assert.deepEqual(describe(c.state, T0 + 1_000), {
    holder: "alice", fencing: 1, expiresAt: T0 + 60_000, live: true, referent: null,
  });
  const lapsed = describe(c.state, T0 + 61_000);
  assert.equal(lapsed.live, false);
  assert.equal(lapsed.holder, null, "a lapsed holder is not reported as the holder");
  assert.equal(lapsed.fencing, 1, "but the counter is still visible");
});

// ── grant history (the projection's source) ──────────────────────────────────
// The fold is what the Dolt projection derives from, so what is pinned here is
// interval INTEGRITY: every grant appears exactly once keyed by its fencing
// ordinal, closes exactly once with the right status, and a takeover closes the
// corpse at its FACTUAL expiry — not at whenever someone next showed up.

import { effectiveStatus, historyStep, normalizeDecidedAt } from "./lease-core.mjs";

/** Drive a decide* + historyStep pair the way the shell does — one event. */
function step(hist, type, state, req, now) {
  const decide = { claim: decideClaim, renew: decideRenew, release: decideRelease, bind: decideBind, reap: decideReap }[type];
  const { state: after, response } = decide(state, req, now);
  return { state: after, response, hist: historyStep(hist, { type, request: req, before: state, after, response }, now) };
}

test("a grant opens an interval; release closes it with the caller's status", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 60, decidedAtCommit: "v0110csl2jph0aeeij7rhhurrbjcft6g" }, T0));
  assert.equal(h.length, 1);
  assert.deepEqual(
    { ...h[0] },
    {
      fencing: 1, agent: "alice", decidedAtCommit: "v0110csl2jph0aeeij7rhhurrbjcft6g",
      grantedAt: T0, ttlSec: 60, expiresAt: T0 + 60_000, releasedAt: null,
      status: "active", reason: "free", referent: null,
    },
  );
  ({ state: s, hist: h } = step(h, "release", s, { agent: "alice", fencing: 1, status: "completed" }, T0 + 30_000));
  assert.equal(h.length, 1, "release UPDATES the interval, never appends");
  assert.equal(h[0].status, "completed");
  assert.equal(h[0].releasedAt, T0 + 30_000);
});

test("a takeover closes the corpse at its FACTUAL expiry, not at now", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "zombie", ttlSec: 1 }, T0));
  const lapse = T0 + 1_000;
  // Nobody touches the item for an hour; then a taker shows up.
  const later = T0 + 3_600_000;
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "taker", ttlSec: 60 }, later));
  assert.equal(h.length, 2);
  const [corpse, live] = h;
  assert.equal(corpse.status, "expired");
  assert.equal(corpse.releasedAt, lapse, "closed at expiry — the factual lapse time");
  assert.notEqual(corpse.releasedAt, later, "NOT at when the taker happened to arrive");
  assert.equal(live.agent, "taker");
  assert.equal(live.reason, "expired", "the grant records that it took over a corpse");
});

test("renew extends the open interval in place", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 60 }, T0));
  ({ state: s, hist: h } = step(h, "renew", s, { agent: "alice", fencing: 1, ttlSec: 120 }, T0 + 30_000));
  assert.equal(h.length, 1);
  assert.equal(h[0].expiresAt, T0 + 30_000 + 120_000);
  assert.equal(h[0].ttlSec, 120, "the renewed ttl is recorded, not the original");
  assert.equal(h[0].status, "active");
});

test("refusals record NOTHING — a denied claim is the caller's log line, not the item's", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 60 }, T0));
  const before = JSON.stringify(h);
  ({ hist: h } = step(h, "claim", s, { agent: "bob", ttlSec: 60 }, T0 + 1));         // held
  ({ hist: h } = step(h, "renew", s, { agent: "bob", fencing: 1, ttlSec: 60 }, T0 + 2)); // not-holder
  ({ hist: h } = step(h, "release", s, { agent: "alice", fencing: 99 }, T0 + 3));    // stale-fencing
  assert.equal(JSON.stringify(h), before, "no refused event may touch the record");
});

test("history over many cycles: one interval per fencing ordinal, all closed but the last", () => {
  let s = EMPTY_STATE, h = [], now = T0;
  for (let i = 0; i < 9; i++) {
    ({ state: s, hist: h } = step(h, "claim", s, { agent: `a${i}`, ttlSec: 60 }, now));
    if (i % 3 === 0) {
      ({ state: s, hist: h } = step(h, "release", s, { agent: `a${i}`, fencing: i + 1, status: "completed" }, now + 1_000));
      now += 2_000;
    } else {
      now += 61_000; // lapse
    }
  }
  assert.equal(h.length, 9);
  assert.deepEqual(h.map((r) => r.fencing), [1,2,3,4,5,6,7,8,9], "one interval per ordinal, in order");
  assert.equal(new Set(h.map((r) => r.fencing)).size, 9, "no ordinal appears twice");
  for (const r of h.slice(0, -1)) assert.notEqual(r.status, "active", "every superseded interval is closed");
});

test("bind lands the referent on the open interval; reap closes it as 'reaped'", () => {
  // The distinguishability the #105 checklist asks for: released/completed (the
  // holder said so), expired (the backstop fired), reaped (the GC observed the
  // referent close) are three different ends and history keeps them apart.
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 3600 }, T0));
  assert.equal(h[0].referent, null);
  ({ state: s, hist: h } = step(h, "bind", s, { agent: "alice", fencing: 1, ttlSec: 86_400, referent: PR }, T0 + 60_000));
  assert.equal(h.length, 1, "bind UPDATES the interval, never appends");
  assert.deepEqual(h[0].referent, PR);
  assert.equal(h[0].ttlSec, 86_400, "the backstop ttl is recorded, not the claim's");
  assert.equal(h[0].expiresAt, T0 + 60_000 + 86_400_000);
  assert.equal(h[0].status, "active");

  ({ state: s, hist: h } = step(h, "reap", s, { fencing: 1, referent: PR }, T0 + 500_000));
  assert.equal(h.length, 1);
  assert.equal(h[0].status, "reaped", "distinguishable from released, completed AND expired");
  assert.equal(h[0].releasedAt, T0 + 500_000);
  assert.deepEqual(h[0].referent, PR, "the closed interval keeps what it was pinned to");
});

test("a refused bind or reap records NOTHING", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 60 }, T0));
  const before = JSON.stringify(h);
  ({ hist: h } = step(h, "bind", s, { agent: "bob", fencing: 1, ttlSec: 60, referent: PR }, T0 + 1)); // not-holder
  ({ hist: h } = step(h, "reap", s, { fencing: 1, referent: PR }, T0 + 2)); // no-referent
  assert.equal(JSON.stringify(h), before, "no refused event may touch the record");
});

test("effectiveStatus reads expiry off the clock without a write", () => {
  let s = EMPTY_STATE, h = [];
  ({ state: s, hist: h } = step(h, "claim", s, { agent: "alice", ttlSec: 60 }, T0));
  assert.equal(effectiveStatus(h[0], T0 + 1_000), "active");
  assert.equal(effectiveStatus(h[0], T0 + 61_000), "expired", "lapsed-but-untouched reads as expired");
  assert.equal(h[0].status, "active", "…while the stored record is not mutated by observation");
});

test("normalizeDecidedAt degrades to null, never fabricates", () => {
  assert.equal(normalizeDecidedAt("v0110csl2jph0aeeij7rhhurrbjcft6g"), "v0110csl2jph0aeeij7rhhurrbjcft6g");
  for (const bad of [undefined, null, "", "DEADBEEF", "x".repeat(31), 42]) {
    assert.equal(normalizeDecidedAt(bad), null);
  }
});

test("release validates status — an unknown value is refused, not stored", () => {
  const held = claim(EMPTY_STATE, "alice", T0).state;
  assert.throws(
    () => decideRelease(held, { agent: "alice", fencing: 1, status: "done" }, T0 + 1),
    /status must be/,
  );
  const ok = decideRelease(held, { agent: "alice", fencing: 1, status: "completed" }, T0 + 1);
  assert.equal(ok.response.status, "completed", "and the accepted status is echoed for skew detection");
});
