/**
 * What the board does NOT cover.
 *
 * `next` reports `ready: N`, and a caller reasonably reads that as "N is the
 * open work." It is not: it is the open work Front Desk can SEE. The webhook
 * skips private repos by design (front-desk-webhook README; infra#138/#145), so
 * a private repo contributes zero rows to the mirror — not "blocked", not
 * "untriaged", simply absent.
 *
 * That absence cannot be derived from the data. A repo with no rows and a repo
 * that does not exist look identical downstream, so the only way `next` can warn
 * about it is to carry a declaration. This file is that declaration.
 *
 * It cost a full session pass to rediscover (#86): a caller ran `next`, got
 * `ready: 228` and a confident pick, and had no way to know the repo holding the
 * actual next action was not in the count.
 *
 * ADDING AN ENTRY: only for a repo deliberately outside the board's reach.
 * A repo that is merely untriaged or fully Done belongs nowhere near here — it
 * IS covered, and saying otherwise would make this notice noise that callers
 * learn to skip.
 */

export interface CoverageGap {
  /** The repo the board cannot see. */
  readonly repo: string;
  /** Why it is out of scope — the mechanism, not a restatement of "private". */
  readonly reason: string;
  /** Where its ranking actually lives, so the notice is actionable. */
  readonly ranking: string;
}

export const COVERAGE_GAPS: readonly CoverageGap[] = [
  {
    repo: "infra",
    reason: "private — the webhook skips private repos (infra#138/#145)",
    // The body of that issue goes stale; its latest comment is the live state.
    // Saying so here is the difference between a caller reading a checklist that
    // is wrong in at least one item and one that is current.
    ranking: "infra#101 (latest comment supersedes the body)",
  },
];

/** One line per gap, for the `next` render. Empty when the board covers everything. */
export function renderCoverage(gaps: readonly CoverageGap[] = COVERAGE_GAPS): string[] {
  if (gaps.length === 0) return [];
  return [
    `\n! ready counts only what Front Desk can see. Not covered:`,
    ...gaps.map((g) => `  ${g.repo} — ${g.reason}\n    its ranking: ${g.ranking}`),
  ];
}
