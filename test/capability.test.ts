// Tests for the capability predicate (#86 item 1).
//
// The failure this exists to prevent, in one sentence: on 2026-07-31 `next`
// handed a cloud session front-desk#58 as its pick, and #58's work shells out to
// `gh`, which that session does not have. The rank was RIGHT — #58 is effort-1
// and two other items are sized off the number it produces. It belonged to a
// different actor.
//
// So the properties under test are two-sided. The partition must route items to
// the actor that can do them, AND it must not disturb the ranking while doing
// it: same scores, same order, nothing dropped.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITIES,
  isCapability,
  githubCredential,
  missingFor,
  isExecutableBy,
  probeActor,
  PROXY_TOKEN_SENTINEL,
  SENTINEL_REASON,
  resolveBinary,
  PROVISIONED_BIN_DIRS,
} from "../src/capability.ts";
import { parseFrontMatter } from "../src/frontmatter.ts";
import type { RawTypedEdge, SchedulingItem } from "../src/scheduling.ts";
import { nextVerb } from "../src/verbs.ts";
import type { SchedulerReads } from "../src/reads.ts";
import { ROLLING_5H_BUDGET } from "../src/policy.ts";

// ── actors ───────────────────────────────────────────────────────────────────

const actorWith = (bins: string[], env: Record<string, string | undefined> = {}) =>
  probeActor({
    env,
    resolveBinary: (n) => (bins.includes(n) ? { path: `/usr/bin/${n}`, onPath: true } : null),
  });

/** A Claude Code cloud session, as measured on 2026-07-31. */
const CLOUD_SESSION = actorWith(["deno"], { GH_TOKEN: PROXY_TOKEN_SENTINEL });
/** A laptop with the usual tooling and a real token. */
const LAPTOP = actorWith(["gh", "dolt", "deno"], { GH_TOKEN: "ghp_realtokenvalue" });

// ── the credential distinction that started all this ─────────────────────────

test("the proxy sentinel is NOT a credential, though it is set and non-empty", () => {
  // The whole trap: `if (GH_TOKEN)` reads as authenticated. It isn't.
  const sentinel = githubCredential({ GH_TOKEN: PROXY_TOKEN_SENTINEL });
  assert.equal(sentinel.ok, false);
  // Pinned by identity against the exported constant rather than by searching
  // the message for a hostname. Both earlier spellings — an unanchored
  // /api\.github\.com/ regex, then .includes("api.github.com") — tripped CodeQL's
  // unanchored-regex and incomplete-URL-sanitization rules. Those rules are
  // heuristic here (this is a diagnostic string, not a URL check), but they are
  // right that a hostname substring test is the wrong shape, and the constant
  // pins the whole contract instead of one fragment of it.
  assert.equal(sentinel.because, SENTINEL_REASON);

  assert.equal(githubCredential({ GH_TOKEN: "ghp_x" }).ok, true);
  assert.equal(githubCredential({}).ok, false);
  assert.equal(githubCredential({ GH_TOKEN: "  " }).ok, false, "whitespace is not a token");
  assert.equal(githubCredential({ GITHUB_TOKEN: "ghp_x" }).ok, true, "GITHUB_TOKEN also counts");
});

test("a cloud session holds deno, and neither gh nor a usable GitHub credential", () => {
  assert.deepEqual([...CLOUD_SESSION.held].sort(), ["deno"]);
  assert.match(CLOUD_SESSION.because.get("gh") ?? "", /no `gh` binary/);
  assert.match(CLOUD_SESSION.because.get("github-api") ?? "", /sentinel/);
});

test("a laptop holds everything", () => {
  assert.deepEqual([...LAPTOP.held].sort(), [...CAPABILITIES].sort());
});

// ── fail OPEN ────────────────────────────────────────────────────────────────

test("an item that declares nothing is executable by everyone", () => {
  // The undeclared state is the overwhelming majority. Failing closed would
  // empty the queue on day one and teach every caller to ignore the field.
  assert.equal(isExecutableBy([], CLOUD_SESSION), true);
  assert.deepEqual(missingFor([], CLOUD_SESSION), []);
});

