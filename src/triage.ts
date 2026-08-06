/**
 * triage — retire an item the board still ranks but the work no longer needs.
 *
 * The shape this exists for was measured on 2026-08-05/06: four of the top five
 * executable picks were already-merged work (prx#931→#747, #902→#748, #945→#851)
 * or already-fixed issues (prx#21), each costing ~15 tool calls to retire —
 * claim, comment, close, release, with a poll-and-grep of a job log around every
 * window round-trip. The judgment in each was one sentence; the ceremony was
 * everything else.
 *
 * So this module is the ceremony, and deliberately NOT the judgment. The caller
 * supplies `evidence` — the proof that the work is already done — and this code
 * never inspects a diff, compares a branch, or decides that an item is a corpse.
 * A window that could reach that conclusion itself would be an auto-closer that
 * trusts its caller, which is a different and much worse thing.
 *
 * Two properties are load-bearing, and both are pinned by test/triage.test.ts:
 *
 *   1. THE CLAIM IS THE GUARD. Triage runs only on an item the lease plane
 *      granted. `not-eligible` — the ready rule refusing a Done, closed or
 *      blocked item — aborts before any write. That is the same refusal
 *      `claim-ticket.yml` already produces (#127); reusing it means triage
 *      cannot close something the scheduler considers finished or unreachable,
 *      and it costs no new definition (#59).
 *
 *   2. A FAILED CLOSE RELEASES `released`, NOT `completed`. The release status
 *      is derived from what actually happened, so an item whose close failed
 *      returns to the queue for someone to retry rather than being recorded as
 *      finished. Recording `completed` on a failed close would launder a
 *      transport error into a triage verdict.
 */

/** Why the item is being retired. Chosen by the caller, rendered into the
 *  comment, and mapped to GitHub's own close taxonomy where one exists. */
export type TriageReason = "superseded" | "resolved" | "not-planned";

export interface TriageInput {
  /** `repo#number` — triage is always about a NAMED item. There is no
   *  "triage whatever ranks top": the caller has already done the judgment on
   *  a specific thing, and latching the top pick instead would retire a
   *  different item than the one they investigated (#127, the same trap). */
  readonly item: string;
  readonly reason: TriageReason;
  /** The proof. Required and non-empty — this is the safety gate, since it is
   *  the only part a reviewer can check after the fact. */
  readonly evidence: string;
  /** Optional cross-reference, e.g. `#747`, folded into the comment headline. */
  readonly supersededBy?: string;
  readonly agentLabel: string;
}

/** The claim verb's rendered JSON — the OUTPUT CONTRACT a workflow caller
 *  receives, not the typed value `claimLease()` returns in-process. #114 is why
 *  that distinction is spelled out: every test called the function directly, so
 *  nothing exercised the shape a workflow actually reads, and the docs described
 *  a `fencing` field that did not exist on it. */
export interface ClaimVerdict {
  readonly won: boolean;
  readonly verdict?: "granted" | "not-granted" | "not-eligible" | "not-in-mirror";
  readonly itemId?: string;
  readonly number?: number;
  readonly repository?: string;
  readonly title?: string;
  readonly fencing?: number;
  readonly reason?: string;
}

export interface TriageTarget {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly itemId: string;
  readonly fencing: number;
}

export type TriagePlan =
  | { readonly action: "act"; readonly target: TriageTarget; readonly comment: string }
  | {
      readonly action: "abort";
      readonly why: "not-granted" | "not-eligible" | "not-in-mirror" | "unusable-verdict";
      readonly detail: string;
    };

export const DEFAULT_ORG = "bounded-systems";

const REASON_HEADLINE: Record<TriageReason, string> = {
  superseded: "superseded",
  resolved: "resolved by later work",
  "not-planned": "not planned",
};

/**
 * GitHub's `state_reason` taxonomy is coarser than ours. `resolved` maps to
 * `completed` because the work exists; `superseded` and `not-planned` both map
 * to `not_planned` because THIS item produced nothing — the change that closed
 * it came from elsewhere. Pull requests take no state_reason at all.
 */
export function stateReasonFor(reason: TriageReason): "completed" | "not_planned" {
  return reason === "resolved" ? "completed" : "not_planned";
}

/** `repo#number` or `owner/repo#number`. Returns null when it does not parse —
 *  a malformed selector is an ERROR, never a refusal, for the same reason
 *  `claim-ticket.yml` treats it that way: "I cannot parse what you typed" is
 *  not a fact about the board. */
export function parseItemSelector(
  selector: string,
  org = DEFAULT_ORG,
): { owner: string; repo: string; number: number } | null {
  const m = /^(?:([A-Za-z0-9_.-]+)\/)?([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(selector.trim());
  if (!m) return null;
  return { owner: m[1] ?? org, repo: m[2]!, number: Number(m[3]) };
}

export function renderTriageComment(input: TriageInput, claim: ClaimVerdict): string {
  const headline = REASON_HEADLINE[input.reason];
  const ref = input.supersededBy?.trim();
  const lead = ref
    ? `Triage verdict: **${headline} by ${ref}**, closing.`
    : `Triage verdict: **${headline}**, closing.`;

  // The lease is named in the comment because it is the audit trail a reader
  // needs to answer "who decided this, and did they hold the item?" — the
  // question the whole claiming apparatus exists to make answerable.
  const provenance =
    `_Retired through the triage window under Front Desk lease ` +
    `\`gha/${input.agentLabel}\`, fencing ${claim.fencing ?? "?"}._`;

  return [lead, "", input.evidence.trim(), "", provenance].join("\n");
}

/**
 * Decide from the claim verdict alone whether to write anything.
 *
 * Note what is NOT consulted: the item's current GitHub state. The claim
 * already answered that through `isEligible` — a closed item is not
 * schedulable, so it cannot be granted — and re-deriving it here from a second
 * source would be a second definition of the ready rule (#59).
 */
export function planTriage(
  claim: ClaimVerdict,
  input: TriageInput,
  org = DEFAULT_ORG,
): TriagePlan {
  if (!claim.won) {
    const why =
      claim.verdict === "not-eligible" || claim.verdict === "not-in-mirror"
        ? claim.verdict
        : "not-granted";
    return { action: "abort", why, detail: claim.reason ?? why };
  }

  // A granted verdict missing the fields the write needs is not a refusal — it
  // is a verdict we cannot act on, and guessing the target from the input
  // selector instead would write to an item the lease plane never named.
  const selector = parseItemSelector(input.item, org);
  const repo = claim.repository ?? selector?.repo;
  const number = claim.number ?? selector?.number;
  if (!claim.itemId || typeof claim.fencing !== "number" || !repo || !number) {
    return {
      action: "abort",
      why: "unusable-verdict",
      detail: "granted verdict is missing itemId, fencing, repository or number",
    };
  }

  return {
    action: "act",
    target: {
      owner: selector?.owner ?? org,
      repo,
      number,
      itemId: claim.itemId,
      fencing: claim.fencing,
    },
    comment: renderTriageComment(input, claim),
  };
}

/**
 * What the release should record, given what actually happened.
 *
 * `completed` is a claim about the ITEM being finished, so it is reserved for
 * the path where the close landed. Every other path hands the item back with
 * `released`, which returns it to the queue — the honest outcome when the
 * ceremony half-ran, and the one that lets a later session retry without
 * fighting a lease recorded as done.
 */
export function releaseStatusFor(outcome: {
  commented: boolean;
  closed: boolean;
}): "completed" | "released" {
  return outcome.closed ? "completed" : "released";
}
