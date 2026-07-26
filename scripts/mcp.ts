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

await serveStdio(VERBS, { name: "front-desk-scheduler", version: "0.0.0" });
