/**
 * Front Desk scheduler MCP server — the SAME verbs (src/verbs.ts) served as MCP
 * tools over stdio, via @bounded-systems/verbspec-mcp (the org's adapter). Point
 * a local MCP client (Claude Desktop / Claude Code) at:
 *
 *   node scripts/mcp.ts
 *
 * Reads the DoltHub/local plane only — no GitHub credential, zero rate-limit
 * budget. Set FDS_READS=dolthub to force the public read plane (no local dolt).
 */

import { serveStdio } from "@bounded-systems/verbspec-mcp";
import { VERBS } from "../src/verbs.ts";
import { setReadsFactory } from "../src/reads.ts";
import { resolveReads } from "../src/reads-resolve.ts";

// This process has a filesystem, so it gets the auto-detecting read plane.
// `verbs.ts` deliberately does not import it — see src/reads.ts.
setReadsFactory(resolveReads);

await serveStdio(VERBS, { name: "front-desk-scheduler", version: "0.0.0" });
