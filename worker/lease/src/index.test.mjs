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

test("the bind/reap round trip works through the shell (#105)", async () => {
  const obj = new LeaseObject(fakeCtx());
  const c = await call(obj, post("/claim", { agent: "alice", ttl_sec: 3600 }));
  const f = c.body.fencing;
  const referent = { kind: "pr", id: "bounded-systems/front-desk-scheduler#103" };

  const bound = await call(obj, post("/bind", { agent: "alice", fencing: f, ttl_sec: 86400, referent }));
  assert.equal(bound.body.bound, true);
  assert.deepEqual(bound.body.referent, referent);

  const status = await call(obj, new Request("https://lease.invalid/status?item_id=prx%2312"));
  assert.deepEqual(status.body.referent, referent, "the reaper reads the referent from /status");

  const wrongRef = await call(obj, post("/reap", { fencing: f, referent: { kind: "pr", id: "other/repo#1" } }));
  assert.equal(wrongRef.body.reaped, false);
  assert.equal(wrongRef.body.reason, "referent-mismatch");

  const reaped = await call(obj, post("/reap", { fencing: f, referent }));
  assert.equal(reaped.body.reaped, true);

  const hist = await call(obj, new Request("https://lease.invalid/history?item_id=prx%2312"));
  assert.equal(hist.body.records[0].status, "reaped", "history distinguishes a reap from an expiry");

  const junk = await call(obj, post("/bind", { agent: "alice", fencing: f, ttl_sec: 60, referent: "not-an-object" }));
  assert.equal(junk.status, 400);
  assert.match(junk.body.error, /referent/);
});

// ── the router: auth gates writes, reads stay open ───────────────────────────

import worker from "./index.mjs";

/** env stub: one LeaseObject per DO name + scripted GitHub for auth. */
function makeEnv(mode) {
  const objects = new Map();
  const env = {
    AUTH_MODE: mode,
    LEASE: {
      idFromName: (n) => n,
      get: (id) => {
        if (!objects.has(id)) objects.set(id, new LeaseObject(fakeCtx()));
        return objects.get(id);
      },
    },
  };
  return env;
}

function scriptGitHub(routes) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url, init) => {
    const u = String(url);
    for (const [prefix, r] of Object.entries(routes)) {
      if (u.startsWith(prefix)) return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }
    return new Response("{}", { status: 404 });
  });
  return () => { globalThis.fetch = real; };
}

const routerPost = (path, body, headers = {}) =>
  new Request(`https://lease.example${path}?item_id=prx%2312`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test("github mode: a write without a token is 401, and reads stay open", async () => {
  const env = makeEnv(undefined); // unset AUTH_MODE = github — the fail-closed default
  const denied = await worker.fetch(routerPost("/claim", { agent: "a", ttl_sec: 60 }), env);
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /Authorization: Bearer/);

  const status = await worker.fetch(new Request("https://lease.example/status?item_id=prx%2312"), env);
  assert.equal(status.status, 200, "reads carry no gate — their content is public via the mirror anyway");
});

test("github mode: a verified writer claims, and the agent lands NAMESPACED", async () => {
  const restore = scriptGitHub({
    "https://api.github.com/user": { body: { login: "bdelanghe" } },
    "https://api.github.com/repos/": { body: { permissions: { push: true } } },
  });
  try {
    const env = makeEnv("github");
    const res = await worker.fetch(
      routerPost("/claim", { agent: "r1-3", ttl_sec: 60 }, { authorization: "Bearer ghp_ok" }),
      env,
    );
    assert.equal(res.status, 200);
    const grant = await res.json();
    assert.equal(grant.granted, true);
    assert.equal(grant.holder, "bdelanghe/r1-3",
      "the self-asserted alias survives only under the verified identity");

    // The bound name is what the whole lifecycle speaks: renew with the same
    // alias works, and history attributes to the namespaced identity.
    const renew = await worker.fetch(
      routerPost("/renew", { agent: "r1-3", fencing: grant.fencing, ttl_sec: 60 }, { authorization: "Bearer ghp_ok" }),
      env,
    );
    assert.equal((await renew.json()).renewed, true);

    const hist = await worker.fetch(new Request("https://lease.example/history?item_id=prx%2312"), env);
    const { records } = await hist.json();
    assert.equal(records[0].agent, "bdelanghe/r1-3");
  } finally {
    restore();
  }
});

test("github mode: a stranger's valid token is 403 with the reason", async () => {
  const restore = scriptGitHub({
    "https://api.github.com/user": { body: { login: "stranger" } },
    "https://api.github.com/repos/": { body: { permissions: { push: false } } },
  });
  try {
    const res = await worker.fetch(
      routerPost("/claim", { agent: "x", ttl_sec: 60 }, { authorization: "Bearer ghp_no" }),
      makeEnv("github"),
    );
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no push permission/);
  } finally {
    restore();
  }
});

test("mode none passes writes through unchanged — an explicit, reviewable choice", async () => {
  const env = makeEnv("none");
  const res = await worker.fetch(routerPost("/claim", { agent: "raw-name", ttl_sec: 60 }), env);
  const grant = await res.json();
  assert.equal(grant.granted, true);
  assert.equal(grant.holder, "raw-name", "no namespacing without an identity to namespace under");
});

test("an alias with '/' is rejected at the door in github mode", async () => {
  const restore = scriptGitHub({
    "https://api.github.com/user": { body: { login: "gha" } },
    "https://api.github.com/repos/": { body: { permissions: { push: true } } },
  });
  try {
    const res = await worker.fetch(
      routerPost("/claim", { agent: "fake/alice", ttl_sec: 60 }, { authorization: "Bearer ghs_x" }),
      makeEnv("github"),
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /without '\/'/);
  } finally {
    restore();
  }
});
