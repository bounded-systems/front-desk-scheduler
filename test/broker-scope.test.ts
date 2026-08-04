/**
 * `broker-drift`'s granted-scope assertion (#97).
 *
 * The lane used to call a tier healthy on a non-empty token string, which says
 * the mint worked and nothing about what the credential can DO. The whole class
 * where the mint succeeds and the token is useless passed green — twice, in runs
 * 30373059795 (`createPullRequest`) and 30641376455 (`create-a-reference`, which
 * left `schema/mirror.live.sql` stale on main).
 *
 * WHY THESE TESTS EXECUTE YAML.
 *
 * `scripts/claim-ticket-summary.ts` records the general rule: an inline heredoc
 * inside a workflow is the one part CI cannot exercise, so split it out. That
 * rule is right and this is the exception, for a reason worth stating.
 *
 * `broker-drift`'s job declares `permissions: id-token: write` and calls it "the
 * ONLY capability this job holds". Naming any permission zeroes the rest, so the
 * job has no `contents: read` and never checks the repo out. Moving this logic
 * into `scripts/` would therefore cost the lane its minimal-permission property
 * — a real weakening of an authority-boundary lane — to buy testability.
 *
 * So the logic stays inline, and the tests reach in and run it. `bash` and `jq`
 * are both on the runner and on any dev box, and extracting from the file means
 * these exercise the SHIPPED code rather than a copy that can drift from it.
 * `test/claim-seam.test.ts` already reads source as text and asserts on it; this
 * goes one step further and executes what it extracts.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORKFLOW = new URL("../.github/workflows/broker-drift.yml", import.meta.url);

/**
 * Lift the scope-assertion functions out of the workflow's `run:` block.
 *
 * Bounded by the two markers rather than by line numbers, so edits above or
 * below move freely. If either marker disappears the extraction fails loudly
 * instead of silently testing an empty script — the #112 shape (a green run
 * that never reached the code under test) is exactly what this must not become.
 */
function scopeFunctions(): string {
  const yaml = readFileSync(WORKFLOW, "utf8");
  const from = yaml.indexOf("          min_perms_for() {");
  const to = yaml.indexOf("          mint_tier() {");
  assert.ok(from !== -1, "min_perms_for must exist in broker-drift.yml");
  assert.ok(to > from, "the scope functions must precede mint_tier");
  // The block is indented 10 spaces inside the YAML `run:` scalar.
  return yaml.slice(from, to).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly wide: number;
}

