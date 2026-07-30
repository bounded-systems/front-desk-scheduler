/**
 * frontdeskd — the broker behind the `frontdesk` door (guest-room).
 *
 * Serves the scheduler verbs (next / claim / release) as JSON-RPC over a
 * unix socket. THIS process holds the read-plane credential (DOLT_* / the mirror);
 * the guest knocks on the socket and never holds a key — the guest-room contract.
 * A guest with the `frontdesk` door can ask "what should I do?" and claim work
 * with no GitHub or DB credential of its own.
 *
 *   FRONTDESKD_SOCK=/run/frontdeskd.sock node scripts/frontdeskd.ts
 */

import { createServer } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { handleJsonRpc } from "@bounded-systems/verbspec";
import { VERBS } from "../src/verbs.ts";

const sock = process.env.FRONTDESKD_SOCK ?? "/tmp/frontdeskd.sock";
if (existsSync(sock)) unlinkSync(sock); // clear a stale socket

const server = createServer((conn) => {
  let buf = "";
  conn.on("data", async (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const resp = await handleJsonRpc(VERBS, JSON.parse(line));
        if (resp) conn.write(JSON.stringify(resp) + "\n");
      } catch (err) {
        conn.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: String(err) } }) + "\n");
      }
    }
  });
});

server.listen(sock, () => console.error(`frontdeskd: door open on ${sock} (verbs: ${Object.keys(VERBS).join(", ")})`));
process.on("SIGINT", () => { try { unlinkSync(sock); } catch { /* */ } process.exit(0); });
process.on("SIGTERM", () => { try { unlinkSync(sock); } catch { /* */ } process.exit(0); });
