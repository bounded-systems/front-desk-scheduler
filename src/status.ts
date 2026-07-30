/**
 * @module status
 * Front Desk `Status` → bead state. A pure mapping, in its own module for the
 * same dependency reason as `mirror-dir.ts`.
 *
 * It lived in `board.ts`, which statically imports `node:child_process` and
 * `node:fs` for the live-board `gh` path. `verbs.ts` needs this function and
 * nothing else from that module, so importing it there pulled the whole GitHub
 * CLI seam into the verb surface — including for the DoltHub read plane, which
 * never shells out to anything.
 *
 * `board.ts` re-exports it, so every existing caller is unchanged.
 */

import type { BeadState } from "./policy.ts";

/** Front Desk Status → bead state (see gh-project-room/contract.ts). */
export function statusToState(status: string | undefined): BeadState {
  switch (status) {
    case "Todo":
      return "open";
    case "In Progress":
      return "in_progress";
    case "Blocked":
      return "blocked";
    case "Done":
      return "closed";
    default:
      return "open";
  }
}
