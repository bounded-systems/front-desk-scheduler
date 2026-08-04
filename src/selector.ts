/**
 * @module selector
 * Naming ONE item on the board, for the flows where the caller already knows
 * which item they mean.
 *
 * Every other read here is "ask the board what to do next", and identity is
 * positional — `next` uses the array index as the policy's `number` precisely
 * because issue numbers collide across repos. That is fine while the ranking
 * chooses. It is not fine when a human hands you an issue: #127 is the record
 * of `claim-ticket.yml` having no way to express "I intend to work #118", so
 * two sessions worked it at once with the whole lease apparatus sitting unused.
 *
 * The canonical form is therefore `repo#number` — repo-qualified, because
 * front-desk-scheduler#93 is the record of what a bare `#number` costs on a
 * board that spans repos (it cost real triage time). A bare number is accepted
 * only alongside an explicit repo scope, where the pair is still qualified.
 *
 * This module resolves TEXT to a selector. It does not touch the board, and it
 * deliberately knows nothing about eligibility — deciding whether a named item
 * may be claimed is the ready rule's job and stays the one definition #59
 * requires (`isEligible` in policy.ts).
 */

/**
 * A parsed reference to one board item.
 *
 * Exactly one of `id` / `number` is set. `id` is the ProjectV2 node id, which
 * is what a claim verdict hands back and what `bind` / `release` already take,
 * so a caller holding one from an earlier verdict can re-use it verbatim.
 */
export interface ItemSelector {
  /** ProjectV2 node id (`PVTI_…`), when the caller named the item that way. */
  readonly id?: string;
  /** Issue number, when the caller named the item as `repo#number`. */
  readonly number?: number;
  /** Repository the number belongs to. Always set when `number` is. */
  readonly repository?: string;
}

/** Thrown for text that names nothing — caller error, not a fact about the board. */
export class SelectorError extends Error {}

/**
 * A ProjectV2 node id, as GitHub mints them. Matched by PREFIX rather than by
 * exact alphabet: the opaque tail is base64-ish and not ours to constrain, and
 * a selector that rejected a valid id would be indistinguishable, to the
 * caller, from an item that is not on the board.
 */
const NODE_ID = /^PVTI_[A-Za-z0-9_-]+$/;

/**
 * `[owner/]repo#number`. The owner is accepted and dropped: `bind-ticket.yml`
 * takes its referent as `owner/repo#number`, so a caller who has learned that
 * shape should not be punished for typing it here. The board itself is single-
 * org, so the owner carries no information the repo does not.
 */
const QUALIFIED = /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#(\d+)$/;

/** A bare issue number, with or without the `#`. Needs a repo from elsewhere. */
const BARE = /^#?(\d+)$/;

/**
 * Parse an item selector.
 *
 * @param raw   what the caller typed
 * @param repo  the ambient repo scope (`--repo`), used only to qualify a bare
 *              number. It never overrides a repo spelled out in `raw` — a
 *              caller who writes `prx#931 --repo hooksmith` has contradicted
 *              themselves, and silently preferring one side would claim an
 *              item they did not name.
 */
export function parseItemSelector(raw: string, repo?: string): ItemSelector {
  const text = raw.trim();
  if (!text) throw new SelectorError("item selector is empty");

  if (NODE_ID.test(text)) return { id: text };

  const qualified = QUALIFIED.exec(text);
  if (qualified) {
    const [, , repository, number] = qualified;
    if (repo && repo !== repository) {
      throw new SelectorError(
        `item "${text}" names repo "${repository}" but --repo says "${repo}" — ` +
          "drop one of them rather than letting the tool pick",
      );
    }
    return { number: Number(number), repository };
  }

  const bare = BARE.exec(text);
  if (bare) {
    if (!repo) {
      throw new SelectorError(
        `"${text}" is not enough to name an item — issue numbers repeat across repos. ` +
          'Write it as "repo#number" (e.g. "front-desk-scheduler#127"), or pass --repo.',
      );
    }
    return { number: Number(bare[1]), repository: repo };
  }

  throw new SelectorError(
    `cannot parse "${text}" as an item — expected "repo#number", a bare number with --repo, ` +
      'or a ProjectV2 node id ("PVTI_…")',
  );
}

/** How the selector reads back in a verdict. Stable, and repo-qualified. */
export function formatSelector(sel: ItemSelector): string {
  return sel.id ?? `${sel.repository}#${sel.number}`;
}

/** Is this board row the one the selector names? */
export function selectorMatches(
  sel: ItemSelector,
  row: { id: string; number: number; repository: string },
): boolean {
  if (sel.id) return row.id === sel.id;
  return row.number === sel.number && row.repository === sel.repository;
}
