/**
 * @module attest
 * OIDC attestation of Dolt commits — recording WHICH identity produced a commit.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dolt commit --author` is SELF-ASSERTED. The author string is whatever the
 * writer typed; nothing binds it to anything. So the audit trail that justified
 * putting the queue in Dolt at all — "who decided this, and against what version
 * of the board" — currently answers the first half with a string the claimant
 * chose for itself. `decided_at_commit` fixed the second half. This is the first.
 *
 * A GitHub Actions OIDC JWT is a GitHub-SIGNED assertion of workflow identity:
 * repository, repository_owner, and job_workflow_ref (which carries the branch,
 * e.g. `@refs/heads/main`). The broker already trusts exactly those claims to
 * hand out credentials. Recording them next to the commit makes a Dolt commit
 * say "produced by this workflow at this ref" instead of "produced by someone
 * who typed this name".
 *
 * WHAT THIS PROVES — AND, IMPORTANTLY, WHAT IT DOES NOT
 * ----------------------------------------------------
 * The claims below are decoded, NOT verified, and the raw JWT is NOT stored.
 * Both are deliberate, and together they bound what a reader may conclude.
 *
 *   • Not stored, because the mirror is PUBLIC. That public read plane is the
 *     reason src/dolthub.ts needs no credential — and it means anything written
 *     here is world-readable. A GitHub OIDC JWT is a BEARER token for the
 *     broker; publishing one inside its validity window would hand any reader
 *     the broker credential. The digest is stored instead.
 *
 *   • Not verified here, because at write time verification would be
 *     circular: this code runs in the same job that just minted the token.
 *
 * So a later reader of the mirror sees claims ASSERTED BY THE WRITER, not a
 * signature they can check. The row is only as trustworthy as write access to
 * the mirror — which is broker-gated to pinned workflows, so it is not nothing,
 * but it is emphatically NOT "cryptographically verifiable by anyone".
 *
 * What the digest DOES buy, concretely: the broker sees every JWT it verifies.
 * If the broker logs (digest → verified claims), then the mirror row and the
 * broker's log are two independently-written records that must agree. A forged
 * attestation has no matching broker entry. That is cross-checkable integrity,
 * and it costs one column.
 *
 * THE UPGRADE PATH — `receipt`
 * ----------------------------
 * Full third-party verifiability needs the broker to sign. It already verifies
 * the OIDC token; a second endpoint, called AFTER the Dolt commit exists:
 *
 *     POST {BROKER}/attest/front-desk-mirror   Authorization: Bearer <oidc jwt>
 *     { "commit": "<32-char dolt hash>" }
 *   → { "receipt": "<JWS compact>" }           # broker-signed, published JWKS
 *
 * binding the claims IT verified to the commit hash. A receipt is not a bearer
 * credential — no audience, no privileges — so it is safe in a public database,
 * and anyone can check it against the broker's JWKS. Until that ships, `receipt`
 * is NULL and the paragraph above is the honest description of this table.
 */

import { createHash } from "node:crypto";

/** The claims the broker pins. Missing any of them means we do not attest. */
export interface OidcClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly repository: string;
  readonly repositoryOwner: string;
  readonly jobWorkflowRef: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly jti: string | null;
  readonly issuedAt: number; // unix seconds
  readonly expiresAt: number;
}

export interface Attestation {
  readonly doltCommit: string;
  readonly jwtSha256: string;
  readonly claims: OidcClaims;
  /** Broker-signed JWS binding claims→commit. NULL until the endpoint exists. */
  readonly receipt: string | null;
}

/** Dolt content hashes are 32 chars of base32. Same shape check as decided_at_commit. */
const COMMIT_SHAPE = /^[a-z0-9]{32}$/;

/**
 * Decode a JWT payload WITHOUT verifying its signature.
 *
 * The name is deliberately ugly. Anything that decides access from these claims
 * must verify first — that is the broker's job (`verifyOIDC`), and doing it in
 * the job that minted the token would prove nothing anyway.
 */
export function decodeUnverifiedJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("not a JWS compact serialization (expected 3 dot-separated parts)");
  let json: string;
  try {
    json = Buffer.from(parts[1], "base64url").toString("utf8");
  } catch {
    throw new Error("JWT payload is not valid base64url");
  }
  const payload = JSON.parse(json) as unknown;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("JWT payload is not a JSON object");
  }
  return payload as Record<string, unknown>;
}

