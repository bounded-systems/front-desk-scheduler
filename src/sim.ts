/**
 * @module sim
 * Deterministic-simulation (DST) engine.
 *
 * A seeded PRNG drives a fake clock and an interleaver. Every agent runs a
 * micro-step machine that DELIBERATELY separates "decide" from "commit"
 * (idle→claiming→gating→spending→completing). Because those are distinct
 * micro-steps, the interleaver can run agent B's decide between agent A's decide
 * and A's commit — which is exactly how real concurrency exposes check-then-act
 * races. `assertInvariants` runs after every micro-step; a violation returns the
 * seed + the exact trace, so any race is reproducible and minimizable.
 *
 * No Math.random / Date.now — the seed fully determines the run.
 */

import { cloneWorld, itemById, type World } from "./contract.ts";
import { assertInvariants, allDone, type InvariantReport } from "./invariants.ts";
import { applySpend, commitClaim, complete, type OpMode } from "./ops.ts";
import { gateFor, nextPick } from "./scheduler.ts";

/** mulberry32 — tiny deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StepPhase = "idle" | "claiming" | "gating" | "spending" | "completing";

interface AgentStep {
  phase: StepPhase;
  target: number | null;
  points: number;
  gateAllowed: boolean;
}

export interface SimOptions {
  readonly seed: number;
  readonly mode: OpMode;
  readonly maxSteps?: number;
  readonly stopOnViolation?: boolean;
}

export interface SimViolation {
  readonly step: number;
  readonly report: InvariantReport;
}

export interface SimResult {
  readonly seed: number;
  readonly mode: OpMode;
  readonly steps: number;
  readonly finished: boolean;
  readonly consumed: number;
  readonly violation: SimViolation | null;
  readonly trace: string[];
}

export function runSim(world0: World, opts: SimOptions): SimResult {
  const w = cloneWorld(world0);
  const rnd = mulberry32(opts.seed);
  const maxSteps = opts.maxSteps ?? 2000;
  const stopOnViolation = opts.stopOnViolation ?? true;

  const steps = new Map<string, AgentStep>();
  for (const a of w.agents) {
    steps.set(a.id, { phase: "idle", target: null, points: 0, gateAllowed: false });
    a.phase = "Idle";
    a.currentItem = null;
  }

  const trace: string[] = [];
  let firstViolation: SimViolation | null = null;

  const actionable = (): string[] =>
    w.agents
      .filter((a) => {
        const s = steps.get(a.id)!;
        if (s.phase !== "idle") return true;
        return nextPick(w) !== null; // idle only actionable if there's a pick
      })
      .map((a) => a.id);

  let n = 0;
  for (; n < maxSteps; n++) {
    const ready = actionable();
    if (ready.length === 0) break; // done or stuck

    const agentId = ready[Math.floor(rnd() * ready.length)];
    const s = steps.get(agentId)!;
    const agent = w.agents.find((a) => a.id === agentId)!;

    switch (s.phase) {
      case "idle": {
        const pick = nextPick(w);
        if (pick === null) {
          break;
        }
        // DECIDE only — do not mutate the item yet (this is the race window).
        s.target = pick;
        s.phase = "claiming";
        agent.phase = "Claiming";
        trace.push(`${agentId}: decide claim #${pick}`);
        break;
      }
      case "claiming": {
        const r = commitClaim(w, agentId, s.target!, opts.mode);
        trace.push(`${agentId}: commit claim #${s.target} → ${r.won ? "WON" : "lost"} (${r.reason})`);
        s.phase = r.won ? "gating" : "idle";
        if (!r.won) s.target = null;
        break;
      }
      case "gating": {
        const item = itemById(w, s.target!)!;
        s.points = Math.max(item.effort, 1);
        s.gateAllowed = gateFor(w, s.points).allow; // READ against current consumed
        s.phase = "spending";
        trace.push(`${agentId}: gate spend ${s.points} (consumed=${w.budget.consumed}) → ${s.gateAllowed ? "allow" : "deny"}`);
        break;
      }
      case "spending": {
        const r = applySpend(w, s.points, s.gateAllowed, opts.mode);
        trace.push(`${agentId}: apply spend ${s.points} → ${r.applied ? "APPLIED" : "no"} (${r.reason}) consumed=${w.budget.consumed}`);
        if (r.applied) {
          s.phase = "completing";
        } else if (opts.mode === "safe") {
          // safe & denied: release the claim so the item can be retried later.
          const item = itemById(w, s.target!)!;
          item.phase = "Ready";
          item.ownerId = null;
          agent.currentItem = null;
          agent.phase = "Idle";
          s.phase = "idle";
          s.target = null;
        } else {
          s.phase = "completing";
        }
        break;
      }
      case "completing": {
        const r = complete(w, agentId, opts.mode);
        trace.push(`${agentId}: complete #${s.target}${r.woken.length ? ` (woke ${r.woken.map((x) => "#" + x).join(",")})` : ""}`);
        s.phase = "idle";
        s.target = null;
        break;
      }
    }

    const report = assertInvariants(w);
    if (!report.valid && firstViolation === null) {
      firstViolation = { step: n, report };
      trace.push(`!! INVARIANT VIOLATION at step ${n}: ${report.findings.map((f) => f.id).join(", ")}`);
      if (stopOnViolation) {
        n++;
        break;
      }
    }
  }

  return {
    seed: opts.seed,
    mode: opts.mode,
    steps: n,
    finished: allDone(w),
    consumed: w.budget.consumed,
    violation: firstViolation,
    trace,
  };
}

/**
 * Sweep seeds; return the first violating result, or null if all clean.
 * If `wantId` is given, only match violations whose report contains that
 * invariant id (e.g. "S2") — lets a test target one specific race.
 */
export function findViolatingSeed(
  world0: World,
  mode: OpMode,
  seeds: number,
  wantId?: string,
  maxSteps = 2000,
): SimResult | null {
  for (let seed = 1; seed <= seeds; seed++) {
    const r = runSim(world0, { seed, mode, maxSteps, stopOnViolation: true });
    if (r.violation && (!wantId || r.violation.report.findings.some((f) => f.id === wantId))) {
      return r;
    }
  }
  return null;
}
