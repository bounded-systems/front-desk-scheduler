/**
 * @module reads
 * The read seam — where scheduling data comes from, abstracted so no consumer
 * hard-codes it (mirrors gh-project-room's `resolveReads()`). Two adapters, both
 * off the GitHub API (zero budget); pick by environment:
 *
 *   local    — `dolt sql` on the cloned mirror (or a `dolt sql-server` image):
 *              full SQL, no row cap, fast. Best for a fleet/hot path.
 *   dolthub  — the public DoltHub HTTP SQL API: no clone, no creds, but a
 *              1000-row cap (fine — the scheduler only reads non-Done items).
 *
 * FDS_READS=local|dolthub forces one; otherwise auto: local if a mirror clone is
 * present, else DoltHub.
 */

import { existsSync } from "node:fs";
import { MIRROR_DIR, mirrorMeta, readMirrorScheduling } from "./mirror.ts";
import { meta as dolthubMeta, readScheduling as dolthubScheduling, type SchedulingItem } from "./dolthub.ts";

export type { SchedulingItem };

export interface ReadMeta {
  readonly syncedAt: string;
  readonly commit: string;
  readonly source: "local" | "dolthub";
}

export interface SchedulerReads {
  readonly source: "local" | "dolthub";
  readScheduling(): Promise<SchedulingItem[]>;
  meta(): Promise<ReadMeta | null>;
}

export const dolthubReads: SchedulerReads = {
  source: "dolthub",
  readScheduling: () => dolthubScheduling(),
  meta: async () => {
    const m = await dolthubMeta();
    return m ? { ...m, source: "dolthub" } : null;
  },
};

export const localDoltReads: SchedulerReads = {
  source: "local",
  readScheduling: () => readMirrorScheduling(),
  meta: async () => {
    const m = await mirrorMeta();
    return m ? { ...m, source: "local" } : null;
  },
};

/** Pick the adapter: env override, else local clone if present, else DoltHub. */
export function resolveReads(): SchedulerReads {
  const forced = process.env.FDS_READS;
  if (forced === "local") return localDoltReads;
  if (forced === "dolthub") return dolthubReads;
  return existsSync(`${MIRROR_DIR}/.dolt`) ? localDoltReads : dolthubReads;
}
