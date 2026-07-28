/**
 * @module claim-plane
 * WHERE a claim is adjudicated — named, once.
 *
 * This used to be `writesGoToServer()`, a boolean, consulted from several
 * places. A boolean was adequate while there were two planes and it is not
 * adequate now that there are three, and the failure mode of stretching it is
 * specific rather than aesthetic: a predicate answers "is it the server?" and
 * every caller has to infer the rest, so a plane added in one place and missed
 * in another gives you a write and a read-back on different planes. That is
 * exactly the bug that shipped once already — the claim RANKED off a local clone
 * while it LATCHED on a shared server.
 *
 * So the plane is resolved once, named, and reported.
 *
 *   lease   FDS_CLAIM_ENDPOINT is set. A Durable Object adjudicates: one
 *           instance per item, single-threaded. A2 by CONSTRUCTION, and the
 *           only plane that supplies a fencing token.
 *
 *   server  DOLT_HOST is set. A shared `dolt sql-server` adjudicates via the
 *           leases PRIMARY KEY. A2 by CONFIGURATION — correct while every
 *           claimant is pointed at the same server, and silently not otherwise.
 *
 *   local   Neither. `dolt sql` against a per-agent clone. Correct for ONE
 *           agent and wrong for several, because the PRIMARY KEY excludes
 *           within a database and there is one database per agent. It warns.
 *
 * Order matters: `lease` wins over `server` when both are set, because a
 * deployment that has a DO and a leftover DOLT_HOST should adjudicate on the
 * plane with the stronger guarantee rather than on whichever check ran first.
 */

import { leaseEndpoint } from "./lease-client.ts";

export type ClaimPlaneName = "lease" | "server" | "local";

export interface ClaimPlane {
  readonly name: ClaimPlaneName;
  /** True when this plane supplies a monotonic fencing token. Only `lease` does. */
  readonly fenced: boolean;
  /**
   * True when a claim on this plane leaves a `leases`/`claims` row behind
   * SYNCHRONOUSLY, at claim time.
   *
   * False on `lease` — and stays false now that the projection writer exists,
   * because that is not what the writer does: grants are recorded in the DO at
   * claim time and PROJECTED into Dolt later (lease-projection.yml),
   * idempotently. The flag keeps meaning "the row exists the moment claimNext
   * returns", so a reader checking Dolt immediately after a lease-plane claim
   * still learns the row may not be there YET — absent-so-far, not lost.
   */
  readonly projected: boolean;
  /** One line, for a human, about what this plane does and does not guarantee. */
  readonly guarantee: string;
}

export const LEASE_PLANE: ClaimPlane = {
  name: "lease",
  fenced: true,
  projected: false,
  guarantee:
    "A2 by construction (one Durable Object per item). Fenced. The Dolt audit row is " +
    "NOT written at claim time — grants are recorded in the DO and projected to claims " +
    "asynchronously (lease-projection), so Dolt lags the truth by up to one projection run.",
};

export const SERVER_PLANE: ClaimPlane = {
  name: "server",
  fenced: false,
  projected: true,
  guarantee:
    "A2 by configuration (one shared dolt sql-server). Unfenced — a Dolt commit hash is " +
    "an identity, not an ordering. Correct only while every claimant points at the same server.",
};

export const LOCAL_PLANE: ClaimPlane = {
  name: "local",
  fenced: false,
  projected: true,
  guarantee:
    "NO mutual exclusion across agents. The leases PRIMARY KEY excludes within one database " +
    "and this is a per-agent clone. Correct for a single agent only.",
};

/**
 * Resolve the plane. `FDS_CLAIM_PLANE` forces one — useful for a test that must
 * exercise a specific plane rather than whatever the environment happens to
 * offer, which is the same reason `FDS_READS` exists.
 */
export function resolveClaimPlane(): ClaimPlane {
  switch (process.env.FDS_CLAIM_PLANE) {
    case "lease": return LEASE_PLANE;
    case "server": return SERVER_PLANE;
    case "local": return LOCAL_PLANE;
  }
  if (leaseEndpoint() !== null) return LEASE_PLANE;
  if (process.env.DOLT_HOST) return SERVER_PLANE;
  return LOCAL_PLANE;
}

/**
 * Warn once when the resolved plane cannot exclude concurrent agents.
 *
 * Only `local` is unsafe in that sense. `server` is conditionally safe and says
 * so in its guarantee; warning about it too would train people to ignore the
 * warning that matters.
 */
let warned = false;
export function warnIfPlaneCannotExclude(plane: ClaimPlane = resolveClaimPlane()): void {
  if (warned || plane.name !== "local") return;
  warned = true;
  console.warn(
    "warning: claims are being adjudicated on the LOCAL plane.\n" +
      `  ${plane.guarantee}\n` +
      "  Two agents on two machines will each latch their own clone and both believe they\n" +
      "  hold the item (assumption A2 in specs/lean/Leases.lean). Set FDS_CLAIM_ENDPOINT to a\n" +
      "  deployed worker/lease, or DOLT_HOST to a shared dolt sql-server, before running several.",
  );
}

/** Test seam: reset the once-only warning. */
export function _resetPlaneWarning(): void {
  warned = false;
}
