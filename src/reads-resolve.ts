/**
 * @module reads-resolve
 * WHICH read adapter a Node process should use — the environment-sniffing half
 * of the read seam, kept out of `reads.ts` so the seam itself stays portable.
 *
 * This module is **Node-only** and deliberately so: the auto-detect branch has
 * to look at the filesystem (`existsSync` on the mirror clone), which is the one
 * thing in the old `reads.ts` that could not be deferred behind an
 * `await import()` — `resolveReads()` is synchronous by contract, because
 * verbspec calls a verb's `deps` synchronously (`v.deps?.()`).
 *
 * So the split is by RUNTIME rather than by concern: `reads.ts` holds the
 * adapters and the seam (portable — a Worker can import it); this holds the
 * "look around and guess" policy (Node). An entrypoint that has a filesystem
 * installs it via `setReadsFactory(resolveReads)`; one that does not simply
 * never imports this file and keeps the DoltHub default.
 */

import { existsSync } from "node:fs";
import { MIRROR_DIR } from "./mirror-dir.ts";
import { dolthubReads, localDoltReads, serverReads, type SchedulerReads } from "./reads.ts";

/**
 * Pick the adapter. Priority: FDS_READS override → a running dolt-server if
 * DOLT_HOST is set → a local clone if present → DoltHub (zero-infra default).
 *
 * Called per use rather than once at startup, so `FDS_READS` still takes effect
 * if it changes within a process (which is what the tests and the CLI expect).
 */
export function resolveReads(): SchedulerReads {
  switch (process.env.FDS_READS) {
    case "server": return serverReads;
    case "local": return localDoltReads;
    case "dolthub": return dolthubReads;
  }
  if (process.env.DOLT_HOST) return serverReads;
  return existsSync(`${MIRROR_DIR}/.dolt`) ? localDoltReads : dolthubReads;
}
