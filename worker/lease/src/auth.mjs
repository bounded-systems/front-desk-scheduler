/**
 * Authentication for worker/lease — callers prove a GitHub identity.
 *
 * WHY GITHUB TOKENS, AND NOT THE BROKER'S OIDC PINS
 * -------------------------------------------------
 * The broker authenticates WORKFLOWS (job_workflow_ref@refs/heads/main); a
 * claimant is usually an interactive agent session, a caller shape the broker
 * deliberately cannot vouch for. Widening its trust boundary was rejected in
 * worker/lease's README from day one. What every caller class ALREADY holds is
 * a GitHub credential — sessions carry GH_TOKEN, workflows carry github.token
 * or a broker-minted App token — so the worker validates that, against GitHub,
 * and no new secret exists anywhere. The house rule survives: nothing stored,
 * nothing minted, nothing to rotate.
 *
 * THE TRAP THIS FILE EXISTS TO NOT FALL INTO
 * ------------------------------------------
 * front-desk-scheduler is a PUBLIC repository. `GET /repos/{o}/{r}` returns
 * 200 for a token with NO access at all — a reachability check would be an
 * auth check that authenticates everyone. The actual discriminators:
 *
 *   user token          GET /user → login, then GET /repos/{o}/{r} and require
 *                       `permissions.push` (the field reflects the
 *                       authenticated user's real permission, false for a
 *                       stranger's valid token on a public repo)
 *   installation token  GET /user fails (403) — instead GET
 *                       /installation/repositories and require the repo in the
 *                       list. Installation tokens are scoped to repos at mint
 *                       time, so coverage IS the grant.
 *
 * WHAT A VALIDATED IDENTITY BUYS BEYOND THE GATE
 * ----------------------------------------------
 * The `agent` field was the last self-asserted string in the system (the same
 * defect `commit_attestations` fixed for Dolt commits). The router namespaces
 * every self-asserted alias UNDER the verified identity — `bdelanghe/r1-3`,
 * `gha/race-7` — so history, projection, and effort calibration attribute work
 * to someone who proved who they were, while race tests keep their synthetic
 * multi-agent names.
 *
 * A1′ NOTE: everything here awaits network. It therefore runs in the ROUTER,
 * before the Durable Object is reached; the DO's critical section still awaits
 * storage and nothing else.
 */

const GITHUB = "https://api.github.com";
// GitHub rejects requests without a User-Agent.
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "front-desk-lease" };

/** Positive results only; a rejected token re-validates on retry. TTL bounds
 *  how long a revoked credential keeps working — the standard trade. */
const CACHE_TTL_MS = 5 * 60 * 1000;

async function tokenKey(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate `token` and return `{ ok: true, identity }` or `{ ok: false, reason }`.
 *
 * `deps` is injectable for tests: `{ fetchFn, repo, cache, now }`. The cache is
 * keyed by a hash of the token — the token itself must not sit in a Map key
 * where a heap dump or a careless log of the cache would disclose it.
 */
export async function authenticate(token, deps = {}) {
  const {
    fetchFn = fetch,
    repo = "bounded-systems/front-desk-scheduler",
    cache = null,
    now = Date.now(),
  } = deps;

  if (typeof token !== "string" || token.length < 4) {
    return { ok: false, reason: "missing or malformed token" };
  }

  const key = cache ? await tokenKey(token) : null;
  if (cache && key) {
    const hit = cache.get(key);
    if (hit && hit.exp > now) return { ok: true, identity: hit.identity };
  }

  const auth = { ...HEADERS, authorization: `Bearer ${token}` };

  // Branch 1: a user token identifies its user.
  const userRes = await fetchFn(`${GITHUB}/user`, { headers: auth });
  if (userRes.ok) {
    const login = (await userRes.json())?.login;
    if (typeof login !== "string" || login === "") {
      return { ok: false, reason: "GitHub returned no login for this token" };
    }
    // The public-repo trap: 200 here means nothing; `permissions.push` is the check.
    const repoRes = await fetchFn(`${GITHUB}/repos/${repo}`, { headers: auth });
    if (!repoRes.ok) return { ok: false, reason: `cannot read ${repo} (${repoRes.status})` };
    const perms = (await repoRes.json())?.permissions;
    if (perms?.push !== true && perms?.maintain !== true && perms?.admin !== true) {
      return { ok: false, reason: `${login} has no push permission on ${repo}` };
    }
    if (cache && key) cache.set(key, { identity: login, exp: now + CACHE_TTL_MS });
    return { ok: true, identity: login };
  }

  // Branch 2: installation tokens (Actions github.token, broker-minted App
  // tokens) cannot answer /user. Their scoping happened at mint time, so
  // covering the repo IS the grant. They carry no login; `gha` is honest about
  // that, and the namespaced alias carries the per-caller detail.
  const instRes = await fetchFn(`${GITHUB}/installation/repositories?per_page=100`, { headers: auth });
  if (instRes.ok) {
    const repos = (await instRes.json())?.repositories ?? [];
    const covered = repos.some((r) => r?.full_name?.toLowerCase() === repo.toLowerCase());
    if (!covered) return { ok: false, reason: `installation token does not cover ${repo}` };
    if (cache && key) cache.set(key, { identity: "gha", exp: now + CACHE_TTL_MS });
    return { ok: true, identity: "gha" };
  }

  return { ok: false, reason: `token is neither a valid user token (${userRes.status}) nor an installation token (${instRes.status})` };
}

/**
 * The attribution rule: a self-asserted alias survives only UNDER the verified
 * identity. `alias` may legitimately be absent (the identity claims as itself).
 * An alias containing "/" is refused rather than nested — `a/b/c` would make
 * "which part was verified" ambiguous, and ambiguity in the attribution field
 * is the thing this whole design removes.
 */
export function namespaceAgent(identity, alias) {
  if (alias === undefined || alias === null || alias === "") return identity;
  if (typeof alias !== "string" || alias.includes("/")) {
    throw new TypeError("agent alias must be a string without '/'");
  }
  return `${identity}/${alias}`;
}
