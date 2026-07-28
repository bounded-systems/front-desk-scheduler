/**
 * Which plane adjudicates a claim, and what each one actually guarantees.
 *
 * The interesting assertions here are not "the switch works". They are that the
 * plane's SELF-DESCRIPTION is honest, because that description is what a reader
 * will trust instead of re-deriving the argument:
 *
 *   - only `lease` claims to be fenced, since only a DO supplies a total order;
 *   - `lease` claims NO Dolt audit row, because the projection writer does not
 *     exist and an absent record must not read as a lost one;
 *   - `local` says plainly that it does not exclude anything.
 *
 * A plane that overstated its guarantee would be the same defect as a test that
 * provisions its own premise: a true-looking statement that nothing checks.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  _resetPlaneWarning,
  LEASE_PLANE,
  LOCAL_PLANE,
  resolveClaimPlane,
  SERVER_PLANE,
  warnIfPlaneCannotExclude,
} from "../src/claim-plane.ts";
import { leaseEndpoint, LeaseClientError } from "../src/lease-client.ts";

/** Run `fn` with an exact env, restoring whatever was there. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = ["FDS_CLAIM_PLANE", "FDS_CLAIM_ENDPOINT", "DOLT_HOST"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("no configuration means the local plane, which excludes nothing", () => {
  withEnv({}, () => {
    const p = resolveClaimPlane();
    assert.equal(p.name, "local");
    assert.equal(p.fenced, false);
    assert.match(p.guarantee, /NO mutual exclusion/);
  });
});

test("DOLT_HOST alone selects the server plane", () => {
  withEnv({ DOLT_HOST: "10.0.0.1" }, () => {
    assert.equal(resolveClaimPlane().name, "server");
  });
});

test("the lease plane wins when both are configured", () => {
  // A deployment with a DO and a leftover DOLT_HOST must adjudicate on the
  // plane with the STRONGER guarantee, not on whichever check ran first.
  withEnv({ DOLT_HOST: "10.0.0.1", FDS_CLAIM_ENDPOINT: "https://lease.example.workers.dev" }, () => {
    assert.equal(resolveClaimPlane().name, "lease");
  });
});

test("FDS_CLAIM_PLANE forces a plane, so a test can exercise one deliberately", () => {
  withEnv({ FDS_CLAIM_PLANE: "local", FDS_CLAIM_ENDPOINT: "https://lease.example.workers.dev" }, () => {
    assert.equal(resolveClaimPlane().name, "local");
  });
  withEnv({ FDS_CLAIM_PLANE: "server" }, () => assert.equal(resolveClaimPlane().name, "server"));
});

test("only the lease plane claims to be fenced", () => {
  // Fencing needs a TOTAL ORDER. A Dolt commit hash is content-addressed — an
  // identity, never an ordering — and AUTO_INCREMENT only orders within one
  // server, which is precisely the assumption in question.
  assert.equal(LEASE_PLANE.fenced, true);
  assert.equal(SERVER_PLANE.fenced, false);
  assert.equal(LOCAL_PLANE.fenced, false);
});

test("the lease plane admits its audit row is asynchronous, not at claim time", () => {
  // The DO is ground truth; Dolt rows arrive via lease-projection, later.
  // `projected` keeps meaning "row exists when claimNext returns" — still
  // false here, so a reader checking Dolt right after a claim learns the row
  // may be absent-so-far rather than lost.
  assert.equal(LEASE_PLANE.projected, false);
  assert.match(LEASE_PLANE.guarantee, /NOT written at claim time/);
  assert.match(LEASE_PLANE.guarantee, /lease-projection/, "and names the mechanism that does write it");
  assert.equal(SERVER_PLANE.projected, true);
  assert.equal(LOCAL_PLANE.projected, true);
});

test("every plane states what it does NOT give you", () => {
  // A guarantee string that only lists strengths is marketing.
  assert.match(LEASE_PLANE.guarantee, /NO|not yet/i);
  assert.match(SERVER_PLANE.guarantee, /Unfenced|only while/i);
  assert.match(LOCAL_PLANE.guarantee, /NO mutual exclusion/i);
});

test("the unsafe plane warns, and the merely-conditional one does not", () => {
  // Warning about `server` too would train people to ignore the warning that
  // matters. `server` is conditionally correct and says so in its guarantee.
  const seen: string[] = [];
  const real = console.warn;
  console.warn = (m: string) => seen.push(String(m));
  try {
    _resetPlaneWarning();
    warnIfPlaneCannotExclude(LOCAL_PLANE);
    warnIfPlaneCannotExclude(LOCAL_PLANE); // once only
    warnIfPlaneCannotExclude(SERVER_PLANE);
    warnIfPlaneCannotExclude(LEASE_PLANE);
  } finally {
    console.warn = real;
  }
  assert.equal(seen.length, 1, "local warns exactly once; server and lease do not warn");
  assert.match(seen[0], /A2/, "and cites the assumption it violates");
});

// ── endpoint parsing ─────────────────────────────────────────────────────────

test("the endpoint accepts a URL or a bare host, and rejects nonsense loudly", () => {
  // The workflow input and the deployed Worker URL are written differently.
  // Silently building a malformed URL would surface much later as an opaque
  // fetch failure, which is the hardest kind of red to diagnose.
  withEnv({ FDS_CLAIM_ENDPOINT: "https://lease.example.workers.dev" }, () => {
    assert.equal(leaseEndpoint(), "https://lease.example.workers.dev");
  });
  withEnv({ FDS_CLAIM_ENDPOINT: "lease.example.workers.dev" }, () => {
    assert.equal(leaseEndpoint(), "https://lease.example.workers.dev");
  });
  withEnv({ FDS_CLAIM_ENDPOINT: "127.0.0.1:8787" }, () => {
    assert.equal(leaseEndpoint(), "https://127.0.0.1:8787");
  });
  withEnv({}, () => assert.equal(leaseEndpoint(), null));
  withEnv({ FDS_CLAIM_ENDPOINT: "   " }, () => assert.equal(leaseEndpoint(), null));
  withEnv({ FDS_CLAIM_ENDPOINT: "http://" }, () => {
    assert.throws(() => leaseEndpoint(), LeaseClientError);
  });
});