/** sha256 of the RAW token — a commitment to the JWT without disclosing it. */
export function jwtDigest(jwt: string): string {
  return createHash("sha256").update(jwt, "utf8").digest("hex");
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  // `aud` may legally be an array; GitHub issues a single audience, and an
  // attestation naming several would not say which one was used.
  if (typeof v !== "string" || v === "") throw new Error(`OIDC claim '${key}' missing or not a string`);
  return v;
}

function num(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`OIDC claim '${key}' missing or not a number`);
  return v;
}

/**
 * Build the attestation for a commit. Throws rather than writing a partial row:
 * an attestation missing `job_workflow_ref` is exactly the one that cannot
 * distinguish a pinned workflow from anything else, so a half-filled row would
 * be worse than none — it would look like provenance.
 */
export function attestationFor(
  doltCommit: string,
  jwt: string,
  receipt: string | null = null,
): Attestation {
  if (!COMMIT_SHAPE.test(doltCommit)) {
    throw new Error(`not a Dolt commit hash: ${JSON.stringify(doltCommit)}`);
  }
  const p = decodeUnverifiedJwtPayload(jwt);
  return {
    doltCommit,
    jwtSha256: jwtDigest(jwt),
    receipt,
    claims: {
      iss: str(p, "iss"),
      sub: str(p, "sub"),
      aud: str(p, "aud"),
      repository: str(p, "repository"),
      repositoryOwner: str(p, "repository_owner"),
      jobWorkflowRef: str(p, "job_workflow_ref"),
      runId: str(p, "run_id"),
      runAttempt: str(p, "run_attempt"),
      jti: typeof p.jti === "string" && p.jti !== "" ? p.jti : null,
      issuedAt: num(p, "iat"),
      expiresAt: num(p, "exp"),
    },
  };
}

/**
 * SQL string literal. These values arrive inside a GitHub-signed token, so they
 * are not attacker-chosen in the usual sense — but they are interpolated into a
 * statement, and "the input is trustworthy" is the assumption that stops being
 * true the moment someone reuses this helper. Escape unconditionally.
 */
export function sqlLit(s: string): string {
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error("control character in attestation value");
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

/** unix seconds → the `YYYY-MM-DD HH:MM:SS` UTC form Dolt's datetime wants. */
export function sqlDatetime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/**
 * The INSERT. `INSERT IGNORE` because `dolt_commit` is the PRIMARY KEY: a commit
 * has exactly one producer, so a second attestation for the same commit is a
 * re-run, not new information. Losing that race is a non-event — the same shape
 * as a lost lease latch, and for the same reason.
 */
export function attestationInsertSql(a: Attestation): string {
  const c = a.claims;
  return `INSERT IGNORE INTO commit_attestations
    (dolt_commit, attested_at, jwt_sha256, iss, sub, aud, repository, repository_owner,
     job_workflow_ref, run_id, run_attempt, jti, issued_at, expires_at, receipt)
    VALUES (${sqlLit(a.doltCommit)}, UTC_TIMESTAMP(), ${sqlLit(a.jwtSha256)},
     ${sqlLit(c.iss)}, ${sqlLit(c.sub)}, ${sqlLit(c.aud)}, ${sqlLit(c.repository)},
     ${sqlLit(c.repositoryOwner)}, ${sqlLit(c.jobWorkflowRef)}, ${sqlLit(c.runId)},
     ${sqlLit(c.runAttempt)}, ${c.jti === null ? "NULL" : sqlLit(c.jti)},
     ${sqlLit(sqlDatetime(c.issuedAt))}, ${sqlLit(sqlDatetime(c.expiresAt))},
     ${a.receipt === null ? "NULL" : sqlLit(a.receipt)})`;
}

/**
 * Mint an Actions OIDC token for `audience`. Returns null OUTSIDE Actions — an
 * interactive session has no ACTIONS_ID_TOKEN_REQUEST_URL and cannot mint one,
 * by design (see mirror-migrate.yml's header). That is the honest outcome: such
 * a commit gets NO attestation row, and the absence is the signal. Writing a
 * weaker self-asserted row instead would erase the only distinction this table
 * exists to draw.
 */
export async function mintActionsIdToken(audience: string): Promise<string | null> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !tok) return null;
  const res = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error(`OIDC token request failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { value?: string };
  if (!body.value) throw new Error("OIDC token response had no 'value'");
  return body.value;
}