test("an unrecognised token does not hide an item behind an unsatisfiable need", () => {
  // Rejected at the frontmatter seam with a finding; double-punishing it here
  // would remove the item from every actor's queue forever.
  assert.deepEqual(missingFor(["kubernetes"], CLOUD_SESSION), []);
  assert.equal(isExecutableBy(["kubernetes"], CLOUD_SESSION), true);
});

test("only the capabilities actually absent are reported missing", () => {
  assert.deepEqual(missingFor(["gh", "deno"], CLOUD_SESSION), ["gh"]);
  assert.deepEqual(missingFor(["gh", "github-api"], CLOUD_SESSION), ["gh", "github-api"]);
  assert.deepEqual(missingFor(["gh", "github-api"], LAPTOP), []);
});

test("resolveBinary finds a real binary and refuses an invented one", () => {
  // node is running this test, so it is on PATH by construction.
  const node = resolveBinary("node");
  assert.ok(node, "node resolves");
  assert.equal(node.onPath, true);
  assert.equal(resolveBinary("definitely-not-a-real-binary-8f3a"), null);
  assert.equal(resolveBinary("node", { PATH: "" }), null, "an empty environment finds nothing");
});

// ── #160: the probe process's PATH is not the actor's ────────────────────────
//
// Observed 2026-08-06: the MCP server reported `missing: [deno]` / "no `deno`
// binary on PATH" while the same session's shell had deno 2.9.4 at
// $HOME/.deno/bin/deno. session-start.sh puts it there and prepends it to the
// SHELL's PATH via $CLAUDE_ENV_FILE; a harness-spawned process never sees that.
//
// The fixture is a fake $HOME rather than the real one, so the test asserts the
// SEARCH RULE and not whatever happens to be installed on the runner.

/** A $HOME with an executable at one of the provisioned locations. */
function homeWithProvisioned(name: string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "fds-cap-"));
  const dir = join(home, PROVISIONED_BIN_DIRS[0]);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return { home, path };
}

