/**
 * @module reads
 * The read seam — where scheduling data comes from, abstracted so no consumer
 * hard-codes it (mirrors gh-project-room's `resolveReads()`). Two adapters, both
 * off the GitHub API (zero budget); pick by environment:
 *
 *   local    — `dolt sql` on the cloned mirror (or a `dolt sql-server` image):
 *              full SQL, no row cap, fast. Best for a fleet/hot path.
 *   dolthub  — the public DoltHub HTTP SQL API: no clone, no creds, but a
 *              1000-row PER-QUERY cap.
 *
 * That cap used to carry the note "fine — the scheduler only reads non-Done
 * items". #59 listed confirming it as an open scope item; #88 is what confirming
 * it found. The claim was never true of `list`, whose entire purpose is every
 * item INCLUDING Done, and it died silently at whatever moment the board's
 * lifetime count crossed 1000 (1531 rows by 2026-07-31). It still holds for
 * `next` and `graph`, which read non-Done only — ~233 rows today — so the honest
 * statement is per-verb, not per-plane:
 *
 *   next / graph  — unpaginated, and fine while non-Done stays small. A guard in
 *                   `dolthub.query` now fails these at 900 rows rather than
 *                   letting them hit the wall the way `list` did.
 *   list          — paginated and pinned; correct at any board size.
 *
 * FDS_READS=local|dolthub forces one; otherwise auto: local if a mirror clone is
 * present, else DoltHub.
 */

import {
  type AllItemsRead,
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

export type { AllItemsRead, ScheduleRead, SchedulingItem };

/** How `readAllItems` is narrowed. Query-side where the plane has a row cap. */
export interface ItemScope {
  readonly repo?: string;
}

/** Apply a scope to already-read rows. The uncapped planes (local clone, dolt
 *  sql-server) have nothing to gain from narrowing the query — the cap is a
 *  DoltHub HTTP property — but they still owe the caller the same answer. */
function scoped(items: RawItem[], scope: ItemScope): RawItem[] {
  return scope.repo ? items.filter((i) => i.repository === scope.repo) : items;
}

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
  /**
   * Typed dep edges (with edge_type) — the GH-canonical dep-graph source.
   * `at` pins the read to a commit so it can be paired with an item read from
   * the same board state; planes that cannot pin ignore it.
   */
  readTypedEdges(at?: string | null): Promise<RawTypedEdge[]>;
  /** ALL items incl Done (the `list` verb), and the commit they were read at. */
  readAllItems(scope?: ItemScope): Promise<AllItemsRead>;
  meta(): Promise<ReadMeta | null>;
}

export const dolthubReads: SchedulerReads = {
  source: "dolthub",
  readScheduling: () => dolthubScheduling(),
  readTypedEdges: (at) => dolthubTypedEdges("main", at),
  readAllItems: (scope = {}) => dolthubAllItems("main", scope),
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
  readAllItems: async (scope = {}) => ({
    items: scoped(await (await mirror()).readMirrorAllItems(), scope),
    at: null,
  }),
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
  readAllItems: async (scope = {}) => ({
    items: scoped(await (await doltServer()).readAllItems(), scope),
    at: null,
  }),
  meta: async () => {
    const m = await (await doltServer()).meta();
    return m ? { ...m, source: "server" } : null;
  },
};

// ── the installed default ────────────────────────────────────────────────────
// WHICH adapter to use is a property of the ENTRYPOINT, not of the verbs. A CLI
// can look at the filesystem and guess (`reads-resolve.ts`); a Worker cannot,
// and must not pay for the import that could. So verbs ask for "the current
// read plane" and an entrypoint decides what that is.
//
// This replaced a direct `resolveReads()` call inside every verb, which baked
// Node's environment-sniffing into the verb module and made it unimportable
// anywhere without `node:fs`. It cannot be an `await import()` instead: verbspec
// calls `deps` synchronously (`v.deps?.()`), so the choice has to be resolvable
// without awaiting.
//
// The default is DoltHub — the only adapter that runs anywhere, needs no clone
// and no credential. An entrypoint with a filesystem overrides it in one line.

/** A factory, not a value: `resolveReads` re-reads env on every call, and that
 *  per-call behaviour is what the CLI and the tests expect. */
let readsFactory: () => SchedulerReads = () => dolthubReads;

/**
 * Install the process-wide read-plane factory. Node entrypoints call this with
 * `resolveReads` from `./reads-resolve.ts`; a Worker leaves it alone.
 */
export function setReadsFactory(factory: () => SchedulerReads): void {
  readsFactory = factory;
}

/** The read plane this process should use right now. */
export function currentReads(): SchedulerReads {
  return readsFactory();
}
