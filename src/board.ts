/**
 * @module board
 * The seam to the LIVE Front Desk (org project #2). Reads through `gh` and maps
 * board items to the policy's PriorityInput, so the verified scheduler can rank
 * the real ready queue.
 *
 * Read-only: this module never writes the board.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import type { BeadKind, BeadState, PriorityInput } from "./policy.ts";

const pexecFile = promisify(execFile);

/** Where a live fetch is cached, so repeated reads don't re-spend GraphQL. */
const CACHE_PATH = new URL("../.tools/board-cache.json", import.meta.url).pathname;

export const DEFAULT_ORG = "bounded-systems";
export const DEFAULT_PROJECT = 2;

/** One raw item as `gh project item-list --format json` returns it. */
export interface RawBoardItem {
  readonly id?: string; // the project-item id (PVTI_…), needed to write fields
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
  readonly id: string; // project-item id (PVTI_…)
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
  if (typeof number !== "number" || !raw.id) return null;
  return {
    id: raw.id,
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

function parseItems(stdout: string): BoardItem[] {
  const parsed = JSON.parse(stdout) as { items?: RawBoardItem[] };
  return (parsed.items ?? []).map(normalize).filter((x): x is BoardItem => x !== null);
}

/**
 * Fetch the live board via `gh` (requires `gh auth` with `read:project`).
 * A successful fetch is cached to `.tools/board-cache.json`. Pass
 * `cacheMinutes` to reuse a fresh cache instead of re-spending GraphQL — the
 * item-list query is the expensive call, so reads should prefer the cache.
 */
export async function fetchBoardItems(
  org = DEFAULT_ORG,
  project = DEFAULT_PROJECT,
  limit = 2000,
  cacheMinutes = 0,
): Promise<BoardItem[]> {
  if (cacheMinutes > 0 && existsSync(CACHE_PATH)) {
    const ageMin = (Date.now() - statSync(CACHE_PATH).mtimeMs) / 60_000;
    if (ageMin < cacheMinutes) return parseItems(readFileSync(CACHE_PATH, "utf8"));
  }
  const { stdout } = await pexecFile("gh", [
    "project", "item-list", String(project),
    "--owner", org, "--format", "json", "--limit", String(limit),
  ], { maxBuffer: 64 * 1024 * 1024 });
  try { writeFileSync(CACHE_PATH, stdout); } catch { /* cache is best-effort */ }
  return parseItems(stdout);
}

// --- WRITE PATH (only reached behind an explicit --apply) ---

export interface ProjectMeta {
  readonly projectId: string;
  readonly fieldId: Record<string, string>; // field name → PVTF_… id
}

/** Resolve the project node id and the custom-field ids needed to write. */
export async function fetchProjectMeta(org = DEFAULT_ORG, project = DEFAULT_PROJECT): Promise<ProjectMeta> {
  const view = JSON.parse(
    (await pexecFile("gh", ["project", "view", String(project), "--owner", org, "--format", "json"])).stdout,
  ) as { id?: string };
  const fields = JSON.parse(
    (await pexecFile("gh", ["project", "field-list", String(project), "--owner", org, "--format", "json"], {
      maxBuffer: 8 * 1024 * 1024,
    })).stdout,
  ) as { fields?: { id: string; name: string }[] };
  const fieldId: Record<string, string> = {};
  for (const f of fields.fields ?? []) fieldId[f.name] = f.id;
  if (!view.id) throw new Error("could not resolve project id");
  return { projectId: view.id, fieldId };
}

/** Write a single number custom field on one item. */
export async function setNumberField(
  meta: ProjectMeta,
  itemId: string,
  fieldName: string,
  value: number,
): Promise<void> {
  const fieldId = meta.fieldId[fieldName];
  if (!fieldId) throw new Error(`unknown field "${fieldName}"`);
  await pexecFile("gh", [
    "project", "item-edit",
    "--id", itemId,
    "--project-id", meta.projectId,
    "--field-id", fieldId,
    "--number", String(value),
  ]);
}
