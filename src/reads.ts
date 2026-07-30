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
import { MIRROR_DIR } from "./mirror-dir.ts";
import {
  meta as dolthubMeta,
  readAllItems as dolthubAllItems,
  readScheduling as dolthubScheduling,
  readTypedEdges as dolthubTypedEdges,
} from "./dolthub.ts";
import type { RawItem, RawTypedEdge, ScheduleRead, SchedulingItem } from "./scheduling.ts";

// `mirror.ts` and `dolt-server.ts` are loaded ON DEMAND, from inside the adapter
// methods below — never at module scope. They are the expensive half of this
// seam: `mirror.ts` reaches `node:child_process`, `board.ts` and the GitHub CLI
// path, the claim planes and the lease client; `dolt-server.ts` pulls `mysql2`.
// A static import of either meant that choosing the DoltHub adapter — the
// zero-infra default, and the only one a cloud session can use — still paid for
// both. Every method here is already async, so the `await import()` costs a
// resolved promise and changes no signature.

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
  /** ALL items incl Done (the `list` verb). */
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

const mirror = () => import("./mirror.ts");
const doltServer = () => import("./dolt-server.ts");

export const localDoltReads: SchedulerReads = {
  source: "local",
  // The local clone has no pinning story (dsql is a process per statement), so
  // it reports `at: null` — honestly "cannot say", not a fabricated stamp.
  readScheduling: async () => ({ items: await (await mirror()).readMirrorScheduling(), at: null }),
  readTypedEdges: async () => (await mirror()).readMirrorTypedEdges(),
  readAllItems: async () => (await mirror()).readMirrorAllItems(),
  meta: async () => {
    const m = await (await mirror()).mirrorMeta();
    return m ? { ...m, source: "local" } : null;
  },
};

/** A running `dolt sql-server` over the MySQL protocol (the "dolt image"). */
export const serverReads: SchedulerReads = {
  source: "server",
  readScheduling: async () => (await doltServer()).readScheduling(),
  readTypedEdges: async () => (await doltServer()).readTypedEdges(),
  readAllItems: async () => (await doltServer()).readAllItems(),
  meta: async () => {
    const m = await (await doltServer()).meta();
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
