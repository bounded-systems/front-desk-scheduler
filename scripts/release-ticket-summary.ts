/**
 * Render a release verdict for `release-ticket.yml` (#104).
 *
 * Sibling of `claim-ticket-summary.ts`, and split out of the workflow for the
 * same reason: an inline heredoc inside YAML is the one part of a workflow CI
 * cannot exercise, so the argv contract lives here where a test can pin it.
 *
 * THE DISTINCTION THIS FILE EXISTS TO PRESERVE
 * --------------------------------------------
 * A claim has three outcomes and so does a release, but they are NOT the same
 * three, and the difference is what makes a shared renderer wrong:
 *
 *   RELEASED   the lease is free (or closed as completed)
 *   REFUSED    the DO declined — and WHICH refusal matters:
 *                not-held       the lease had already lapsed; nobody holds it
 *                not-holder     someone else holds it; you released nothing
 *                stale-fencing  you are a ZOMBIE — a newer grant exists
 *   ERROR      no verdict; the lease's state is unknown
 *
 * `stale-fencing` is the one worth shouting about. For a claim, losing is
 * ordinary contention. For a release it means the caller believed it held an
 * item that has since been granted to somebody else — so it may still be doing
 * work, and its writes are the ones a downstream sink should be refusing. The
 * refusal is the mechanism working (it stopped a zombie from freeing the new
 * holder's lease), and it is simultaneously a signal to STOP.
 */

/** Shape of the `release` verb's output (see releaseVerb in src/verbs.ts). */
export interface ReleaseVerdict {
  released: boolean;
  status: string;
  reason: string;
  holder: string | null;
}

/** The one greppable line a session reads out of the job log. */
export const RESULT_MARKER = "FDS-RELEASE-RESULT";

export function resultLine(verdict: ReleaseVerdict): string {
  return `${RESULT_MARKER} ${JSON.stringify(verdict)}`;
}

/** True when the refusal says the caller has been superseded by a newer grant. */
export function isZombie(verdict: ReleaseVerdict): boolean {
  return !verdict.released && verdict.reason === "stale-fencing";
}

/**
 * The run summary for a verdict that WAS reached — released or refused.
 *
 * `agentLabel` is echoed in its namespaced form for the same reason the claim
 * renderer does it: the alias a caller passes is not the identity recorded, so
 * a caller reading back only its own label would mis-attribute the lease.
 */
export function renderVerdict(
  verdict: ReleaseVerdict,
  agentLabel: string,
  itemId: string,
): string {
  const lines: string[] = [];

  if (verdict.released) {
    lines.push(
      `## release-ticket — ${verdict.status.toUpperCase()}`,
      "",
      `- item: \`${itemId}\``,
      `- agent: \`${agentLabel}\` (recorded under the verified identity as \`gha/${agentLabel}\`)`,
      "",
      "The item is free. Its grant interval is closed in the DO's history and reaches",
      "Dolt via `lease-projection`.",
    );
  } else if (isZombie(verdict)) {
    lines.push(
      "## release-ticket — REFUSED (stale fencing)",
      "",
      "**You are not the current holder — a newer grant exists.** The release was",
      "refused, which is the mechanism working: releasing would have freed the lease",
      "belonging to whoever holds it now.",
    );
    if (verdict.holder) {
      lines.push("", `The DO reports the current holder as \`${verdict.holder}\`.`);
    }
    lines.push(
      "",
      "**Stop working this item.** Anything still in flight under the old grant is a",
      "zombie write, and a sink checking fencing tokens should be refusing it.",
    );
  } else {
    lines.push(
      "## release-ticket — NOT RELEASED",
      "",
      `Nothing was released: ${verdict.reason}`,
      "",
      verdict.reason === "not-held"
        ? "The lease had already lapsed — the item was free before this ran. Nothing to do."
        : "Another agent holds this item, so there was no lease of yours to free.",
    );
    if (verdict.holder) lines.push("", `Current holder: \`${verdict.holder}\`.`);
    lines.push("", "This is a normal outcome, not a failure.");
  }

  lines.push("", "```json", JSON.stringify(verdict, null, 2), "```");
  return lines.join("\n") + "\n";
}

/**
 * The run summary for a release that never reached a verdict.
 *
 * Says nothing about the holder — there is no payload to say it from. The
 * dangerous misreading here is the mirror of the claim's: treating an error as
 * "already released" and moving on leaves a lease held with nobody watching it.
 */
export function renderError(stderr: string, exitCode: number): string {
  return [
    "## release-ticket — ERROR",
    "",
    `No verdict (exit ${exitCode}). The release did not reach a decision, so the lease's`,
    "state is **UNKNOWN** — it may still be held.",
    "",
    "Do not assume the item is free. Read `/status` for the item before re-dispatching;",
    "if the lease is still yours, retry, and if it is not, you have been superseded.",
    "",
    "```",
    stderr.trim() || "(no diagnostic output)",
    "```",
  ].join("\n") + "\n";
}

// CLI: release-ticket-summary.ts <json>          → verdict summary on stdout
//      release-ticket-summary.ts --error <code>  → error summary, stderr on stdin
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [flag, arg] = process.argv.slice(2);
  if (flag === "--error") {
    const stderr = await new Promise<string>((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (buf += c));
      process.stdin.on("end", () => resolve(buf));
    });
    process.stdout.write(renderError(stderr, Number(arg) || 1));
  } else {
    const verdict = JSON.parse(flag ?? "") as ReleaseVerdict;
    process.stdout.write(
      renderVerdict(verdict, process.env.AGENT_LABEL ?? "unknown", process.env.ITEM_ID ?? "unknown"),
    );
  }
}
