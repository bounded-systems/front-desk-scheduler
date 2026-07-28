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
    holder: "alice", fencing: 1, expiresAt: T0 + 60_000, live: true,
  });
  const lapsed = describe(c.state, T0 + 61_000);
  assert.equal(lapsed.live, false);
  assert.equal(lapsed.holder, null, "a lapsed holder is not reported as the holder");
  assert.equal(lapsed.fencing, 1, "but the counter is still visible");
});
