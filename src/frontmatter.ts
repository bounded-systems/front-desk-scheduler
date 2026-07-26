/**
 * @module frontmatter
 * Typed frontmatter for issue bodies — the structured write-surface for
 * scheduling metadata. Large unstructured markdown stays free-form; the
 * machine-readable contract rides in a YAML frontmatter block, ENUM-forced:
 *
 *   ---
 *   kind: task            # epic | room | door | task
 *   effort: 3             # 1..10
 *   value: 60             # 0..100
 *   depends-on: [prx#119, gh-project-room#83]
 *   ---
 *
 * machine-schema discipline: closed const tuples + a parse seam that REJECTS
 * invalid values into findings (surfaced as shape check D5) rather than
 * silently coercing. Author-declared values outrank heuristic estimates.
 * Zero-dep: the accepted YAML subset (scalar + inline list) is parsed here.
 */

import type { BeadKind } from "./policy.ts";

export const FM_KINDS = ["epic", "room", "door", "task"] as const;

export interface DepRef {
  readonly repo: string;
  readonly number: number;
}

export interface FrontMatter {
  readonly kind?: BeadKind;
  readonly effort?: number;
  readonly value?: number;
  readonly dependsOn: readonly DepRef[];
}

export interface FrontMatterFinding {
  readonly key: string;
  readonly message: string;
}

export interface FrontMatterResult {
  readonly present: boolean;
  readonly fm: FrontMatter;
  readonly findings: readonly FrontMatterFinding[];
}

const EMPTY: FrontMatter = { dependsOn: [] };

const DEP_RE = /^([A-Za-z0-9._-]+)#(\d+)$/;

/** Parse the leading frontmatter block of an issue body. Absent block ⇒ empty, no findings. */
export function parseFrontMatter(body: string): FrontMatterResult {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(body.trimStart());
  if (!m) return { present: false, fm: EMPTY, findings: [] };

  const findings: FrontMatterFinding[] = [];
  let kind: BeadKind | undefined;
  let effort: number | undefined;
  let value: number | undefined;
  const dependsOn: DepRef[] = [];

  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (!kv) continue; // non-contract frontmatter lines are none of our business
    const [, key, raw] = kv;
    const val = raw.replace(/\s+#.*$/, "").trim(); // strip trailing comment

    switch (key) {
      case "kind": {
        if ((FM_KINDS as readonly string[]).includes(val)) kind = val as BeadKind;
        else findings.push({ key, message: `kind "${val}" not in {${FM_KINDS.join("|")}}` });
        break;
      }
      case "effort": {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 1 && n <= 10) effort = n;
        else findings.push({ key, message: `effort "${val}" not in 1..10` });
        break;
      }
      case "value": {
        const n = Number(val);
        if (Number.isFinite(n) && n >= 0 && n <= 100) value = n;
        else findings.push({ key, message: `value "${val}" not in 0..100` });
        break;
      }
      case "depends-on": {
        const inner = /^\[(.*)\]$/.exec(val);
        const parts = (inner ? inner[1].split(",") : [val]).map((s) => s.trim()).filter(Boolean);
        for (const p of parts) {
          const d = DEP_RE.exec(p);
          if (d) dependsOn.push({ repo: d[1], number: Number(d[2]) });
          else findings.push({ key, message: `dep "${p}" is not repo#number` });
        }
        break;
      }
      default:
        break; // unknown keys: not ours (frontmatter may serve other tools)
    }
  }

  return { present: true, fm: { kind, effort, value, dependsOn }, findings };
}
