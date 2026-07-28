/**
 * The DO shell.
 *
 * lease-core.test.mjs covers the decision. This covers the thin layer around
 * it: request routing, and — the part with a security consequence — what an
 * error is allowed to tell the caller.
 *
 * The shell is exercised directly with a fake storage, so these are real
 * assertions about the code that will run, not a description of it. What they
 * still do NOT establish is A1′: that the runtime applies one transition at a
 * time. A fake storage is single-threaded by construction, which is precisely
 * the kind of harness-supplied premise this repo has been burned by, so it is
 * stated rather than quietly relied upon.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LeaseObject } from "./index.mjs";

/** Minimal stand-in for DurableObjectStorage. */
function fakeCtx(initial = new Map()) {
  const map = new Map(initial);
  return {
    storage: {
      get: async (k) => map.get(k),
      put: async (k, v) => void map.set(k, v),
    },
    _map: map,
  };
}

const post = (path, body) =>
  new Request(`https://lease.invalid${path}?item_id=prx%2312`, {
    method: "POST",
    body: JSON.stringify(body),
  });

async function call(obj, req) {
  const res = await obj.fetch(req);
  return { status: res.status, body: await res.json() };
}

test("claim grants, and a second claimant is refused", async () => {
  const obj = new LeaseObject(fakeCtx());
  const first = await call(obj, post("/claim", { agent: "alice", ttl_sec: 60 }));
  assert.equal(first.status, 200);
  assert.equal(first.body.granted, true);
  assert.equal(first.body.fencing, 1);

  const second = await call(obj, post("/claim", { agent: "bob", ttl_sec: 60 }));
  assert.equal(second.body.granted, false);
  assert.equal(second.body.holder, "alice");
});

test("state persists across requests through storage", async () => {
  // The shell must actually write; a transition that decided correctly and
  // stored nothing would pass every pure test and exclude nobody.
  const ctx = fakeCtx();
  const obj = new LeaseObject(ctx);
  await call(obj, post("/claim", { agent: "alice", ttl_sec: 60 }));
  assert.equal(ctx._map.get("lease").holder, "alice", "the grant reached storage");

  const status = await call(obj, new Request("https://lease.invalid/status?item_id=prx%2312"));
  assert.equal(status.body.holder, "alice");
  assert.equal(status.body.live, true);
});

test("a caller error answers with the reason, at 400", async () => {
  // These messages are authored in lease-core.mjs FOR the caller — telling them
  // "ttl_sec must be a positive number" is the whole point.
  const obj = new LeaseObject(fakeCtx());
  const r = await call(obj, post("/claim", { agent: "alice", ttl_sec: 0 }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /ttl_sec/);

  const noAgent = await call(obj, post("/claim", { agent: "", ttl_sec: 60 }));
  assert.equal(noAgent.status, 400);
  assert.match(noAgent.body.error, /agent/);
});

test("an INTERNAL error tells the caller nothing about our internals", async () => {
  // CodeQL flagged the original, correctly: it echoed every error's message,
  // including ours. A caller cannot act on our stack trace, and handing it over
  // is a disclosure. The reply must not vary with the shape of the failure.
  const leak = "SECRET-INTERNAL-DETAIL-/var/secrets/token";
  const ctx = {
    storage: {
      get: async () => { throw new Error(leak); },
      put: async () => {},
    },
  };
  const errs = [];
  const realError = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const r = await call(new LeaseObject(ctx), post("/claim", { agent: "alice", ttl_sec: 60 }));
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "internal error");
    assert.ok(!JSON.stringify(r.body).includes(leak), "must not leak the message");
    assert.ok(!JSON.stringify(r.body).includes("SECRET"), "nor any part of it");
  } finally {
    console.error = realError;
  }
  // Not silently swallowed either — an operator still gets it.
  assert.equal(errs.length, 1, "the real error must be logged");
  assert.ok(String(errs[0][1]).includes(leak) || String(errs[0]).includes(leak));
});

test("a malformed body is a 400, not a crash", async () => {
  const obj = new LeaseObject(fakeCtx());
  const req = new Request("https://lease.invalid/claim?item_id=prx%2312", {
    method: "POST",
    body: "{not json",
  });
  const res = await obj.fetch(req);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /JSON/);
});

test("an unknown path is 404", async () => {
  const obj = new LeaseObject(fakeCtx());
  const res = await obj.fetch(new Request("https://lease.invalid/nope?item_id=prx%2312"));
  assert.equal(res.status, 404);
});

test("the renew/release round trip works through the shell", async () => {
  const obj = new LeaseObject(fakeCtx());
  const c = await call(obj, post("/claim", { agent: "alice", ttl_sec: 60 }));
  const f = c.body.fencing;

  const renewed = await call(obj, post("/renew", { agent: "alice", fencing: f, ttl_sec: 60 }));
  assert.equal(renewed.body.renewed, true);

  const stale = await call(obj, post("/release", { agent: "alice", fencing: f - 1 }));
  assert.equal(stale.body.released, false, "a stale token must not release");
  assert.equal(stale.body.reason, "stale-fencing");

  const released = await call(obj, post("/release", { agent: "alice", fencing: f }));
  assert.equal(released.body.released, true);

  const after = await call(obj, new Request("https://lease.invalid/status?item_id=prx%2312"));
  assert.equal(after.body.live, false);
  assert.equal(after.body.fencing, f, "the counter survives release");
});
