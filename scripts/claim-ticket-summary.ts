/**
 * Render a claim verdict for `claim-ticket.yml` (#61).
 *
 * Split out of the workflow rather than inlined as `node -e`, for one reason
 * worth recording: an inline heredoc script inside YAML is the one part of a
 * workflow that CI cannot exercise. Writing this the first time, the argv
 * contract was got wrong twice and neither mistake was visible until a run.
 * Here it is importable, and `test/claim-ticket-summary.test.ts` pins it.
 *
 * The output has two audiences, so it has two shapes:
 *
 *   - a human reading the run summary
 *   - a cloud session that dispatched the run and now has to decide what it
 *     holds, by grepping one line out of the job log
 *
 * The distinction the whole thing turns on: a REFUSAL IS AN ANSWER. Losing a
 * race means another claimant holds the item — a fact. An error means the claim
 * never reached a decision, so the holder is UNKNOWN. Collapsing those two would
 * let an unreachable endpoint read as contention, which is exactly the confusion
 * `src/lease-client.ts` refuses to introduce on the transport side.
 */

/** Shape of the `claim` verb's output (see ClaimOutput in src/verbs.ts). */
export interface ClaimVerdict {
  won: boolean;
  itemId: string | null;
  number: number | null;
  repository: string | null;
  title: string | null;
  reason: string;
  /** The fencing token (#114). Optional here, not because it is optional in the
   *  verb — it is not — but because a verdict recorded by a run that PREDATES
   *  the field must still render rather than crash the summary step. */
  fencing?: number | null;
}

/** The one greppable line a session reads out of the job log. */
export const RESULT_MARKER = "FDS-CLAIM-RESULT";

export function resultLine(verdict: ClaimVerdict): string {
  return `${RESULT_MARKER} ${JSON.stringify(verdict)}`;
}

/**
 * The run summary for a verdict that WAS reached — granted or not.
 *
 * `agentLabel` is echoed with its namespaced form because the alias a caller
 * passes is not the identity that gets recorded: the Worker binds it under the
 * verified identity (`gha/<label>`), so a caller who reads only their own label
 * back would mis-attribute their own lease.
 */
export function renderVerdict(verdict: ClaimVerdict, agentLabel: string): string {
  const lines: string[] = [];
  if (verdict.won) {
    lines.push(
      "## claim-ticket — GRANTED",
      "",
      `**#${verdict.number}** [${verdict.repository}] — ${verdict.title ?? ""}`,
      "",
      `- item: \`${verdict.itemId}\``,
      `- agent: \`${agentLabel}\` (recorded under the verified identity as \`gha/${agentLabel}\`)`,
      `- reason: ${verdict.reason}`,
      // The token is an INPUT to the caller's next dispatch, so it is called out
      // rather than left inside `reason` for them to parse (#114). A verdict
      // from a run predating the field says so instead of rendering "null".
      verdict.fencing === null || verdict.fencing === undefined
        ? `- fencing: **not reported** — this run predates #114; read it from the \`reason\` above`
        : `- fencing: \`${verdict.fencing}\` — pass this to \`bind-ticket\` / \`release-ticket\``,
      "",
      "**Bind it now.** The ttl above is the referent-less grace window, not a task",
      "estimate (#105): dispatch `bind-ticket.yml` with the item, the fencing token and",
      "your PR, and the reaper releases the lease when that PR closes. A lease that",
      "never binds lapses on the short ttl.",
    );
  } else {
    lines.push(
      "## claim-ticket — NOT GRANTED",
      "",
      `No lease was taken: ${verdict.reason}`,
      "",
      "This is a normal outcome, not a failure. Either another claimant holds the item",
      "or nothing was eligible. Run `next` again and dispatch afresh.",
    );
  }
  lines.push("", "```json", JSON.stringify(verdict, null, 2), "```");
  return lines.join("\n") + "\n";
}

/**
 * The run summary for a claim that never reached a verdict.
 *
 * Deliberately does NOT name a holder or a reason drawn from the payload —
 * there is no payload. The only honest thing to report is that the item's state
 * is unknown.
 */
export function renderError(stderr: string, exitCode: number): string {
  return [
    "## claim-ticket — ERROR",
    "",
    `No verdict (exit ${exitCode}). The claim did not reach a decision, so the item's`,
    "holder is **UNKNOWN**. This is not a lost race — do not retry as though it were",
    "contention until the cause below is understood.",
    "",
    "```",
    stderr.trim() || "(no diagnostic output)",
    "```",
  ].join("\n") + "\n";
}

// CLI: claim-ticket-summary.ts <json>            → verdict summary on stdout
//      claim-ticket-summary.ts --error <code>    → error summary, stderr on stdin
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
    const verdict = JSON.parse(flag ?? "") as ClaimVerdict;
    process.stdout.write(renderVerdict(verdict, process.env.AGENT_LABEL ?? "unknown"));
  }
}
