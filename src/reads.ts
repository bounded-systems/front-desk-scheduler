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
import {
  MIRROR_DIR,
  mirrorMeta,
  readMirrorAllItems,
  readMirrorScheduling,
  readMirrorTypedEdges,
} from "./mirror.ts";
import {
  meta as dolthubMeta,
  readAllItems as dolthubAllItems,
  readScheduling as dolthubScheduling,
  readTypedEdges as dolthubTypedEdges,
} from "./dolthub.ts";
import {
  meta as serverMeta,
  readAllItems as serverAllItems,
  readScheduling as serverScheduling,
  readTypedEdges as serverTypedEdges,
} from "./dolt-server.ts";
import type { RawItem, RawTypedEdge, ScheduleRead, SchedulingItem } from "./scheduling.ts";

export type { ScheduleRead, SchedulingItem };

export type ReadSource = "local" | "dolthub" | "server";

export interface ReadMeta {
  readonly syncedAt: string;
  readonly commit: string;
  readonly source: ReadSource;
}

export interface SchedulerReads {
  readonly source: ReadSource;
  /** The queue AND the commit it was derived from — see ScheduleRead. */
  readScheduling(): Promise<ScheduleRead>;
  /** Typed dep edges (with edge_type) — the GH-canonical dep-graph source. */
  readTypedEdges(): Promise<RawTypedEdge[]>;
  /** ALL items incl Done — the `bd list --all` replacement (the `list` verb). */
  readAllItems(): Promise<RawItem[]>;
  meta(): Promise<ReadMeta | null>;
}

export const dolthubReads: SchedulerReads = {
  source: "dolthub",
  readScheduling: () => dolthubScheduling(),
  readTypedEdges: () => dolthubTypedEdges(),
  readAllItems: () => dolthubAllItems(),
  meta: async () => {
    const m = await dolthubMeta();
    return m ? { ...m, source: "dolthub" } : null;
  },
};

export const localDoltReads: SchedulerReads = {
  source: "local",
  // The local clone has no pinning story (dsql is a process per statement), so
  // it reports `at: null` — honestly "cannot say", not a fabricated stamp.
  readScheduling: async () => ({ items: await readMirrorScheduling(), at: null }),
  readTypedEdges: () => readMirrorTypedEdges(),
  readAllItems: () => readMirrorAllItems(),
  meta: async () => {
    const m = await mirrorMeta();
    return m ? { ...m, source: "local" } : null;
  },
};

/** A running `dolt sql-server` over the MySQL protocol (the "dolt image"). */
export const serverReads: SchedulerReads = {
  source: "server",
  readScheduling: () => serverScheduling(),
  readTypedEdges: () => serverTypedEdges(),
  readAllItems: () => serverAllItems(),
  meta: async () => {
    const m = await serverMeta();
    return m ? { ...m, source: "server" } : null;
  },
};

/**
 * Pick the adapter. Priority: FDS_READS override → a running dolt-server if
 * DOLT_HOST is set → a local clone if present → DoltHub (zero-infra default).
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
