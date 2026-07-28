/**
 * The wire contract between src/lease-client.ts and worker/lease.
 *
 * These are the two halves of one protocol living in different files, written
 * at different times, and nothing else checks that they agree. A mismatch —
 * `expires_at` where the other says `expiresAt`, a `fencing` the client reads
 * from the wrong key — compiles cleanly, passes every unit test on both sides,
 * and fails only against a deployed Worker. That is the most expensive place to
 * find it.
 *
 * So the client is driven against the REAL LeaseObject, with `fetch` routed
 * into it. No network, no runtime, but both halves of the actual code.
 *
 * Still not established here: A1′. The stub calls the object directly, so it is
 * single-threaded by construction — the same harness-supplied premise that made
 * `claim-race` green about a topology it never touched. `production-a2` is what
 * binds it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LeaseObject } from "../worker/lease/src/index.mjs";
import { claimLease, releaseLeaseRemote, renewLeaseRemote } from "../src/lease-client.ts";

/** Route every fetch to a fresh in-process LeaseObject, keyed by item_id. */
function withWorker(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const objects = new Map<string, LeaseObject>();
    const store = new Map<string, Map<string, unknown>>();
    const realFetch = globalThis.fetch;
    const savedEndpoint = process.env.FDS_CLAIM_ENDPOINT;
    process.env.FDS_CLAIM_ENDPOINT = "https://lease.test";

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input as never, init);
      const key = new URL(req.url).searchParams.get("item_id") ?? "";
      if (!objects.has(key)) {
        const map = new Map<string, unknown>();
        store.set(key, map);
        objects.set(
          key,
          new LeaseObject({
            storage: {
              get: async (k: string) => map.get(k),
              put: async (k: string, v: unknown) => void map.set(k, v),
            },
          }),
        );
      }
      return objects.get(key)!.fetch(req);
    }) as typeof fetch;

    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
      if (savedEndpoint === undefined) delete process.env.FDS_CLAIM_ENDPOINT;
      else process.env.FDS_CLAIM_ENDPOINT = savedEndpoint;
    }
  };
}

test("a grant round-trips: every field the client reads is one the worker sends", withWorker(async () => {
  const r = await claimLease("prx#12", "alice", 60);
  assert.equal(r.granted, true);
  if (!r.granted) return;
  assert.equal(r.itemId, "prx#12");
  assert.equal(r.agent, "alice");
  // The two that would silently break on a key mismatch.
  assert.equal(r.fencing, 1, "fencing must survive the wire");
  assert.ok(r.expiresAt > Date.now(), "expiresAt must be a real future timestamp, not 0");
}));

test("a refusal round-trips, and names the holder", withWorker(async () => {
  await claimLease("prx#12", "alice", 60);
  const r = await claimLease("prx#12", "bob", 60);
  assert.equal(r.granted, false);
  if (r.granted) return;
  assert.equal(r.holder, "alice", "the loser learns who holds it");
  assert.equal(r.reason, "held");
}));

test("renew and release round-trip with the token", withWorker(async () => {
  const g = await claimLease("prx#12", "alice", 60);
  assert.ok(g.granted);
  if (!g.granted) return;

  assert.equal(await renewLeaseRemote("prx#12", "alice", g.fencing, 60), true);
  assert.equal(await renewLeaseRemote("prx#12", "alice", g.fencing + 1, 60), false, "stale token refused");
  assert.equal(await releaseLeaseRemote("prx#12", "alice", g.fencing + 1), false, "stale release refused");
  assert.equal(await releaseLeaseRemote("prx#12", "alice", g.fencing), true);
}));

test("different items are different instances — the routing key does its job", withWorker(async () => {
  // A2′: one DO per item. If both items shared an instance, the second claim
  // would be refused, and exclusion would be far too strong rather than absent.
  const a = await claimLease("prx#12", "alice", 60);
  const b = await claimLease("prx#13", "bob", 60);
  assert.equal(a.granted, true);
  assert.equal(b.granted, true, "a lease on one item must not exclude another");
}));

test("an unreachable endpoint is an ERROR, never a refusal", withWorker(async () => {
  // The distinction is load-bearing. If a transport failure returned
  // `granted: false`, an unreachable serializer would read as a contended item
  // and every agent would quietly conclude someone else holds the work.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("connect ECONNREFUSED"); }) as typeof fetch;
  try {
    await assert.rejects(() => claimLease("prx#12", "alice", 60), /unreachable/);
  } finally {
    globalThis.fetch = real;
  }
}));

test("a caller error from the worker surfaces as an error, not a refusal", withWorker(async () => {
  // ttl_sec = 0 is a 400 from the worker. Reporting that as "not granted" would
  // turn a bug in the caller into an invisible failure to claim anything.
  await assert.rejects(() => claimLease("prx#12", "alice", 0), /ttl_sec/);
}));
