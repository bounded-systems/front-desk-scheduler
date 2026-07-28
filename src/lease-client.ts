/**
 * @module lease-client
 * The client for worker/lease — the Durable Object that holds the queue.
 *
 * This is the third claim plane. The other two write leases into Dolt: a shared
 * `dolt sql-server` (A2 by configuration) or a per-agent local clone (A2 not at
 * all). This one asks a DO, which is A2 by construction — one instance per
 * item, single-threaded, no configuration under which two claims for one item
 * run concurrently.
 *
 * WHAT MOVES, AND WHAT THAT COSTS
 * -------------------------------
 * On this plane the DO is GROUND TRUTH for exclusion and Dolt becomes a derived
 * projection (docs/queue-vs-log.md). The projection writer does not exist yet,
 * so a claim taken through this plane leaves NO `leases`/`claims` row behind.
 * That is a real gap, stated rather than papered over: exclusion is enforced,
 * and the audit trail for it is missing until the projection lands. Callers get
 * `projected: false` so nothing downstream can mistake silence for a record.
 *
 * The named weakening in docs/queue-vs-log.md has two halves — idempotent AND
 * replayable — and neither is implemented here. Claiming "a failed write is a
 * catch-up, not a divergence" before that code exists would be exactly the kind
 * of unearned guarantee this project keeps finding.
 *
 * FENCING
 * -------
 * Every grant carries a strictly increasing token. It is the total order the
 * effect side needs and the thing the Dolt planes cannot supply: a commit hash
 * is content-addressed — an identity, never an ordering — and `AUTO_INCREMENT`
 * only totally orders within one server, which is the assumption in question.
 */

/** A granted lease. `fencing` is the token the holder must present to act. */
export interface LeaseGrant {
  readonly granted: true;
  readonly itemId: string;
  readonly agent: string;
  readonly fencing: number;
  readonly expiresAt: number;
}

export interface LeaseRefusal {
  readonly granted: false;
  readonly itemId: string;
  /** Who holds it, when the DO was willing to say. */
  readonly holder: string | null;
  readonly reason: string;
}

export type LeaseAttempt = LeaseGrant | LeaseRefusal;

export class LeaseClientError extends Error {}

/** Configured endpoint, or null when this plane is not in use. */
export function leaseEndpoint(): string | null {
  const raw = process.env.FDS_CLAIM_ENDPOINT?.trim();
  if (!raw) return null;
  // Accept a bare host[:port] as well as a URL — the workflow input and the
  // deployed Worker URL are written differently, and silently producing a
  // malformed URL would surface much later as an opaque fetch failure.
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    throw new LeaseClientError(`FDS_CLAIM_ENDPOINT is not a usable URL: ${JSON.stringify(raw)}`);
  }
}

async function call(
  path: string,
  itemId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = leaseEndpoint();
  if (base === null) throw new LeaseClientError("FDS_CLAIM_ENDPOINT is unset — the lease plane is not configured");
  const url = `${base}${path}?item_id=${encodeURIComponent(itemId)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // A transport failure is NOT a refusal. Returning "not granted" here would
    // let an unreachable serializer read as a contended item, which is the
    // difference between "someone else holds it" and "we have no idea".
    throw new LeaseClientError(`lease endpoint unreachable at ${base}: ${String((e as Error).message ?? e)}`);
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LeaseClientError(`lease endpoint returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string })?.error ?? text.slice(0, 200);
    throw new LeaseClientError(`lease endpoint ${res.status}: ${msg}`);
  }
  return parsed as Record<string, unknown>;
}

/** Try to take `itemId`. A refusal is an answer; an unreachable DO is an error. */
export async function claimLease(itemId: string, agent: string, ttlSec: number): Promise<LeaseAttempt> {
  const r = await call("/claim", itemId, { agent, ttl_sec: ttlSec });
  if (r.granted === true) {
    const fencing = r.fencing;
    // A grant without a usable token is not usable: the effect side has nothing
    // to present. Refuse it rather than return a lease nobody can fence with.
    if (typeof fencing !== "number" || !Number.isInteger(fencing) || fencing <= 0) {
      throw new LeaseClientError(`lease granted without a valid fencing token: ${JSON.stringify(r.fencing)}`);
    }
    return {
      granted: true,
      itemId,
      agent,
      fencing,
      expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : 0,
    };
  }
  return {
    granted: false,
    itemId,
    holder: typeof r.holder === "string" ? r.holder : null,
    reason: typeof r.reason === "string" ? r.reason : "refused",
  };
}

/** Heartbeat. `false` is the signal to STOP — the lease is no longer ours. */
export async function renewLeaseRemote(
  itemId: string,
  agent: string,
  fencing: number,
  ttlSec: number,
): Promise<boolean> {
  const r = await call("/renew", itemId, { agent, fencing, ttl_sec: ttlSec });
  return r.renewed === true;
}

/**
 * Release. `false` means the release did not apply — almost always because the
 * token is stale, i.e. the lease already lapsed and someone else holds it. That
 * refusal is load-bearing: without it a zombie's release would free the NEW
 * holder's lease.
 */
export async function releaseLeaseRemote(itemId: string, agent: string, fencing: number): Promise<boolean> {
  const r = await call("/release", itemId, { agent, fencing });
  return r.released === true;
}
