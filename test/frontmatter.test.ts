/** The frontmatter parse seam: enum-forced, findings not coercion. */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseFrontMatter } from "../src/frontmatter.ts";

test("valid frontmatter parses fully", () => {
  const r = parseFrontMatter(
    "---\nkind: task\neffort: 3\nvalue: 70\ndepends-on: [prx#119, gh-project-room#83]\n---\n\nBody text.",
  );
  assert.equal(r.present, true);
  assert.deepEqual(r.findings, []);
  assert.equal(r.fm.kind, "task");
  assert.equal(r.fm.effort, 3);
  assert.equal(r.fm.value, 70);
  assert.deepEqual(r.fm.dependsOn, [
    { repo: "prx", number: 119 },
    { repo: "gh-project-room", number: 83 },
  ]);
});

test("invalid enum/range values become findings, never coerced", () => {
  const r = parseFrontMatter("---\nkind: sprint\neffort: 99\nvalue: -5\ndepends-on: [#12]\n---\n");
  assert.equal(r.present, true);
  assert.equal(r.fm.kind, undefined);
  assert.equal(r.fm.effort, undefined);
  assert.equal(r.fm.value, undefined);
  assert.deepEqual(r.fm.dependsOn, []);
  assert.equal(r.findings.length, 4, JSON.stringify(r.findings));
});

test("no frontmatter block ⇒ absent, empty, no findings", () => {
  const r = parseFrontMatter("Just a normal issue body.\n\n- with lists\n");
  assert.equal(r.present, false);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.fm.dependsOn, []);
});

test("unknown keys and comments are ignored (frontmatter may serve other tools)", () => {
  const r = parseFrontMatter("---\ntitle: something else\nkind: door # a capability\n---\n");
  assert.equal(r.fm.kind, "door");
  assert.deepEqual(r.findings, []);
});

// ── the issue templates carry a valid contract block ─────────────────────────
// GitHub strips a .md template's OWN metadata block (name/about) and the rest
// becomes the issue body — so the scheduler's contract block must be the FIRST
// block of that remainder. These tests simulate exactly that stripping, so a
// template edit that breaks the contract (bad enum, moved block, range slip)
// fails here instead of silently producing untriaged issues.

import { readFileSync } from "node:fs";

/** What GitHub does to a markdown issue template: drop its leading metadata block. */
function templateBody(file: string): string {
  const raw = readFileSync(new URL(`../.github/ISSUE_TEMPLATE/${file}`, import.meta.url), "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw);
  assert.ok(m, `${file}: template must open with GitHub's metadata block`);
  return raw.slice(m[0].length);
}

test("task template body parses: declared kind/effort/value, empty deps, zero findings", () => {
  const r = parseFrontMatter(templateBody("task.md"));
  assert.equal(r.present, true, "the contract block must survive GitHub's metadata stripping");
  assert.equal(r.fm.kind, "task");
  assert.equal(r.fm.effort, 3);
  assert.equal(r.fm.value, 40);
  assert.deepEqual(r.fm.dependsOn, []);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test("epic template body parses: declared kind/effort/value, empty deps, zero findings", () => {
  const r = parseFrontMatter(templateBody("epic.md"));
  assert.equal(r.present, true);
  assert.equal(r.fm.kind, "epic");
  assert.equal(r.fm.effort, 8);
  assert.equal(r.fm.value, 60);
  assert.deepEqual(r.fm.dependsOn, []);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});
