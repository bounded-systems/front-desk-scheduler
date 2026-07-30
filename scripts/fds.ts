#!/usr/bin/env node
/**
 * fds — the Front Desk scheduler CLI, dispatched from the VerbSpec registry.
 * The SAME verbs project to MCP / OpenAPI / Anthropic-tool surfaces (see
 * scripts/mcp.ts). Reads through the DoltHub/local seam — zero GitHub API.
 *
 *   fds next [--repo prx] [--top 10] [--budget rolling-5h]
 *   fds graph [--repo prx]        # the GH-canonical dep-graph (ready/blocked + edges)
 *
 * JSON output: verbspec validates flags strictly against each verb's input
 * schema, so there is no `--json` flag. Set FDS_JSON=1 and the raw verb output
 * object is printed as JSON instead of the human render — the machine surface
 * consumers (e.g. prx's Front Desk source) select.
 */

import { dispatch, render } from "@bounded-systems/verbspec";
import { VERBS } from "../src/verbs.ts";

const result = await dispatch(VERBS, process.argv.slice(2), "fds");
if (result.kind === "help") {
  console.log(result.text);
} else if (process.env.FDS_JSON === "1") {
  console.log(JSON.stringify(result.output));
} else {
  const verb = VERBS[result.id];
  console.log(verb?.render ? verb.render(result.output, result.input) : render(result.output));
}
