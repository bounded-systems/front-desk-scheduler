/** The API budget model: capacity must come from the LIVE limit, not a constant. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apiCapacity, GITHUB_GRAPHQL_BUDGET, SHARED_TOKEN_RESERVE } from "../src/mirror.ts";
import { budgetGate } from "../src/policy.ts";

/** An App installation ceiling well above the 5,000 documented minimum. */
const APP_LIMIT = 12_500;

test("capacity tracks the live limit, not the hardcoded floor", () => {
  const r = apiCapacity({ limit: APP_LIMIT, remaining: APP_LIMIT, resetAt: "" });
  assert.equal(r.budget.capacityPoints, APP_LIMIT);
  assert.equal(r.consumedPoints, 0);
  assert.equal(r.remainingPoints, APP_LIMIT);
  assert.equal(r.status, "ok");
});

test("a remaining above the 5,000 floor is not reported as exhausted", () => {
  // The regression. Measured on the live board 2026-07-27: a full pull left
  // remaining=7036 — MORE than the old hardcoded capacity of 5000. Grading that
  // against the constant produced consumed=5464 > cap, i.e. burnRatio 1.09 and
  // status "over", so the syncer refused with "exhausted" while 7,036 real
  // points (five full pulls' worth) were sitting unused.
  const r = apiCapacity({ limit: APP_LIMIT, remaining: 7036, resetAt: "" });
  assert.equal(r.consumedPoints, APP_LIMIT - 7036);
  assert.equal(r.remainingPoints, 7036);
  assert.ok(r.burnRatio < 1, `burnRatio ${r.burnRatio} must be under 1`);
  assert.notEqual(r.status, "over");
  assert.ok(
    budgetGate(r, 1415).allow,
    "a 1,415-point sync must be allowed with 7,036 points remaining",
  );
});

test("the gate still fails closed when the budget is genuinely spent", () => {
  // 200 of 12,500 left: not yet "over" (that needs remaining at 0), but a
  // 1,415-point pull would overspend, so the gate must refuse anyway. Blocking
  // is driven by PROJECTED spend, not by the status label.
  const r = apiCapacity({ limit: APP_LIMIT, remaining: 200, resetAt: "" });
  assert.equal(r.remainingPoints, 200);
  assert.equal(r.status, "at-risk");
  assert.equal(budgetGate(r, 1415).allow, false);

  // Fully drained is "over" and blocks even a 1-point request.
  const drained = apiCapacity({ limit: APP_LIMIT, remaining: 0, resetAt: "" });
  assert.equal(drained.status, "over");
  assert.equal(budgetGate(drained, 1).allow, false);
});

test("a real pull is affordable on a bare-minimum 5,000 installation", () => {
  // The floor case must still work: consumed and capacity are on one scale, so a
  // fresh 5,000-point hour affords the ~1,415-point pull.
  const r = apiCapacity({ limit: 5000, remaining: 5000, resetAt: "" });
  assert.equal(r.budget.capacityPoints, 5000);
  assert.ok(budgetGate(r, 1415).allow);
});

test("a malformed rate_limit reading falls back to the documented floor", () => {
  for (const limit of [0, Number.NaN]) {
    const r = apiCapacity({ limit, remaining: 0, resetAt: "" });
    assert.equal(r.budget.capacityPoints, GITHUB_GRAPHQL_BUDGET.capacityPoints);
    // Unknown ceiling + nothing remaining ⇒ treated as spent, never as free.
    assert.equal(r.status, "over");
    assert.equal(budgetGate(r, 1).allow, false);
  }
});

test("consumption never goes negative when remaining exceeds the reported limit", () => {
  const r = apiCapacity({ limit: 5000, remaining: 12_500, resetAt: "" });
  assert.equal(r.consumedPoints, 0);
  assert.ok(r.burnRatio >= 0);
  assert.equal(r.status, "ok");
});

// --- the shared-token reserve (#60) ---

/** Measured cost of a full 1,521-item pull, post-#57 (api_spend, 2026-07-31). */
const MEASURED_PULL = 16;

test("a bucket with room for the pull but not the reserve refuses", () => {
  // 500 left: the 16-point pull fits five times over, so WITHOUT the reserve this
  // is allowed. The reserve is the whole difference — it refuses here so that
  // lease-projection / claim-race / broker-drift, which draw on this same App
  // token and are metered nowhere, still find points when they need them.
  const r = apiCapacity({ limit: APP_LIMIT, remaining: 500, resetAt: "" });

  assert.ok(
    budgetGate(r, MEASURED_PULL).allow,
    "precondition: without the reserve this bucket affords the pull",
  );
  assert.equal(budgetGate(r, MEASURED_PULL + SHARED_TOKEN_RESERVE).allow, false);
});

test("a healthy bucket is unaffected by the reserve", () => {
  // The real operating point: remaining ~8,430 on the App installation, a pull
  // costing 16. Holding 1,000 back has to cost the syncer nothing here, or the
  // reserve would trade a real refusal for a hypothetical one.
  const r = apiCapacity({ limit: APP_LIMIT, remaining: 8430, resetAt: "" });
  const gate = budgetGate(r, MEASURED_PULL + SHARED_TOKEN_RESERVE);

  assert.ok(gate.allow, `a healthy bucket must still sync (got: ${gate.reason})`);
  assert.equal(gate.reason, "healthy");
});

test("the reserve is charged to the gate, so a refusal reports the TRUE remaining", () => {
  // Charging the gate rather than shrinking capacity is what keeps the refusal
  // message honest: an operator reading "remaining 500" must see what GitHub said,
  // not 500 minus a reserve they would then have to decode back.
  const live = { limit: APP_LIMIT, remaining: 500, resetAt: "" };
  const r = apiCapacity(live);

  assert.equal(budgetGate(r, MEASURED_PULL + SHARED_TOKEN_RESERVE).allow, false);
  // Unchanged by the reserve — this is the report the gated result is built from.
  assert.equal(r.remainingPoints, live.remaining);
  assert.equal(r.budget.capacityPoints, live.limit);
  assert.equal(r.consumedPoints, live.limit - live.remaining);
});
