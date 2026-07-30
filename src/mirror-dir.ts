/**
 * @module mirror-dir
 * Where the Dolt mirror clone lives — the one constant `reads.ts` needs from the
 * mirror without needing the mirror ITSELF.
 *
 * It is its own module for a dependency reason, not a tidiness one. `mirror.ts`
 * statically pulls in `node:child_process`, `board.ts` (and so the GitHub CLI
 * path), the claim planes, and the lease client. `resolveReads()` needs exactly
 * one string from all of that — the clone path it probes to decide whether a
 * local mirror exists. Importing `MIRROR_DIR` from `mirror.ts` therefore made
 * the DoltHub read path, which touches none of those things, load all of them.
 *
 * Splitting the constant out is what lets `reads.ts` load the local and server
 * adapters lazily: with this import gone, nothing in its static graph reaches
 * `mirror.ts` or `dolt-server.ts` (and so `mysql2`) any more.
 */

export const MIRROR_DIR = new URL("../mirror", import.meta.url).pathname;