/** Run `assert_granted_scope <tier> <body>` exactly as the lane runs it. */
function assertScope(tier: string, body: unknown): Outcome {
  const script = [
    "set -uo pipefail",
    "scope_wide=0",
    scopeFunctions(),
    `assert_granted_scope "$1" "$2"`,
    `rc=$?`,
    `echo "SCOPE_WIDE=$scope_wide"`,
    `exit $rc`,
  ].join("\n");
  try {
    const out = execFileSync("bash", ["-c", script, "--", tier, JSON.stringify(body)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, wide: wideOf(out) };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    const out = err.stdout ?? "";
    return { code: err.status ?? -1, out, wide: wideOf(out) };
  }
}

function wideOf(out: string): number {
  return Number(/SCOPE_WIDE=(\d+)/.exec(out)?.[1] ?? -1);
}

/**
 * The `front-desk` GH_APPS entry as `cloudflare/broker/wrangler.jsonc` declares
 * it. `mintInstallationToken` sends this map as the access_tokens `permissions`
 * body, so the token is scoped DOWN to exactly this and a healthy grant matches.
 */
const GRANTED_OK = {
  organization_projects: "write",
  issues: "read",
  metadata: "read",
  pull_requests: "write",
};

test("a grant matching the registry entry passes and warns about nothing", () => {
  const r = assertScope("github-app", { token: "ghs_x", permissions: GRANTED_OK });
  assert.equal(r.code, 0);
  assert.equal(r.wide, 0, "an exact match must not warn, or the lane becomes noise nobody reads");
  assert.match(r.out, /granted scope matches the declared set/);
});

test("a DOWNGRADED permission fails the lane — the run 30373059795 shape", () => {
  // The mint succeeds, the token is real, and `createPullRequest` will 403.
  const r = assertScope("github-app", { permissions: { ...GRANTED_OK, pull_requests: "read" } });
  assert.equal(r.code, 1, "granted ⊉ declared is drift and must fail");
  assert.match(r.out, /GRANTED SCOPE DRIFT/);
  assert.match(r.out, /pull_requests\(want write, got read\)/);
  // The diagnosis must point at the registry, not at the App's own grants —
  // reading it the other way sends the fixer to the wrong place entirely.
  assert.match(r.out, /the broker did not ask for it/);
});

test("an ABSENT required permission fails, and every missing one is named", () => {
  const r = assertScope("github-app", { permissions: { issues: "read", metadata: "read" } });
  assert.equal(r.code, 1);
  assert.match(r.out, /organization_projects\(want write, got none\)/);
  assert.match(r.out, /pull_requests\(want write, got none\)/, "must not stop at the first miss");
});

test("a MORE capable grant satisfies a lower minimum — write covers read", () => {
  // Comparing levels for equality would fail a strictly-more-capable token,
  // which is not drift. It is reported as widening, below, not as a failure.
  const r = assertScope("github-app", { permissions: { ...GRANTED_OK, issues: "write" } });
  assert.equal(r.code, 0, "write must satisfy a read minimum");
});

test("an absent map is FULL-GRANT and is never reported as no-authority", () => {
  // The two mean opposite things: absent = everything the installation holds,
  // now and in future. `mintInstallationToken` is careful never to substitute
  // one for the other ("absent permissions surface as undefined, not a guess"),
  // so neither is this.
  const r = assertScope("github-app", { token: "ghs_x" });
  assert.equal(r.code, 0, "full-grant is not a missing scope");
  assert.equal(r.wide, 1);
  assert.match(r.out, /FULL-GRANT/);
  assert.match(r.out, /carries everything the installation holds/);
});

test("a WIDER grant warns without failing, and names what widened", () => {
  const r = assertScope("github-app", { permissions: { ...GRANTED_OK, contents: "write" } });
  assert.equal(r.code, 0, "a widened grant is news, not breakage");
  assert.equal(r.wide, 1);
  assert.match(r.out, /WIDER than declared/);
  assert.match(r.out, /contents:write/);
  // Same argument as EXPECTED_401's staleness warning: the declaration must not
  // be allowed to rot into one that no longer describes the tier.
  assert.match(r.out, /future NARROWING is still caught/);
});

test("a tier with no declared minimum is inert, not vacuously passing", () => {
  // cloudflare/dolthub are a different credential shape and carry no permissions
  // map. They must neither fail nor warn — but the silence has to come from
  // having no declaration, which is why min_perms_for returns empty for them.
  const r = assertScope("cloudflare", { token: "cf_x" });
  assert.equal(r.code, 0);
  assert.equal(r.wide, 0);
  assert.equal(r.out.replace(/SCOPE_WIDE=\d+\n?/, "").trim(), "", "no annotations for an undeclared tier");
});

test("the declared set omits contents:write, which this tier must never hold", () => {
  // `contents:write` lives on the separate `front-desk-schema` entry, pinned to
  // mirror-migrate.yml, specifically so `front-desk` — the one unpinned
  // multi-repo fan-in — cannot write repository contents org-wide. Expecting it
  // here would red the lane for a scope the tier is designed not to have, and
  // the 403 in run 30641376455 is easy to misread as asking for exactly that.
  const yaml = readFileSync(WORKFLOW, "utf8");
  const decl = /github-app\)\s+echo "([^"]+)"/.exec(yaml)?.[1] ?? "";
  assert.ok(decl.length > 0, "the github-app declaration must be findable");
  assert.doesNotMatch(decl, /contents/, "front-desk must not declare contents");
  for (const p of ["organization_projects:write", "issues:read", "metadata:read", "pull_requests:write"]) {
    assert.ok(decl.includes(p), `declaration must carry ${p} (the registry entry's map)`);
  }
});
