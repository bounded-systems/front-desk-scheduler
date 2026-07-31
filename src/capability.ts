/**
 * @module capability
 * Can the caller DO this item, as distinct from should it be ranked highly?
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `next` ranks by WSJF value-density and reports a budget verdict (`fits`). Both
 * are properties of the ITEM. Neither asks whether the actor holding the answer
 * can carry it out.
 *
 * That gap cost a full session on 2026-07-31 (#86). `next` ranked front-desk#58
 * first — score 51.95, `fits ✔`, correctly ranked and genuinely valuable. Its
 * work is `npm run board:parity`, which shells out to `gh`. A Claude Code cloud
 * session has no `gh` binary, and its ambient `GH_TOKEN` is the proxy-local
 * sentinel, not a credential valid against api.github.com. Discovering that took
 * reading the issue, then the script, then testing for the binary — and the same
 * dead end waited on .github#68.
 *
 * ── A filter, not a re-ranking ───────────────────────────────────────────────
 * #58's rank is CORRECT. It is effort-1, and both #60 and #62 are sized off the
 * number it produces. It simply belongs to a different actor. So this never
 * reorders the queue and never changes a score: it partitions one ranking into
 * "yours" and "someone else's", each still in rank order. Two lists, not one
 * reordered list — the shape #86 asked for, and the reason `score` is untouched
 * by anything in this module.
 *
 * ── Where the requirement comes from ─────────────────────────────────────────
 * Author-declared, in the same issue-body frontmatter that already carries
 * kind/effort/value/depends-on:
 *
 *   ---
 *   kind: task
 *   needs: [gh, github-api]
 *   ---
 *
 * One source of truth, on the same path as every other scheduling field: parsed
 * at sync, stored as an `items` column, read through the same seam. The
 * alternative #86 floated — deriving requirements from what an issue's
 * referenced scripts actually invoke — is strictly better information and
 * strictly harder to get right; it is not foreclosed by this, because a derived
 * value can populate the same column later without moving the predicate.
 *
 * ── Fail OPEN, deliberately ──────────────────────────────────────────────────
 * An item that declares nothing is executable by everyone. The undeclared state
 * is the overwhelming majority (28/228 ready items lacked even effort/value when
 * #86 was written), so failing closed would empty the queue and teach callers to
 * ignore the field. A missing declaration means "unknown", and unknown must not
 * masquerade as "blocked" — the same distinction `claim-ticket-summary.ts` keeps
 * between a refusal and an error.
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * The closed vocabulary of things an item can require.
 *
 * Closed on purpose, following this repo's machine-schema discipline: an
 * unrecognised token is REJECTED into a frontmatter finding rather than silently
 * carried, because a typo'd requirement that no actor can ever hold would
 * quietly remove an item from every queue.
 */
export const CAPABILITIES = ["gh", "github-api", "dolt", "deno"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(s: string): s is Capability {
  return (CAPABILITIES as readonly string[]).includes(s);
}

/**
 * The GH_TOKEN a Claude Code cloud session carries.
 *
 * Not a credential — a literal sentinel. The real one is injected at the egress
 * proxy for GitHub hosts only, so the variable is SET (and so a bare
 * `if (GH_TOKEN)` reads as authenticated) while presenting it to api.github.com
 * fails. Verified against the deployed lease Worker on 2026-07-31: a POST
 * carrying it returned 403 — "neither a valid user token nor an installation
 * token". See docs/claiming-from-a-session.md.
 */
export const PROXY_TOKEN_SENTINEL = "proxy-injected";

/**
 * Why the sentinel is not a credential, as shown to a caller.
 *
 * Exported as a constant so tests can pin the whole message by identity rather
 * than fishing for `api.github.com` inside it. Asserting on that substring is
 * what CodeQL's incomplete-URL-sanitization rule exists to catch — the rule is
 * heuristic here, since nothing validates a URL, but a test that pins the exact
 * contract is both stronger and unambiguous.
 */
export const SENTINEL_REASON =
  `GH_TOKEN is the '${PROXY_TOKEN_SENTINEL}' sentinel — proxy-local, invalid against api.github.com`;

/** What the caller holds, and why — the "why" is what makes a refusal actionable. */
export interface ActorCapabilities {
  readonly held: ReadonlySet<Capability>;
  /** Per-capability explanation, present for held and absent alike. */
  readonly because: ReadonlyMap<Capability, string>;
}

/** Injected so the probe is testable without a filesystem or a real environment. */
export interface ProbeEnv {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hasBinary: (name: string) => boolean;
}

/**
 * Is there a live GitHub credential — one that would actually authenticate?
 *
 * Deliberately distinguishes "set" from "usable". The sentinel is the case that
 * matters: it is set, it is non-empty, and it does not work.
 */
export function githubCredential(env: ProbeEnv["env"]): { ok: boolean; because: string } {
  const raw = (env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  if (!raw) return { ok: false, because: "GH_TOKEN/GITHUB_TOKEN unset" };
  if (raw === PROXY_TOKEN_SENTINEL) return { ok: false, because: SENTINEL_REASON };
  return { ok: true, because: "a GitHub token is present" };
}

/** What this actor can do. */
export function probeActor(probe: ProbeEnv): ActorCapabilities {
  const held = new Set<Capability>();
  const because = new Map<Capability, string>();

  for (const bin of ["gh", "dolt", "deno"] as const) {
    if (probe.hasBinary(bin)) {
      held.add(bin);
      because.set(bin, `\`${bin}\` is on PATH`);
    } else {
      because.set(bin, `no \`${bin}\` binary on PATH`);
    }
  }

  const cred = githubCredential(probe.env);
  if (cred.ok) held.add("github-api");
  because.set("github-api", cred.because);

  return { held, because };
}

/**
 * What this item needs that the actor lacks. Empty ⇒ the actor can execute it.
 *
 * Unknown tokens are ignored rather than treated as missing: they are rejected
 * at the frontmatter seam with a finding, and double-punishing them here would
 * hide an item behind a requirement nobody can ever satisfy.
 */
export function missingFor(needs: readonly string[], actor: ActorCapabilities): Capability[] {
  return needs.filter((n): n is Capability => isCapability(n) && !actor.held.has(n));
}

export function isExecutableBy(needs: readonly string[], actor: ActorCapabilities): boolean {
  return missingFor(needs, actor).length === 0;
}

/** One line per missing capability, saying what is absent and why it matters. */
export function explainMissing(missing: readonly Capability[], actor: ActorCapabilities): string[] {
  return missing.map((c) => `${c}: ${actor.because.get(c) ?? "not held"}`);
}

/**
 * Is `name` an executable on PATH?
 *
 * Resolved by inspecting PATH rather than spawning the binary. Spawning to ask
 * "does this exist" is how the claim path used to die on `spawn dolt ENOENT` in
 * a cloud session — and a probe that runs on every `next` must not pay a process
 * per capability, nor fail differently depending on whether the binary happens
 * to accept `--version`.
 */
export function binaryOnPath(name: string, env: ProbeEnv["env"] = process.env): boolean {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        accessSync(join(dir, name + ext), constants.X_OK);
        return true;
      } catch {
        // not here, or not executable — keep looking
      }
    }
  }
  return false;
}

/** The real actor: this process's environment and PATH. */
export function currentActor(env: ProbeEnv["env"] = process.env): ActorCapabilities {
  return probeActor({ env, hasBinary: (n) => binaryOnPath(n, env) });
}
