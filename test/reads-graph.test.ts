/**
 * The reads seam's STATIC import graph, asserted as a property.
 *
 * `reads.ts` must stay loadable without the node-only adapters: `mirror.ts`
 * reaches `node:child_process`, `board.ts` and the GitHub CLI path; and
 * `dolt-server.ts` pulls `mysql2`. Neither can run on a Cloudflare Worker, and
 * neither is needed by the DoltHub adapter — the zero-infra default, and the
 * only plane a cloud session can reach.
 *
 * This is a source assertion rather than a behavioural one because the failure
 * it guards is invisible at runtime: adding `import { X } from "./mirror.ts"`
 * back to the top of reads.ts breaks nothing here, passes every other test, and
 * is only discovered later by a bundler. Locking the shape is the only way the
 * regression shows up where it was introduced.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const read = (mod: string): string =>
  readFileSync(new URL(`../src/${mod}`, import.meta.url), "utf8");

/** `import ... from "x"` / `export ... from "x"`, but NOT `import("x")`. */
const staticallyImports = (src: string, spec: string): boolean =>
  new RegExp(
    `^\\s*(?:import|export)\\s(?!\\s*\\()[^;]*?from\\s*["']${spec.replace(".", "\\.")}["']`,
    "m",
  ).test(src);

test("reads.ts does not statically import the node-only adapters", () => {
  const src = read("reads.ts");
  assert.equal(
    staticallyImports(src, "./mirror.ts"),
    false,
    "reads.ts must load mirror.ts on demand — a static import drags node:child_process and the gh path into every DoltHub read",
  );
  assert.equal(
    staticallyImports(src, "./dolt-server.ts"),
    false,
    "reads.ts must load dolt-server.ts on demand — a static import drags mysql2 in, which cannot run on a Worker",
  );
});

test("reads.ts still reaches both adapters dynamically", () => {
  const src = read("reads.ts");
  // The point is deferral, not removal: dropping the adapters entirely would
  // also satisfy the assertion above while silently losing two planes.
  assert.match(src, /import\(\s*["']\.\/mirror\.ts["']\s*\)/, "local plane must still be reachable");
  assert.match(src, /import\(\s*["']\.\/dolt-server\.ts["']\s*\)/, "server plane must still be reachable");
});

test("reads.ts imports nothing from node:", () => {
  // The whole point of moving `resolveReads` to reads-resolve.ts. If a `node:`
  // import comes back here, the seam stops being portable and every consumer
  // of verbs.ts inherits it again.
  assert.doesNotMatch(
    read("reads.ts"),
    /^\s*import\s[^;]*?from\s*["']node:/m,
    "reads.ts must stay runtime-portable — node-only detection lives in reads-resolve.ts",
  );
});

test("verbs.ts does not statically import the node-only environment sniffing", () => {
  const src = read("verbs.ts");
  assert.equal(
    staticallyImports(src, "./reads-resolve.ts"),
    false,
    "verbs.ts must ask for `currentReads()`; WHICH plane to use is the entrypoint's call, not the verb's",
  );
  assert.equal(
    staticallyImports(src, "./board.ts"),
    false,
    "verbs.ts needs only statusToState — import it from status.ts, not the module that shells out to gh",
  );
  assert.doesNotMatch(
    src,
    /^\s*import\s[^;]*?from\s*["']node:/m,
    "verbs.ts must not import node: directly",
  );
});

test("mirror-dir.ts stays free of imports", () => {
  // It exists solely so reads.ts can learn the clone path without loading
  // mirror.ts. An import here would hand back the dependency it removed.
  const src = read("mirror-dir.ts");
  assert.doesNotMatch(
    src.replace(/\/\*[\s\S]*?\*\//g, ""),
    /^\s*(?:import|export)\s[^;]*?from\s/m,
    "mirror-dir.ts must import nothing — it is the constant, not the module",
  );
});
