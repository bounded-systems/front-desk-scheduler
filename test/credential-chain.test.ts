/**
 * The credential chain: model ⇄ monitor ⇄ config must stay in agreement.
 *
 * docs/credential-chain.md is carried by three artifacts — Delegation.lean
 * (the theorems), broker-drift.yml (the experiment), broker-tofu/ (the D3
 * config). Each references the others, and this suite pins the properties
 * whose quiet loss would leave the documents describing a system that no
 * longer exists:
 *
 *   1. the model's assumptions stay NAMED, and no `sorry` wears a theorem's name
 *   2. the monitor's overscope probes stay READ-ONLY — a negative test that
 *      "tries a forbidden write" performs the write when the scope is broad
 *   3. the tofu draft keeps the parent DERIVED from the tiers (D3), keeps its
 *      DRAFT banners, and keeps placeholders rather than real identifiers
 *
 * Lean COMPILATION is lean-specs.yml's job (this suite has no toolchain);
 * what is pinned here is the textual contract the other artifacts rely on.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ── 1. the model ─────────────────────────────────────────────────────────────

test("Delegation.lean names its assumptions and proves its theorems", () => {
  const lean = read("specs/lean/Delegation.lean");
  for (const name of ["C1", "C2"]) {
    assert.ok(lean.includes(`${name} (`), `assumption ${name} must be stated by name`);
  }
  for (const thm of [
    "attainable_le_root",          // D1
    "cannot_widen_from_below",     // D2
    "derived_tiers_never_drift",   // D3
    "independent_definitions_can_drift", // the counterexample D3 answers
    "restrict_never_drifts",
  ]) {
    assert.ok(new RegExp(`theorem ${thm}\\b`).test(lean), `theorem ${thm} must exist`);
  }
  // C1's truth is genuinely unresolved (R4's wording vs the observed 9109) and
  // the file must keep saying so — a model that quietly upgrades an assumption
  // to a fact is the failure A1/A2 naming exists to prevent.
  assert.match(lean, /UNRESOLVED/, "C1's uncertainty must be stated, not smoothed over");
  assert.match(lean, /broker-drift/, "and the monitor that decides it must be named");
});

test("no sorry hides in the model's statements", () => {
  // lean-specs.yml enforces this in CI with comment-stripping; the cheap
  // version here fails fast locally. Delegation.lean has no legitimate use of
  // the word even in prose, so no stripping is needed for THIS file.
  assert.ok(!/\bsorry\b/.test(read("specs/lean/Delegation.lean")), "sorry found");
});

// ── 2. the monitor ───────────────────────────────────────────────────────────

function step(wf: string, nameStartsWith: string): string {
  const from = wf.indexOf(`      - name: ${nameStartsWith}`);
  assert.notEqual(from, -1, `step "${nameStartsWith}" must exist`);
  const to = wf.indexOf("\n      - name: ", from + 1);
  return wf.slice(from, to === -1 ? undefined : to);
}

test("overscope probes are read-only, by construction", () => {
  // The probe asks a minted token for authority it must not have. Done with a
  // write, the probe IS the incident whenever the answer is "it has it". So:
  // in the probe step, every curl must be method-less (GET) — no -X anything.
  const probes = step(read(".github/workflows/broker-drift.yml"), "Overscope probes");
  assert.ok(probes.includes("curl"), "the probe step must actually probe");
  assert.doesNotMatch(probes, /-X\s+(POST|PUT|PATCH|DELETE)/, "probes must never mutate");
  assert.match(probes, /refusal is the pass/i, "and must state the inverted pass condition");
});

test("the probe suite proves its token works before trusting refusals", () => {
  // A dead token 403s everything; a probe suite without an in-scope control
  // reads that as "no overscope anywhere" — a green made of broken equipment,
  // the claim-race lesson in miniature.
  const probes = step(read(".github/workflows/broker-drift.yml"), "Overscope probes");
  assert.match(probes, /IN-SCOPE control/i, "must include a positive control");
});

test("every mint failure mode maps to a distinct, named fix", () => {
  // Red must say WHICH fix — 401 allowlist, 404 route, 502+9109 drift. A
  // monitor whose red needs archaeology decays into an ignored monitor.
  const mint = step(read(".github/workflows/broker-drift.yml"), "Mint each tier");
  assert.match(mint, /401\|403\)/, "must classify allowlist failures");
  assert.match(mint, /404\)/, "must classify route failures");
  assert.match(mint, /9109/, "must classify parent-scope drift");
  // And the diagnosis must survive: -f discards error bodies (learned live).
  assert.doesNotMatch(mint, /curl -f\S* .*-X POST/, "mint calls must not use curl -f");
});

// ── 3. the tofu draft ────────────────────────────────────────────────────────

const TOFU_DIR = "proposals/infra/broker-tofu";

test("the parent's scopes are DERIVED from the tiers, never listed (D3)", () => {
  const scopes = read(`${TOFU_DIR}/scopes.tf`);
  assert.match(
    scopes,
    /parent_permission_groups\s*=\s*distinct\(flatten\(values\(local\.tiers\)\)\)/,
    "the derivation IS the design — a literal list reintroduces the second source of truth",
  );
  assert.match(scopes, /workers_deploy/, "the tier whose absence caused the 9109 must exist");
});

test("every tofu file carries the DRAFT banner", () => {
  for (const f of readdirSync(new URL(`../${TOFU_DIR}`, import.meta.url))) {
    if (!f.endsWith(".tf")) continue;
    const first = read(`${TOFU_DIR}/${f}`).split("\n")[0];
    assert.match(first, /DRAFT/, `${f} must open with the DRAFT banner`);
    assert.match(first, /NOT applied/, `${f} must say it is not applied from here`);
  }
});

test("the draft holds placeholders, not live identifiers", () => {
  const versions = read(`${TOFU_DIR}/versions.tf`);
  assert.match(versions, /<R2_STATE_BUCKET>/, "bucket must be a placeholder");
  assert.match(versions, /<ACCOUNT_ID>/, "account id must be a placeholder");
  // The state-is-credential-storage warning must survive edits: it is the
  // difference between an IaC refactor and a credential leak with extra YAML.
  assert.match(versions, /STATE CONTAINS TOKEN VALUES/, "the state warning must survive");
});

test("tofu manages standing config only — derived outputs stay with workflows", () => {
  const github = read(`${TOFU_DIR}/github.tf`);
  assert.ok(!github.includes('"FDS_CLAIM_ENDPOINT"'),
    "FDS_CLAIM_ENDPOINT is an output of lease-deploy, not standing config; " +
    "managing it here would put a value tofu cannot know into state");
  assert.match(github, /github_repository_environment.*lease_deploy/s,
    "the reviewer gate lease-deploy asserts must be managed here");
});

// ── the map itself ───────────────────────────────────────────────────────────

test("the map names the invariants and draws the chain", () => {
  const doc = read("docs/credential-chain.md");
  assert.match(doc, /```mermaid/, "the literal map must be a rendered diagram");
  for (const id of ["D1", "D2", "D3", "C1", "C2"]) {
    assert.ok(doc.includes(`**${id}**`), `invariant ${id} must appear in the table`);
  }
  assert.match(doc, /No arrow points up/, "the one-way property is the design and must be stated");
});
