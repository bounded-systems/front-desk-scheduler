#!/usr/bin/env node
/**
 * Stamp the mirror's current HEAD with the OIDC identity that produced it.
 *
 *     node scripts/attest.ts [--dir mirror] [--audience dolthub-cred-broker]
 *
 * Run INSIDE a GitHub Actions job, immediately after the `dolt commit` whose
 * provenance is being recorded and BEFORE `dolt push`, so the data commit and
 * its attestation travel together.
 *
 * ORDERING, AND THE UNATTESTED TAIL
 * ---------------------------------
 * A commit's hash is not known until it exists, so an attestation can never
 * live in the commit it describes. This writes a SECOND commit containing the
 * attestation row for the first. That second commit is therefore itself
 * unattested — an unavoidable regress for any in-band ledger, and the same
 * shape as the last entry of any append-only log. It is not a gap worth
 * closing here: the attestation commit contains nothing but the row, and
 * tampering with it is what the broker-side digest cross-check would catch.
 *
 * OUTSIDE ACTIONS this exits 0 having done nothing. An interactive session has
 * no ACTIONS_ID_TOKEN_REQUEST_URL and cannot mint a token — by design, since
 * that is the property making "only a pinned workflow can write" true. The
 * absence of a row IS the record for such a commit; inventing a self-asserted
 * one would destroy the distinction the table exists to draw.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attestationFor, attestationInsertSql, mintActionsIdToken } from "../src/attest.ts";

const pexecFile = promisify(execFile);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const dir = arg("dir", "mirror");
  // Whichever audience the job already used; the claims are the same either way.
  const audience = arg("audience", "dolthub-cred-broker");

  const jwt = await mintActionsIdToken(audience);
  if (jwt === null) {
    console.log("::notice::not running in GitHub Actions — no OIDC identity to attest, skipping");
    return;
  }

  const dolt = (args: string[]) => pexecFile("dolt", args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });

  const { stdout } = await dolt(["sql", "-r", "json", "-q",
    "SELECT commit_hash FROM dolt_log ORDER BY date DESC LIMIT 1"]);
  const head = (JSON.parse(stdout || "{}") as { rows?: { commit_hash?: string }[] })
    .rows?.[0]?.commit_hash;
  if (!head) throw new Error("could not read HEAD from dolt_log");

  // Throws on a missing claim rather than writing a partial row — an
  // attestation without job_workflow_ref is the one that proves nothing.
  const a = attestationFor(head, jwt);

  await dolt(["sql", "-q", attestationInsertSql(a)]);
  await dolt(["add", "-A"]);
  try {
    await dolt(["commit", "-m", `attest: ${head} by ${a.claims.jobWorkflowRef}`,
      "--author", "front-desk-attest <1240090+bdelanghe@users.noreply.github.com>"]);
  } catch (e) {
    // INSERT IGNORE collided: this commit is already attested (a re-run). Not an
    // error — the same non-event as losing a lease latch.
    if (!/nothing to commit/i.test(String(e))) throw e;
    console.log(`::notice::${head} was already attested — nothing to record`);
    return;
  }
  console.log(`::notice::attested ${head} → ${a.claims.jobWorkflowRef} (run ${a.claims.runId})`);
}

main().catch((e: unknown) => {
  // Loud, and non-fatal to the caller's judgement: the workflow decides whether
  // a missing attestation should fail the run. Losing the row costs provenance,
  // not correctness — the same call made for claims.decided_at_commit.
  console.error(`::error::attestation failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
