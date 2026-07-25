/**
 * @module estimate
 * A transparent heuristic for the scheduler's missing inputs: Effort + Value.
 *
 * The real board has effort/value empty (0/1251), so `prioritize` runs its
 * degenerate fallback. This module assigns *defensible placeholder* estimates
 * from an item's Kind and title signals, so the WSJF-style ranking becomes
 * meaningful. It is intentionally simple and inspectable — the eventual upgrade
 * is agent-estimated scoring at intake (see docs), which drops in behind the
 * same `estimate()` seam.
 *
 * Pure: title + kind in, {effort, value} out. No I/O.
 */

import type { BeadKind } from "./policy.ts";

export interface Estimate {
  readonly effort: number; // points, clamped 1..10
  readonly value: number; // 0..100
  readonly rationale: string;
}

const EFFORT_BASE: Record<BeadKind, number> = { epic: 8, room: 5, door: 4, task: 3 };
const VALUE_BASE: Record<BeadKind, number> = { epic: 60, room: 50, door: 50, task: 40 };

// Title signals → adjustments. Kept small and legible on purpose.
const BIG = /\b(spike|epic|productioni|harden|migrat|refactor|substrate|rewrite|scaling|multi-tenant)\b/i;
const SMALL = /\b(chore|docs?|note|typo|comment|readme|rename|bump)\b/i;
const BUGFIX = /\b(bug|fix|hang|stale|broken|regression)\b/i;
const HIGH_VALUE = /\b(security|auth|overspend|deadlock|blocker|blocking|critical|data.?loss|correctness|credential|secret|isolation)\b/i;
const LOW_VALUE = /\b(chore|docs?|typo|note|cleanup|comment)\b/i;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function estimate(kind: BeadKind, title: string): Estimate {
  const notes: string[] = [`kind=${kind}`];

  let effort = EFFORT_BASE[kind];
  if (BIG.test(title)) { effort += 2; notes.push("big+2"); }
  if (BUGFIX.test(title)) { effort -= 1; notes.push("bugfix-1"); }
  if (SMALL.test(title)) { effort = Math.min(effort, 2); notes.push("small≤2"); }
  effort = clamp(effort, 1, 10);

  let value = VALUE_BASE[kind];
  if (HIGH_VALUE.test(title)) { value += 30; notes.push("high-value+30"); }
  if (BUGFIX.test(title)) { value += 15; notes.push("bug+15"); }
  if (LOW_VALUE.test(title)) { value -= 20; notes.push("low-value-20"); }
  value = clamp(value, 0, 100);

  return { effort, value, rationale: notes.join(" ") };
}
