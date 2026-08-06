/**
 * Windows vs the tier that feeds them (#168).
 *
 * `broker-drift` asserts declared-vs-GRANTED: the map GitHub hands back at mint
 * time matches the map `min_perms_for` declares. It was green on 2026-08-06
 * (run 31089399737, `wide = 0`) while `triage-ticket.yml` — which states in its
 * own comments that its writes need `issues: write` — sat at zero runs, unable
 * to complete against a tier granting `issues:read`. Both sides of that
 * contradiction were files in this repo; nothing compared them. This file is
 * that comparison: declared-vs-NEEDED, statically, on every PR.
 *
 * It would have failed the PR that shipped `triage-ticket.yml`, which is the
 * point — the gap it catches is the one `broker-drift` structurally cannot,
 * because a lane that runs the mint sees what was granted, not what the
 * scripts a token is handed to will go on to call.
 *
 * THE KNOWN_GAPS LIST IS THE `EXPECTED_401` MOVE. Two gaps are live and
 * tracked (#168); the fix is in `bounded-systems/infra`, not here, so this
 * suite cannot turn red waiting for it. Each entry must (a) cite its tracking
 * issue and (b) still BE a gap — when infra adds the scope and the
 * `broker-drift` declaration is updated to match, the entry fails in the
 * other direction until it is deleted. Same ratchet, both ends: a new
 * mismatch fails as a gap, a healed one fails as a stale exception.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const WORKFLOWS_DIR = new URL("../.github/workflows/", import.meta.url);
const BROKER_DRIFT = new URL("broker-drift.yml", WORKFLOWS_DIR);

/**
 * The `front-desk` tier's declared map, read from the same `min_perms_for`
 * line `test/broker-scope.test.ts` pins — one source, not a copy that drifts.
 */
function declaredTier(): Map<string, string> {
  const yaml = readFileSync(BROKER_DRIFT, "utf8");
  const decl = /github-app\)\s+echo "([^"]+)"/.exec(yaml)?.[1] ?? "";
  assert.ok(decl.length > 0, "the github-app declaration must be findable in broker-drift.yml");
  const map = new Map<string, string>();
  for (const pair of decl.trim().split(/\s+/)) {
    const [perm, level] = pair.split(":");
    map.set(perm, level);
  }
  return map;
}

/** GitHub's permission levels are ordered; `write` satisfies a `read` need. */
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
function satisfies(tier: Map<string, string>, need: string): boolean {
  const [perm, level] = need.split(":");
  return (RANK[tier.get(perm) ?? "none"] ?? 0) >= (RANK[level] ?? Infinity);
}

/**
 * Every workflow that mints the UNPINNED `front-desk` tier, and the scopes the
 * scripts it hands that token to actually exercise. The route string is
 * quote-terminated in each mint step, which is what distinguishes this tier
 * from `front-desk-schema` and `front-desk-publish` — those are separate
 * pinned entries with their own maps, deliberately out of scope here.
 *
 * `needs` is author-maintained, like `min_perms_for` itself: when a window
 * gains a call, add the scope here in the same PR. The completeness test
 * below is what keeps the KEYS honest — a new workflow minting this tier
 * fails until it is listed.
 */
const FRONT_DESK_WINDOWS: Record<string, readonly string[]> = {
  // organization.projectV2 reads + `gh project item-edit` number-field writes
  // (src/board.ts setNumberField); `gh issue create` in syncPush's
  // captured-work flow (src/mirror.ts) — the latter is a KNOWN GAP.
  "mirror-sync.yml": ["organization_projects:write", "issues:write"],
  // Search-API delta over issues (src/mirror.ts syncDelta).
  "mirror-sync-delta.yml": ["issues:read"],
  // Reads the board both ways to compare them (scripts/board-parity.ts).
  "board-parity.yml": ["organization_projects:read"],
  // updateProjectV2ItemFieldValue (scripts/status-writeback.ts).
  "board-writeback.yml": ["organization_projects:write"],
  // Comment + close on the target repo's issue (scripts/triage-ticket.ts) —
  // the workflow's own comments name `issues: write` as the requirement.
  "triage-ticket.yml": ["issues:write"],
  // Mints only to audit the grant; the token is never handed to a script.
  "broker-drift.yml": [],
};

