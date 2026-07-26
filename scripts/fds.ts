/**
 * fds — the Front Desk scheduler CLI, dispatched from the VerbSpec registry.
 * The SAME verbs project to MCP / OpenAPI / Anthropic-tool surfaces (see
 * scripts/mcp.ts). Reads through the DoltHub/local seam — zero GitHub API.
 *
 *   node scripts/fds.ts whats-next [--repo prx] [--top 10] [--budget rolling-5h]
 */

import { dispatch, render } from "@bounded-systems/verbspec";
import { VERBS } from "../src/verbs.ts";

const result = await dispatch(VERBS, process.argv.slice(2), "node scripts/fds.ts");
if (result.kind === "help") {
  console.log(result.text);
} else {
  const verb = VERBS[result.id];
  console.log(verb?.render ? verb.render(result.output, result.input) : render(result.output));
}
