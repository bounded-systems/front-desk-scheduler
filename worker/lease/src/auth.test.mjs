/**
 * Authentication for the lease worker.
 *
 * The one test that matters most here is the PUBLIC-REPO TRAP: this repo is
 * public, so `GET /repos/{o}/{r}` answers 200 to a valid token with NO access
 * — an auth check built on reachability authenticates everyone on GitHub. The
 * suite pins that a stranger's perfectly valid token is REFUSED, which is the
 * difference between an auth layer and a doorman who waves at people.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { authenticate, namespaceAgent } from "./auth.mjs";

/** A scripted GitHub: map of URL-prefix → response. */
function github(routes) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization });
    for (const [prefix, r] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
      }
    }
    return new Response("{}", { status: 404 });
  };
  return { fetchFn, calls };
}

const USER = "https://api.github.com/user";
const REPO = "https://api.github.com/repos/bounded-systems/front-desk-scheduler";
const INST = "https://api.github.com/installation/repositories";

test("a collaborator's user token authenticates as their login", async () => {
  const { fetchFn } = github({
    [USER]: { body: { login: "bdelanghe" } },
    [REPO]: { body: { permissions: { push: true } } },
  });
  const v = await authenticate("ghp_collab", { fetchFn });
  assert.deepEqual(v, { ok: true, identity: "bdelanghe" });
});

test("THE PUBLIC-REPO TRAP: a stranger's valid token is refused", async () => {
  // Both calls succeed — the token is real, the repo is public. The ONLY thing
  // standing between this token and a lease is the permissions field.
  const { fetchFn } = github({
    [USER]: { body: { login: "stranger" } },
    [REPO]: { body: { permissions: { push: false, pull: true } } },
  });
  const v = await authenticate("ghp_stranger", { fetchFn });
  assert.equal(v.ok, false);
  assert.match(v.reason, /no push permission/);
});

test("a repo response with NO permissions field is refused, not defaulted", async () => {
  // Absence of evidence is refusal — defaulting to allow on a missing field is
  // how the trap gets rebuilt one refactor later.
  const { fetchFn } = github({
    [USER]: { body: { login: "someone" } },
    [REPO]: { body: {} },
  });
  assert.equal((await authenticate("ghp_x", { fetchFn })).ok, false);
});

test("an installation token authenticates iff its installation covers the repo", async () => {
  const covered = github({
    [USER]: { status: 403 },
    [INST]: { body: { repositories: [{ full_name: "bounded-systems/front-desk-scheduler" }] } },
  });
  assert.deepEqual(await authenticate("ghs_inst", { fetchFn: covered.fetchFn }), { ok: true, identity: "gha" });

  const uncovered = github({
    [USER]: { status: 403 },
    [INST]: { body: { repositories: [{ full_name: "bounded-systems/other" }] } },
  });
  const v = await authenticate("ghs_other", { fetchFn: uncovered.fetchFn });
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not cover/);
});

test("garbage tokens are refused without a network call", async () => {
  const { fetchFn, calls } = github({});
  for (const bad of [undefined, null, "", "x"]) {
    assert.equal((await authenticate(bad, { fetchFn })).ok, false);
  }
  assert.equal(calls.length, 0, "no request may carry a garbage credential");
});

test("positive results cache by token HASH — one validation, many claims", async () => {
  const { fetchFn, calls } = github({
    [USER]: { body: { login: "bdelanghe" } },
    [REPO]: { body: { permissions: { push: true } } },
  });
  const cache = new Map();
  await authenticate("ghp_collab", { fetchFn, cache, now: 1000 });
  await authenticate("ghp_collab", { fetchFn, cache, now: 2000 });
  assert.equal(calls.length, 2, "second call served from cache (2 = user+repo of the first)");
  for (const key of cache.keys()) {
    assert.ok(!key.includes("ghp_collab"), "the raw token must never be a cache key");
    assert.match(key, /^[0-9a-f]{64}$/, "keys are SHA-256 hex");
  }
  // Expiry re-validates.
  await authenticate("ghp_collab", { fetchFn, cache, now: 1000 + 6 * 60 * 1000 });
  assert.equal(calls.length, 4, "an expired entry does not authenticate anyone");
});

test("rejections are NOT cached — a fixed grant works on the next call", async () => {
  const routes = {
    [USER]: { body: { login: "late" } },
    [REPO]: { body: { permissions: { push: false } } },
  };
  const g = github(routes);
  const cache = new Map();
  assert.equal((await authenticate("ghp_late", { fetchFn: g.fetchFn, cache })).ok, false);
  routes[REPO].body = { permissions: { push: true } };
  assert.equal((await authenticate("ghp_late", { fetchFn: g.fetchFn, cache })).ok, true);
});

// ── the attribution rule ─────────────────────────────────────────────────────

test("aliases survive only namespaced under the verified identity", () => {
  assert.equal(namespaceAgent("bdelanghe", "r1-3"), "bdelanghe/r1-3");
  assert.equal(namespaceAgent("gha", "race-7"), "gha/race-7");
  assert.equal(namespaceAgent("bdelanghe", undefined), "bdelanghe", "no alias → the identity itself");
  assert.equal(namespaceAgent("bdelanghe", ""), "bdelanghe");
});

test("an alias with '/' is refused — nesting would blur what was verified", () => {
  assert.throws(() => namespaceAgent("gha", "impersonated/alice"), /without '\/'/);
});
