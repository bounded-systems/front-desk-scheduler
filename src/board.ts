/**
 * @module board
 * The seam to the LIVE Front Desk (org project #2). Reads through `gh` and maps
 * board items to the policy's PriorityInput, so the verified scheduler can rank
 * the real ready queue.
 *
 * Read-only: this module never writes the board.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BeadKind, BeadState, PriorityInput } from "./policy.ts";

const pexecFile = promisify(execFile);

export const DEFAULT_ORG = "bounded-systems";
export const DEFAULT_PROJECT = 2;

/** One raw item as `gh project item-list --format json` returns it. */
export interface RawBoardItem {
  readonly content?: { readonly number?: number; readonly type?: string };
  readonly title?: string;
  readonly repository?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly effort?: number;
  readonly value?: number;
  readonly score?: number;
  readonly "depends on"?: string;
}

export interface BoardItem {
  readonly number: number;
  readonly title: string;
  readonly repository: string;
  readonly status: string;
  readonly kind: BeadKind;
  readonly effort: number;
  readonly value: number;
  readonly dependsOn: readonly number[];
}

const KINDS: readonly BeadKind[] = ["epic", "room", "door", "task"];

function toKind(raw: string | undefined): BeadKind {
  return raw && (KINDS as readonly string[]).includes(raw) ? (raw as BeadKind) : "task";
}

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

/** Parse a free-text "Depends on" like "#6, #7" into issue numbers. */
export function parseDependsOn(text: string | undefined): number[] {
  if (!text) return [];
  return [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

export function normalize(raw: RawBoardItem): BoardItem | null {
  const number = raw.content?.number;
  if (typeof number !== "number") return null;
  return {
    number,
    title: raw.title ?? `#${number}`,
    repository: (raw.repository ?? "").replace(/.*\//, ""),
    status: raw.status ?? "Todo",
    kind: toKind(raw.kind),
    effort: raw.effort ?? 0,
    value: raw.value ?? 0,
    dependsOn: parseDependsOn(raw["depends on"]),
  };
}

/**
 * Map the whole board to PriorityInputs. `openBlockers` and `unblocks` are
 * derived from the `Depends on` graph across ALL items (so they're meaningful
 * the moment that field is populated; today it's empty → both are 0, which is
 * exactly why the ranking degenerates).
 */
export function toPriorityInputs(items: readonly BoardItem[]): PriorityInput[] {
  const statusByNumber = new Map(items.map((i) => [i.number, i.status]));
  const unblocksCount = new Map<number, number>();
  for (const i of items) {
    for (const dep of i.dependsOn) {
      unblocksCount.set(dep, (unblocksCount.get(dep) ?? 0) + 1);
    }
  }
  return items.map((i) => {
    const openBlockers = i.dependsOn.filter((d) => statusByNumber.get(d) !== "Done").length;
    return {
      number: i.number,
      title: i.title,
      kind: i.kind,
      state: statusToState(i.status),
      effort: i.effort,
      value: i.value,
      openBlockers,
      unblocks: unblocksCount.get(i.number) ?? 0,
    };
  });
}

/** Fetch the live board via `gh`. Requires `gh auth` with `read:project`. */
export async function fetchBoardItems(
  org = DEFAULT_ORG,
  project = DEFAULT_PROJECT,
  limit = 2000,
): Promise<BoardItem[]> {
  const { stdout } = await pexecFile("gh", [
    "project",
    "item-list",
    String(project),
    "--owner",
    org,
    "--format",
    "json",
    "--limit",
    String(limit),
  ], { maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { items?: RawBoardItem[] };
  return (parsed.items ?? []).map(normalize).filter((x): x is BoardItem => x !== null);
}
