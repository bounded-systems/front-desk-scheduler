/**
 * OIDC attestation of Dolt commits.
 *
 * The property under test is narrow and worth stating exactly, because it is
 * easy to believe this module does more than it does: it records claims from a
 * GitHub-signed token WITHOUT verifying them and WITHOUT storing the token. The
 * tests therefore pin two different kinds of thing —
 *
 *   • correctness of the record (claims land, times convert, SQL is escaped)
 *   • the safety boundary (the raw JWT must never reach the public mirror, and
 *     a partial attestation must fail rather than look like provenance)
 *
 * The second kind matters more. The mirror is world-readable and a GitHub OIDC
 * token is a bearer credential for the broker, so "the JWT is not in the row" is
 * a security property, not a style choice.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  attestationFor,
  attestationInsertSql,
  decodeUnverifiedJwtPayload,
  jwtDigest,
  sqlDatetime,
  sqlLit,
} from "../src/attest.ts";

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

/** A structurally-real Actions OIDC token. The signature is nonsense on purpose:
 *  nothing in this module may depend on it, since nothing here verifies it. */
function fakeJwt(overrides: Record<string, unknown> = {}): string {
  const payload = {
    iss: "https://token.actions.githubusercontent.com",
    sub: "repo:bounded-systems/front-desk-scheduler:ref:refs/heads/main",
    aud: "dolthub-cred-broker",
    repository: "bounded-systems/front-desk-scheduler",
    repository_owner: "bounded-systems",
    job_workflow_ref:
      "bounded-systems/front-desk-scheduler/.github/workflows/mirror-migrate.yml@refs/heads/main",
    run_id: "30375175935",
    run_attempt: "1",
    jti: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    iat: 1_785_000_000,
    exp: 1_785_000_900,
    ...overrides,
  };
  for (const [k, v] of Object.entries(payload)) if (v === undefined) delete (payload as Record<string, unknown>)[k];
  return `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(payload)}.c2lnbmF0dXJl`;
}

const HASH = "v0110csl2jph0aeeij7rhhurrbjcft6g";

test("claims are read out of the token", () => {
  const a = attestationFor(HASH, fakeJwt());
  assert.equal(a.doltCommit, HASH);
  assert.equal(a.claims.repository, "bounded-systems/front-desk-scheduler");
  assert.equal(a.claims.repositoryOwner, "bounded-systems");
  // The load-bearing one: it names the workflow FILE and the REF it ran on.
  assert.match(a.claims.jobWorkflowRef, /mirror-migrate\.yml@refs\/heads\/main$/);
  assert.equal(a.claims.runId, "30375175935");
  assert.equal(a.receipt, null, "no broker receipt until that endpoint exists");
});

test("the raw JWT never reaches the row — only its digest", () => {
  // THE security property. The mirror is public; a live OIDC token in it is a
  // handed-out broker credential.
  const jwt = fakeJwt();
  const sql = attestationInsertSql(attestationFor(HASH, jwt));
  assert.ok(!sql.includes(jwt), "the whole token must not appear");
  for (const part of jwt.split(".")) {
    assert.ok(!sql.includes(part), "no segment of the token may appear either");
  }
  assert.ok(sql.includes(createHash("sha256").update(jwt, "utf8").digest("hex")), "the digest must");
});

test("the digest commits to the exact token", () => {
  assert.notEqual(jwtDigest(fakeJwt()), jwtDigest(fakeJwt({ run_id: "1" })));
  assert.equal(jwtDigest(fakeJwt()), jwtDigest(fakeJwt()));
});

test("a missing claim refuses to attest rather than writing a partial row", () => {
  // A row without job_workflow_ref cannot distinguish a pinned workflow from
  // anything else, so it would LOOK like provenance while carrying none.
  for (const claim of ["job_workflow_ref", "repository", "repository_owner", "iss", "sub", "aud"]) {
    assert.throws(
      () => attestationFor(HASH, fakeJwt({ [claim]: undefined })),
      new RegExp(`'${claim}' missing`),
      `must refuse when ${claim} is absent`,
    );
  }
  assert.throws(() => attestationFor(HASH, fakeJwt({ iat: undefined })), /'iat' missing/);
  // jti is genuinely optional — GitHub sends it, but its absence loses nothing.
  assert.equal(attestationFor(HASH, fakeJwt({ jti: undefined })).claims.jti, null);
});

test("a non-commit is rejected before it is interpolated", () => {
  for (const bad of ["", "deadbeef", `${HASH}x`, "'; DROP TABLE items; --"]) {
    assert.throws(() => attestationFor(bad, fakeJwt()), /not a Dolt commit hash/);
  }
});

test("decoding is decoding — it does not pretend to verify", () => {
  // Same payload, garbage signature: accepted, because verification is the
  // broker's job and doing it in the job that minted the token proves nothing.
  const payload = decodeUnverifiedJwtPayload(fakeJwt());
  assert.equal(payload.repository_owner, "bounded-systems");
  assert.throws(() => decodeUnverifiedJwtPayload("not.a"), /3 dot-separated parts/);
  assert.throws(() => decodeUnverifiedJwtPayload(`x.${b64u([1, 2])}.y`), /not a JSON object/);
});

test("SQL literals are escaped, and control characters are refused", () => {
  assert.equal(sqlLit("a'b"), "'a''b'");
  assert.equal(sqlLit("a\\b"), "'a\\\\b'");
  assert.throws(() => sqlLit("a\u0000b"), /control character/);
  assert.throws(() => sqlLit("a\nb"), /control character/);
  // End to end: a quote in a claim must not break out of the statement.
  const sql = attestationInsertSql(attestationFor(HASH, fakeJwt({ sub: "repo:o'brien/x:ref:main" })));
  assert.ok(sql.includes("'repo:o''brien/x:ref:main'"));
});

test("unix seconds become the datetime Dolt accepts", () => {
  assert.equal(sqlDatetime(1_785_000_000), "2026-07-25 17:20:00");
  assert.ok(!sqlDatetime(1_785_000_000).includes("T"), "no ISO 'T' — Dolt wants a space");
  assert.ok(!/\.\d/.test(sqlDatetime(1_785_000_000.5)), "no fractional seconds");
});

test("re-attesting a commit is a non-event, not an error", () => {
  // dolt_commit is the PRIMARY KEY: one commit has one producer, so a second
  // attestation is a re-run. Same shape as losing a lease latch.
  assert.match(attestationInsertSql(attestationFor(HASH, fakeJwt())), /^INSERT IGNORE INTO commit_attestations/);
});

test("the schema of record and the migration agree with the writer", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const ddl = read("../schema/mirror.sql");
  const mig = read("../schema/migrations/2026-07-29-commit-attestations.sql");
  const sql = attestationInsertSql(attestationFor(HASH, fakeJwt()));

  const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
  assert.ok(cols.length >= 14, "sanity: the column list parsed");
  for (const c of cols) {
    assert.ok(ddl.includes(`\`${c}\``), `schema of record is missing ${c}`);
    assert.ok(mig.includes(`\`${c}\``), `migration is missing ${c}`);
  }
  assert.match(ddl, /PRIMARY KEY \(`dolt_commit`\)/, "one attestation per commit is the invariant");
  // The public-mirror hazard must be stated where a schema reader will see it.
  assert.match(ddl, /PUBLIC/, "the schema must say the mirror is public");
  assert.match(ddl, /NOT third-party verifiable/, "and must not overstate what a row proves");
});