test("a hook-provisioned binary is found even when it is not on PATH (#160)", () => {
  const { home, path } = homeWithProvisioned("deno");
  try {
    const found = resolveBinary("deno", { PATH: "", HOME: home });
    assert.ok(found, "deno resolves out of ~/.deno/bin with an empty PATH");
    assert.equal(found.path, path);
    assert.equal(found.onPath, false, "found, but this process could not spawn it bare");

    // The whole point: the actor HOLDS it. Before #160 this asserted `false`.
    const actor = probeActor({
      env: { PATH: "", HOME: home },
      resolveBinary: (n) => resolveBinary(n, { PATH: "", HOME: home }),
    });
    assert.equal(actor.held.has("deno"), true);
    assert.equal(isExecutableBy(["deno"], actor), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the reason names where a provisioned binary was found, and that it is not on PATH", () => {
  const { home, path } = homeWithProvisioned("deno");
  try {
    const env = { PATH: "", HOME: home };
    const actor = probeActor({ env, resolveBinary: (n) => resolveBinary(n, env) });

    // A caller that shells out from THIS process still needs the distinction,
    // so "held" must not read the same as "on PATH".
    const why = actor.because.get("deno") ?? "";
    assert.ok(why.includes(path), `reason should name the path, got: ${why}`);
    assert.ok(why.includes("not on this process's PATH"), `reason should flag the gap, got: ${why}`);

    // And an absent one says where it looked, so the next reader does not have
    // to guess whether the provisioned dirs were searched at all.
    const missing = actor.because.get("gh") ?? "";
    assert.ok(missing.includes("~/.deno/bin"), `absence should name the search, got: ${missing}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("PATH wins: a binary genuinely on PATH is never reported as merely provisioned", () => {
  const { home, path } = homeWithProvisioned("deno");
  try {
    const found = resolveBinary("deno", { PATH: join(home, PROVISIONED_BIN_DIRS[0]), HOME: home });
    assert.ok(found);
    assert.equal(found.path, path);
    assert.equal(found.onPath, true, "same file, but this shell DID inherit the hook's export");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("without $HOME the provisioned dirs are not searched", () => {
  // Keeps the probe injectable — a test that passes no HOME must not fall
  // through to the runner's real one and pick up whatever is installed there.
  const { home } = homeWithProvisioned("deno");
  try {
    assert.equal(resolveBinary("deno", { PATH: "" }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the vocabulary is closed", () => {
  for (const c of CAPABILITIES) assert.equal(isCapability(c), true);
  assert.equal(isCapability("gh "), false);
  assert.equal(isCapability("GH"), false);
});

// ── declaring it: frontmatter ────────────────────────────────────────────────

test("needs parses as an inline list and as a scalar", () => {
  assert.deepEqual(parseFrontMatter("---\nneeds: [gh, github-api]\n---\n").fm.needs, ["gh", "github-api"]);
  assert.deepEqual(parseFrontMatter("---\nneeds: gh\n---\n").fm.needs, ["gh"]);
  assert.deepEqual(parseFrontMatter("---\nkind: task\n---\n").fm.needs, [], "absent ⇒ empty, not undefined");
  assert.deepEqual(parseFrontMatter("no frontmatter here").fm.needs, []);
});

test("an unknown capability becomes a finding rather than being carried", () => {
  const r = parseFrontMatter("---\nneeds: [gh, kubernetes]\n---\n");
  assert.deepEqual(r.fm.needs, ["gh"]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].key, "needs");
  assert.match(r.findings[0].message, /kubernetes/);
});

test("a repeated capability is declared once", () => {
  assert.deepEqual(parseFrontMatter("---\nneeds: [gh, gh]\n---\n").fm.needs, ["gh"]);
});

test("needs is independent of depends-on", () => {
  // What must be DONE first vs what the actor must HOLD. #86's finding is that
  // an item with zero open blockers can still be undoable by its caller.
  const r = parseFrontMatter("---\ndepends-on: [prx#1]\nneeds: [gh]\n---\n");
  assert.deepEqual(r.fm.needs, ["gh"]);
  assert.deepEqual(r.fm.dependsOn, [{ repo: "prx", number: 1 }]);
});

// ── the partition in `next` ──────────────────────────────────────────────────

type NextInput = Parameters<typeof nextVerb.run>[0];
const input = (over: Partial<NextInput> = {}): NextInput => ({
  budget: ROLLING_5H_BUDGET.id,
  top: 10,
  consumed: 0,
  ...over,
});

function item(over: Partial<SchedulingItem> & { id: string; number: number }): SchedulingItem {
  return {
    id: over.id,
    number: over.number,
    title: over.title ?? `item ${over.number}`,
    repository: over.repository ?? "front-desk-scheduler",
    status: over.status ?? "Todo",
    kind: over.kind ?? "task",
    effort: over.effort ?? 1,
    value: over.value ?? 50,
    dependsOn: over.dependsOn ?? [],
    needs: over.needs ?? [],
    openBlockers: over.openBlockers ?? 0,
    unblocks: over.unblocks ?? 0,
    ageDays: over.ageDays ?? 0,
    leased: over.leased ?? false,
  };
}

const mockReads = (items: SchedulingItem[]): SchedulerReads => ({
  source: "server",
  readScheduling: async () => ({ items, at: "v0110csl2jph0aeeij7rhhurrbjcft6g" }),
  readTypedEdges: async () => [] as RawTypedEdge[],
  readAllItems: async () => ({ items: [], at: null }),
  meta: async () => ({ syncedAt: "2026-07-31T00:00:00Z", commit: "abc", source: "server" }),
});

/** The 2026-07-31 board shape: the top-ranked item needs `gh`. */
const BOARD = [
  item({ id: "i58", number: 58, effort: 1, value: 90, needs: ["gh"] }), // ranks first
  item({ id: "i60", number: 60, effort: 3, value: 55 }),
  item({ id: "i62", number: 62, effort: 5, value: 40 }),
];

test("the top-ranked item that the caller cannot execute is NOT the pick", async () => {
  const out = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: CLOUD_SESSION });
  assert.equal(out.pick?.number, 60, "pick is the top item this actor can actually do");
  assert.ok(!out.queue.some((q) => q.number === 58), "58 is not in the caller's queue");
});

test("...but it keeps its rank and its score in the other list", async () => {
  const out = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: CLOUD_SESSION });
  const other = out.otherActors.find((q) => q.number === 58);
  assert.ok(other, "58 is surfaced, not dropped — someone else can do it");
  assert.deepEqual(other.missing, ["gh"]);
  assert.deepEqual(other.needs, ["gh"]);

  // A filter, not a re-ranking: the score is whatever it was.
  const asLaptop = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: LAPTOP });
  assert.equal(other.score, asLaptop.queue.find((q) => q.number === 58)?.score);
});

test("the same board gives the laptop a different pick — same ranking, different actor", async () => {
  const out = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: LAPTOP });
  assert.equal(out.pick?.number, 58, "an actor holding gh gets the genuinely top item");
  assert.deepEqual(out.otherActors, [], "nothing is out of reach");
  assert.equal(out.executable, out.eligible);
});

test("nothing is lost: the two lists partition the ranking exactly", async () => {
  const out = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: CLOUD_SESSION });
  const seen = [...out.queue, ...out.otherActors].map((q) => q.number).sort();
  assert.deepEqual(seen, [58, 60, 62]);
  assert.equal(out.eligible, 3);
  assert.equal(out.executable, 2);
});

test("both lists stay in descending score order", async () => {
  const board = [
    item({ id: "a", number: 1, effort: 1, value: 90, needs: ["gh"] }),
    item({ id: "b", number: 2, effort: 1, value: 80 }),
    item({ id: "c", number: 3, effort: 1, value: 70, needs: ["gh"] }),
    item({ id: "d", number: 4, effort: 1, value: 60 }),
  ];
  const out = await nextVerb.run(input(), { reads: mockReads(board), actor: CLOUD_SESSION });
  const desc = (xs: { score: number }[]) => xs.every((x, i) => i === 0 || xs[i - 1].score >= x.score);
  assert.ok(desc(out.queue), "executable list is ranked");
  assert.ok(desc(out.otherActors), "other-actor list is ranked");
  assert.deepEqual(out.queue.map((q) => q.number), [2, 4]);
  assert.deepEqual(out.otherActors.map((q) => q.number), [1, 3]);
});

test("when the caller can execute nothing, it says so and says why", async () => {
  const board = [item({ id: "x", number: 9, needs: ["gh", "github-api"] })];
  const out = await nextVerb.run(input(), { reads: mockReads(board), actor: CLOUD_SESSION });
  assert.equal(out.pick, null);
  assert.equal(out.executable, 0);
  assert.equal(out.eligible, 1, "still eligible — it is ready, just not for you");

  const rendered = nextVerb.render?.(out, input()) ?? "";
  assert.match(rendered, /nothing YOU can execute/);
  assert.match(rendered, /no `gh` binary on PATH/);
  assert.match(rendered, /sentinel/, "names the credential trap, not just the capability");
});

test("the renderer shows the other-actor list rather than hiding it", async () => {
  const rendered = nextVerb.render?.(
    await nextVerb.run(input(), { reads: mockReads(BOARD), actor: CLOUD_SESSION }),
    input(),
  ) ?? "";
  assert.match(rendered, /NOT executable by you \(1\)/);
  assert.match(rendered, /#58/);
  assert.match(rendered, /needs gh/);
  assert.match(rendered, /you hold: deno/);
});

test("a board with no declared needs renders exactly as before", async () => {
  // No `needs` anywhere ⇒ no second list, no actor line. The change is invisible
  // until someone declares something, which is the state of the board today.
  const board = [item({ id: "a", number: 1 }), item({ id: "b", number: 2 })];
  const out = await nextVerb.run(input(), { reads: mockReads(board), actor: CLOUD_SESSION });
  assert.deepEqual(out.otherActors, []);
  const rendered = nextVerb.render?.(out, input()) ?? "";
  assert.doesNotMatch(rendered, /NOT executable by you/);
  assert.doesNotMatch(rendered, /yours:/);
});

test("the actor report explains every capability, held or not", async () => {
  const out = await nextVerb.run(input(), { reads: mockReads(BOARD), actor: CLOUD_SESSION });
  assert.deepEqual(out.actor.held, ["deno"]);
  assert.deepEqual(out.actor.missing.sort(), ["dolt", "gh", "github-api"]);
  assert.equal(out.actor.why.length, CAPABILITIES.length, "every capability is accounted for");
  assert.match(out.actor.why.find((w) => w.capability === "github-api")?.reason ?? "", /sentinel/);
});