/** Live mismatches, each tracked. Delete the entry when the tier heals. */
const KNOWN_GAPS: readonly { workflow: string; scope: string; tracking: string }[] = [
  { workflow: "triage-ticket.yml", scope: "issues:write", tracking: "#168" },
  { workflow: "mirror-sync.yml", scope: "issues:write", tracking: "#168" },
];

const isKnownGap = (wf: string, scope: string): boolean =>
  KNOWN_GAPS.some((g) => g.workflow === wf && g.scope === scope);

/** The quote-terminated route is the discriminator between the three tiers. */
const MINTS_FRONT_DESK = /\/github\/front-desk"/;

test("every scope a front-desk window needs is satisfied by the declared tier, or tracked", () => {
  const tier = declaredTier();
  const unsatisfied: string[] = [];
  for (const [wf, needs] of Object.entries(FRONT_DESK_WINDOWS)) {
    for (const need of needs) {
      if (!satisfies(tier, need) && !isKnownGap(wf, need)) {
        unsatisfied.push(`${wf} needs ${need}`);
      }
    }
  }
  assert.deepEqual(
    unsatisfied,
    [],
    `window needs a scope the front-desk tier does not grant — either the GH_APPS entry ` +
      `in bounded-systems/infra must carry it (then update broker-drift.yml's declaration), ` +
      `or the call belongs on a pinned tier of its own (the front-desk-schema move), ` +
      `or add a KNOWN_GAPS entry citing the tracking issue: ${unsatisfied.join("; ")}`,
  );
});

test("every KNOWN_GAPS entry is still a gap — a healed tier must shrink the list", () => {
  // Same argument as EXPECTED_401 and the widening warning in broker-drift:
  // an exception that outlives its condition is how a monitor rots into one
  // nobody reads. When infra grants the scope and the declaration moves, this
  // fails until the entry — and the caveat it justified — is deleted.
  const tier = declaredTier();
  for (const gap of KNOWN_GAPS) {
    assert.ok(
      !satisfies(tier, gap.scope),
      `${gap.workflow}: ${gap.scope} is now satisfied by the declared tier — ` +
        `delete this KNOWN_GAPS entry (and close ${gap.tracking} if this was its last gap)`,
    );
    assert.match(gap.tracking, /^#\d+$/, "every known gap must cite a tracking issue");
    assert.ok(gap.workflow in FRONT_DESK_WINDOWS, `${gap.workflow} must be a listed window`);
    assert.ok(
      FRONT_DESK_WINDOWS[gap.workflow].includes(gap.scope),
      `${gap.workflow} must actually declare the need ${gap.scope} — a gap on an ` +
        `undeclared need is asserting nothing`,
    );
  }
});

test("the window map is complete both ways against the files on disk", () => {
  // A new workflow minting /github/front-desk must register its needs here —
  // otherwise this suite silently stops describing the tier's callers, which
  // is the same rot the map exists to prevent. And a listed window that stops
  // minting (or is deleted) must be removed, so the map never claims callers
  // that do not exist.
  const onDisk = new Set(
    readdirSync(WORKFLOWS_DIR)
      .filter((f) => f.endsWith(".yml"))
      .filter((f) => MINTS_FRONT_DESK.test(readFileSync(new URL(f, WORKFLOWS_DIR), "utf8"))),
  );
  const listed = new Set(Object.keys(FRONT_DESK_WINDOWS));
  assert.deepEqual(
    [...onDisk].filter((f) => !listed.has(f)).sort(),
    [],
    "workflow mints /github/front-desk but is not in FRONT_DESK_WINDOWS — declare its needs",
  );
  assert.deepEqual(
    [...listed].filter((f) => !onDisk.has(f)).sort(),
    [],
    "FRONT_DESK_WINDOWS lists a workflow that does not mint /github/front-desk — remove it",
  );
});
