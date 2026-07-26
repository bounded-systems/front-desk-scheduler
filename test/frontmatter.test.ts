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
