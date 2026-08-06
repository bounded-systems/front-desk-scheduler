/**
 * triage-ticket — the ceremony behind `triage-ticket.yml` (step 0 of
 * `proposals/broker-session-tier/`).
 *
 *   claim → comment → close → release, one dispatch, one verdict line.
 *
 * WHY THIS IS A SCRIPT AND NOT A VERB
 * -----------------------------------
 * The verbs in `src/verbs.ts` project to MCP, and an MCP tool a session can see
 * but never successfully call is worse than no tool: it invites the call and
 * fails at the credential. Triage writes to GitHub issues in OTHER repos, which
 * needs the Front Desk App identity, which lives behind the broker and is
 * reachable only from an allowlisted workflow. So this follows the
 * `status-writeback.ts` precedent — a plain script whose only caller is the
 * window that holds the credential.
 *
 * The decisions live in `src/triage.ts` and are pure; everything here is I/O.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  type ClaimVerdict,
  type TriageInput,
  type TriageReason,
  planTriage,
  releaseStatusFor,
  stateReasonFor,
} from "../src/triage.ts";

const pexecFile = promisify(execFile);

export const RESULT_MARKER = "FDS-TRIAGE-RESULT";

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`::error::${name} is required and must be non-empty.`);
    process.exit(2);
  }
  return v;
}

function parseReason(raw: string): TriageReason {
  if (raw === "superseded" || raw === "resolved" || raw === "not-planned") return raw;
  console.error(`::error::reason must be superseded | resolved | not-planned (got '${raw}').`);
  process.exit(2);
}

/** Run the claim verb exactly as `claim-ticket.yml` does, so the two windows
 *  cannot drift about what a claim is. stdout is the verdict; stderr is the
 *  diagnosis, kept apart so a transport error cannot be parsed as a refusal. */
async function claim(item: string, agent: string, ttl: string): Promise<ClaimVerdict> {
  const { stdout } = await pexecFile("node", [
    "scripts/fds.ts",
    "claim",
    "--agent",
    agent,
    "--item",
    item,
    "--ttl",
    ttl,
  ], { env: { ...process.env, FDS_JSON: "1" } });
  return JSON.parse(stdout) as ClaimVerdict;
}

async function release(
  itemId: string,
  agent: string,
  fencing: number,
  status: "completed" | "released",
): Promise<unknown> {
  const args = [
    "scripts/fds.ts",
    "release",
    "--itemId",
    itemId,
    "--agent",
    agent,
    "--fencing",
    String(fencing),
  ];
  if (status === "completed") args.push("--complete");
  const { stdout } = await pexecFile("node", args, {
    env: { ...process.env, FDS_JSON: "1" },
  });
  return JSON.parse(stdout) as unknown;
}

/**
 * The writes run under a DIFFERENT identity than the claim, and the split is
 * not incidental. `github.token` is an installation token covering THIS repo —
 * which is exactly what the lease Worker accepts (`auth.mjs` branch 2, coverage
 * is the grant) and exactly what cannot comment on `prx`. The Front Desk App
 * token can write the target repo but is minted per-run from the broker. So
 * `GH_TOKEN` stays the claim's identity and the App token is passed only to the
 * `gh` subprocess, which keeps each credential to the one call it is for.
 */
async function gh(args: string[]): Promise<string> {
  const appToken = process.env.TRIAGE_GH_TOKEN?.trim();
  const env = appToken ? { ...process.env, GH_TOKEN: appToken } : process.env;
  const { stdout } = await pexecFile("gh", args, { env, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function main(): Promise<number> {
  const input: TriageInput = {
    item: required("TRIAGE_ITEM"),
    reason: parseReason(required("TRIAGE_REASON")),
    evidence: required("TRIAGE_EVIDENCE"),
    supersededBy: process.env.TRIAGE_SUPERSEDED_BY?.trim() || undefined,
    agentLabel: required("AGENT_LABEL"),
  };
  const ttl = process.env.TTL?.trim() || "600";
  const dryRun = process.env.DRY_RUN === "true";

  // The claim is the guard, so it runs even on a dry run — a plan that skipped
  // it would print a confident intention to close something the ready rule
  // would have refused, which is precisely the reassurance not to give.
  let verdict: ClaimVerdict;
  try {
    verdict = await claim(input.item, input.agentLabel, ttl);
  } catch (err) {
    // No verdict means the holder is UNKNOWN — a different fact from a refusal,
    // and the run fails so a caller cannot read it as "someone else has it".
    console.error(`::error::claim failed before a verdict was reached: ${String(err)}`);
    console.log(`${RESULT_MARKER} ${JSON.stringify({ ok: false, stage: "claim", error: "no-verdict" })}`);
    return 1;
  }

  const plan = planTriage(verdict, input);
  if (plan.action === "abort") {
    // A refusal is an ANSWER and the run succeeds: `not-granted` means someone
    // else is on it, `not-eligible` means the item must change before anyone
    // can be. Failing here would train callers to read a lost race as breakage.
    console.log(
      `${RESULT_MARKER} ${JSON.stringify({
        ok: false,
        stage: "claim",
        verdict: plan.why,
        detail: plan.detail,
        wrote: false,
      })}`,
    );
    return 0;
  }

  const { target, comment } = plan;
  const ref = `${target.owner}/${target.repo}#${target.number}`;

  if (dryRun) {
    console.log(`--- would comment on ${ref}:\n${comment}\n--- would close with state_reason=${stateReasonFor(input.reason)}`);
    // Hand the lease straight back: a dry run has finished nothing, and holding
    // it would park the item for the ttl over a preview.
    await release(target.itemId, input.agentLabel, target.fencing, "released").catch(() => {});
    console.log(
      `${RESULT_MARKER} ${JSON.stringify({ ok: true, dryRun: true, item: ref, itemId: target.itemId, wrote: false })}`,
    );
    return 0;
  }

  let commented = false;
  let closed = false;
  const errors: string[] = [];

  try {
    await gh([
      "api",
      `repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
      "-f",
      `body=${comment}`,
    ]);
    commented = true;
  } catch (err) {
    errors.push(`comment: ${String(err)}`);
  }

  // Close only after the evidence is on the record. The other order can leave a
  // closed item with no stated reason, which is the artifact a reader cannot
  // act on — and the App token's `issues: write` on the TARGET repo is the
  // usual cause of a failure here, not the close itself.
  if (commented) {
    try {
      const args = [
        "api",
        "-X",
        "PATCH",
        `repos/${target.owner}/${target.repo}/issues/${target.number}`,
        "-f",
        "state=closed",
      ];
      // Pull requests reject state_reason; issues take it.
      const isPr = process.env.TRIAGE_TARGET_KIND === "pr";
      if (!isPr) args.push("-f", `state_reason=${stateReasonFor(input.reason)}`);
      await gh(args);
      closed = true;
    } catch (err) {
      errors.push(`close: ${String(err)}`);
    }
  }

  const status = releaseStatusFor({ commented, closed });
  let released = false;
  try {
    await release(target.itemId, input.agentLabel, target.fencing, status);
    released = true;
  } catch (err) {
    errors.push(`release: ${String(err)}`);
  }

  const ok = commented && closed && released;
  console.log(
    `${RESULT_MARKER} ${JSON.stringify({
      ok,
      item: ref,
      itemId: target.itemId,
      fencing: target.fencing,
      commented,
      closed,
      releasedAs: status,
      released,
      ...(errors.length ? { errors } : {}),
    })}`,
  );

  // A half-run is a failure: the lease was handed back as `released`, so the
  // item is queued again, and the run must say so rather than look like a
  // retirement that happened.
  return ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
